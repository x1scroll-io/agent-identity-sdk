'use strict';
/**
 * StorageRouter — round-robin IPFS pinning across validator storage nodes.
 *
 * Fetches storage-enabled nodes from /api/registry/nodes?type=storage,
 * distributes uploads round-robin, skips failed nodes for 60s,
 * auto-refreshes every 5 min.
 *
 * Usage:
 *   const { createStorageRouter, setStorageRouter } = require('@x1scroll/agent-sdk');
 *   const storage = await createStorageRouter();
 *   setStorageRouter(storage);
 *
 *   // Direct use:
 *   const { cid, endpoint } = await storage.pin('hello world');
 *   const content = await storage.fetch(cid);
 */

const https = require('https');
const http  = require('http');

const DEFAULT_REGISTRY_URL = 'https://x1scroll.io/api/registry';
const REFRESH_INTERVAL_MS  = 5 * 60 * 1000;   // 5 minutes
const SKIP_DURATION_MS     = 60 * 1000;        // 60 seconds
const REQUEST_TIMEOUT_MS   = 15_000;

/**
 * Hardcoded fallback — used when registry is unreachable or returns no storage nodes.
 * Nodes expose /upload and /<cid> under this base.
 */
const FALLBACK_STORAGE = [
  'https://x1scroll.io/api/ipfs',
];

// ── HTTP helpers (same pattern as rpc.js) ─────────────────────────────────────

async function fetchJson(url) {
  if (typeof globalThis.fetch === 'function') {
    const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.json();
  }
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

async function fetchText(url) {
  if (typeof globalThis.fetch === 'function') {
    const res = await globalThis.fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.text();
  }
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
  });
}

async function postContent(url, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');

  if (typeof globalThis.fetch === 'function') {
    const res = await globalThis.fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      signal:  AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json();
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'https:' ? https : http;
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/octet-stream',
        'Content-Length': body.length,
      },
      timeout: REQUEST_TIMEOUT_MS,
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
    req.write(body);
    req.end();
  });
}

// ── StorageRouter ─────────────────────────────────────────────────────────────

class StorageRouter {
  /**
   * @param {string} [registryUrl]  Base URL of the registry API (no trailing slash).
   */
  constructor(registryUrl = DEFAULT_REGISTRY_URL) {
    this._registryUrl  = registryUrl;
    this._nodes        = [];     // string[] — base IPFS URLs (e.g. https://node.x1.io/api/ipfs)
    this._counter      = 0;
    this._skipUntil    = {};     // endpoint → timestamp
    this._refreshTimer = null;
    this._initialized  = false;
  }

  /**
   * Fetch storage nodes from registry and start background refresh.
   * Must be called before pin() or fetch().
   * @returns {Promise<StorageRouter>}  this (for chaining)
   */
  async init() {
    await this._refreshNodes();
    this._refreshTimer = setInterval(() => {
      this._refreshNodes().catch(() => { /* silent — stale list remains */ });
    }, REFRESH_INTERVAL_MS);
    if (this._refreshTimer.unref) this._refreshTimer.unref();
    this._initialized = true;
    return this;
  }

  /** Fetch/refresh storage-capable nodes from registry. */
  async _refreshNodes() {
    try {
      const url   = `${this._registryUrl}/nodes?type=storage`;
      const nodes = await fetchJson(url);
      if (!Array.isArray(nodes) || nodes.length === 0) {
        throw new Error('Registry returned no storage nodes');
      }
      const endpoints = nodes
        .filter(n => n.status === 'active' && n.endpoint)
        .map(n => {
          // Normalize: ensure base URL ends with /api/ipfs
          // Nodes register their RPC base (e.g. https://rpc.node.io)
          const base = n.endpoint.replace(/\/api\/ipfs\/?$/, '').replace(/\/$/, '');
          return `${base}/api/ipfs`;
        });
      if (endpoints.length === 0) throw new Error('No active storage nodes in registry');
      this._nodes = endpoints;
    } catch (err) {
      if (!this._initialized) {
        // First init failure — use fallback list so init() doesn't throw
        this._nodes = [...FALLBACK_STORAGE];
        if (process.env.DEBUG_STORAGE) {
          console.warn('[StorageRouter] Registry unreachable, using fallback:', err.message);
        }
        return;
      }
      // Background refresh failure — keep existing list
      if (process.env.DEBUG_STORAGE) {
        console.warn('[StorageRouter] Node refresh failed:', err.message);
      }
    }
  }

