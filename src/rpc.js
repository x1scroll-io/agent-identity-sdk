'use strict';
/**
 * RpcRouter — round-robin JSON-RPC routing across x1scroll validator nodes.
 *
 * Fetches active endpoints from /api/registry/nodes, distributes requests
 * evenly, skips failed endpoints for 60s, auto-refreshes every 5 min.
 *
 * Usage:
 *   const router = await createRpcRouter();
 *   const result = await router.call('getSlot', []);
 */

const https = require('https');
const http  = require('http');

const DEFAULT_REGISTRY_URL   = 'https://x1scroll.io/api/registry';
const REFRESH_INTERVAL_MS    = 5 * 60 * 1000;  // 5 minutes
const SKIP_DURATION_MS       = 60 * 1000;       // 60 seconds
const REQUEST_TIMEOUT_MS     = 10_000;

// ── Minimal fetch for Node 18+ (uses built-in fetch) or fallback ──────────────
async function fetchJson(url) {
  if (typeof globalThis.fetch === 'function') {
    const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.json();
  }
  // Node < 18 fallback using http/https
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from ${url}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
  });
}

async function postJson(url, body) {
  const payload = JSON.stringify(body);
  if (typeof globalThis.fetch === 'function') {
    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.json();
  }
  // http/https fallback
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'https:' ? https : http;
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout:  REQUEST_TIMEOUT_MS,
    };
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from ${url}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout POSTing to ${url}`)); });
    req.write(payload);
    req.end();
  });
}

// ── RpcRouter ─────────────────────────────────────────────────────────────────
class RpcRouter {
  /**
   * @param {string} registryUrl  Base URL of the registry API (no trailing slash).
   */
  constructor(registryUrl = DEFAULT_REGISTRY_URL) {
    this._registryUrl   = registryUrl;
    this._endpoints     = [];      // string[]
    this._counter       = 0;
    this._skipUntil     = {};      // endpoint → timestamp
    this._refreshTimer  = null;
    this._rpcIdCounter  = 1;
    this._initialized   = false;
  }

  /**
   * Fetch nodes from registry and start background refresh.
   * Must be called before using call().
   */
  async init() {
    await this._refreshNodes();
    this._refreshTimer = setInterval(() => {
      this._refreshNodes().catch(() => { /* silent — stale list remains */ });
    }, REFRESH_INTERVAL_MS);
    // Don't block Node process
    if (this._refreshTimer.unref) this._refreshTimer.unref();
    this._initialized = true;
    return this;
  }

  /** Fetch latest active nodes from registry. */
  async _refreshNodes() {
    try {
      const nodes = await fetchJson(`${this._registryUrl}/nodes`);
      if (!Array.isArray(nodes) || nodes.length === 0) {
        throw new Error('Registry returned empty node list');
      }
      this._endpoints = nodes
        .filter(n => n.status === 'active' && n.endpoint)
        .map(n => n.endpoint);
      if (this._endpoints.length === 0) {
        throw new Error('No active endpoints in registry response');
      }
    } catch (err) {
      if (!this._initialized) throw err;   // Hard fail on first init
      // On refresh failure keep existing list — log silently
      if (typeof process !== 'undefined' && process.env.DEBUG_RPC) {
        console.warn('[RpcRouter] Node refresh failed:', err.message);
      }
    }
  }

  /**
   * Returns all currently tracked endpoints.
   * @returns {string[]}
   */
  getEndpoints() {
    return [...this._endpoints];
  }

  /**
   * Execute a JSON-RPC call, round-robining across endpoints.
   * Skips endpoints that recently failed (60s cooldown).
   *
   * @param {string} method   JSON-RPC method name
   * @param {any[]}  params   JSON-RPC params array
   * @returns {Promise<any>}  The 'result' field of the JSON-RPC response
   * @throws {Error}          If all endpoints fail
   */
  async call(method, params = []) {
    if (!this._initialized) {
      throw new Error('RpcRouter.init() must be called before call()');
    }
    if (this._endpoints.length === 0) {
      throw new Error('All RPC endpoints unavailable — endpoint list is empty');
    }

    const now       = Date.now();
    const tried     = new Set();
    const available = this._endpoints.filter(ep => (this._skipUntil[ep] || 0) <= now);

    if (available.length === 0) {
      throw new Error('All RPC endpoints unavailable — all in cooldown');
    }

    let lastError;

    for (let attempt = 0; attempt < available.length; attempt++) {
      // Pick next endpoint (round-robin among available)
      const ep = available[this._counter % available.length];
      this._counter = (this._counter + 1) % available.length;

      if (tried.has(ep)) continue;
      tried.add(ep);

      const id = this._rpcIdCounter++;
      try {
        const response = await postJson(ep, {
          jsonrpc: '2.0',
          id,
          method,
          params,
        });

        if (response.error) {
          // JSON-RPC application-level error — don't skip endpoint, surface to caller
          const err = new Error(response.error.message || JSON.stringify(response.error));
          err.code  = response.error.code;
          err.data  = response.error.data;
          throw err;
        }

        return response.result;
      } catch (err) {
        lastError = err;
        // Only skip endpoint for network/timeout errors, not JSON-RPC app errors
        if (!err.code) {
          this._skipUntil[ep] = Date.now() + SKIP_DURATION_MS;
        } else {
          // JSON-RPC error — don't retry on a different endpoint, surface immediately
          throw err;
        }
      }
    }

    throw new Error(`All RPC endpoints unavailable — last error: ${lastError?.message}`);
  }

  /** Stop background refresh. */
  destroy() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }
}

/**
 * Create and initialize an RpcRouter instance.
 *
 * @param {string} [registryUrl]  Defaults to https://x1scroll.io/api/registry
 * @returns {Promise<RpcRouter>}
 *
 * @example
 *   const router = await createRpcRouter();
 *   const slot   = await router.call('getSlot', []);
 */
async function createRpcRouter(registryUrl) {
  const router = new RpcRouter(registryUrl);
  await router.init();
  return router;
}

module.exports = { RpcRouter, createRpcRouter };