  /**
   * Pin content to an IPFS storage node using round-robin routing.
   * Skips nodes that failed within the last 60 seconds.
   *
   * @param {string|Buffer} content  Data to pin
   * @returns {Promise<{ cid: string, endpoint: string }>}
   * @throws {Error} "All storage nodes unavailable" if every node fails
   */
  async pin(content) {
    if (!this._initialized) throw new Error('StorageRouter.init() must be called before pin()');
    if (this._nodes.length === 0) throw new Error('All storage nodes unavailable — empty node list');

    const now       = Date.now();
    const available = this._nodes.filter(ep => (this._skipUntil[ep] || 0) <= now);

    if (available.length === 0) throw new Error('All storage nodes unavailable — all in cooldown');

    let lastError;

    for (let attempt = 0; attempt < available.length; attempt++) {
      const ep = available[this._counter % available.length];
      this._counter = (this._counter + 1) % available.length;

      try {
        const uploadUrl = `${ep}/upload`;
        const result    = await postContent(uploadUrl, content);
        if (!result || !result.cid) throw new Error(`No CID in response from ${ep}`);
        return { cid: result.cid, endpoint: ep };
      } catch (err) {
        lastError = err;
        this._skipUntil[ep] = Date.now() + SKIP_DURATION_MS;
        if (process.env.DEBUG_STORAGE) {
          console.warn(`[StorageRouter] pin() failed on ${ep}:`, err.message);
        }
      }
    }

    throw new Error(`All storage nodes unavailable — last error: ${lastError?.message}`);
  }

  /**
   * Fetch content by CID, trying all nodes in order until one succeeds.
   * Unlike pin(), this does NOT round-robin — it tries every node before failing.
   *
   * @param {string} cid  IPFS CID to fetch
   * @returns {Promise<string>}  Raw content as string
   * @throws {Error} If all nodes fail
   */
  async fetch(cid) {
    if (!this._initialized) throw new Error('StorageRouter.init() must be called before fetch()');
    if (this._nodes.length === 0) throw new Error('All storage nodes unavailable — empty node list');

    const now = Date.now();

    // Try healthy nodes first, then cooled-down ones as last resort
    const ordered = [
      ...this._nodes.filter(ep => (this._skipUntil[ep] || 0) <= now),
      ...this._nodes.filter(ep => (this._skipUntil[ep] || 0) > now),
    ];

    let lastError;
    for (const ep of ordered) {
      try {
        return await fetchText(`${ep}/${cid}`);
      } catch (err) {
        lastError = err;
        if (process.env.DEBUG_STORAGE) {
          console.warn(`[StorageRouter] fetch() failed on ${ep}:`, err.message);
        }
      }
    }

    throw new Error(`All storage nodes unavailable — failed to fetch CID ${cid}. Last error: ${lastError?.message}`);
  }

  /**
   * Returns the current list of storage node base URLs.
   * @returns {string[]}
   */
  getNodes() {
    return [...this._nodes];
  }

  /** Stop background refresh timer. */
  destroy() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }
}

/**
 * Create and initialize a StorageRouter.
 *
 * @param {string} [registryUrl]  Defaults to https://x1scroll.io/api/registry
 * @returns {Promise<StorageRouter>}
 *
 * @example
 *   const { createStorageRouter, setStorageRouter } = require('@x1scroll/agent-sdk');
 *   const storage = await createStorageRouter();
 *   setStorageRouter(storage);
 *   // Now all uploadMemory() calls route across validator storage nodes
 */
async function createStorageRouter(registryUrl) {
  const router = new StorageRouter(registryUrl);
  await router.init();
  return router;
}

module.exports = { StorageRouter, createStorageRouter, FALLBACK_STORAGE };
