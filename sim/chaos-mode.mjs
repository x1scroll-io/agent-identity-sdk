/**
 * CHAOS MODE — 25 agents running in parallel
 * 
 * All agents fire simultaneously. Each agent:
 * 1. Pins its state to IPFS
 * 2. Writes decision on-chain with that CID
 * 3. Cross-recalls a RANDOM OTHER AGENT's last CID
 * 4. Chains parent hashes
 * 
 * No order. No waiting. All 25 at once, every round.
 * This is the real stress test.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { AgentClient } = require('../src/index.js');
const { Keypair, Connection } = require('@solana/web3.js');
const fs    = require('fs');
const https = require('https');
const http  = require('http');

const RPC_URL    = process.env.RPC_URL    || 'http://104.250.159.138:8899';
const IPFS_UPLOAD = 'https://x1scroll.io/api/ipfs/upload';
const IPFS_RECALL = 'https://x1scroll.io/api/ipfs';
const STATE_FILE  = process.env.STATE_FILE || '/root/.openclaw/workspace/memory/citizens_city_sim_state.json';
const LOG_FILE    = process.env.LOG_FILE   || '/root/.openclaw/workspace/memory/chaos_mode.log';
const NUM_ROUNDS  = parseInt(process.env.NUM_ROUNDS  || '10');
const NUM_AGENTS  = parseInt(process.env.NUM_AGENTS  || '25');

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

function loadAgentKeypairs(n) {
  const state = JSON.parse(fs.readFileSync(STATE_FILE));
  return state.agentKeys.slice(0, n).map((entry, i) => {
    const raw = entry.split('|')[0];
    const secret = Uint8Array.from(raw.split(',').map(Number));
    return { kp: Keypair.fromSecretKey(secret), id: `CC-Agent-${i.toString().padStart(3,'0')}` };
  });
}

function httpRequest(url, method, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

    const req = mod.request(opts, (res) => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => resolve(out));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function pinToIPFS(content) {
  const raw = await httpRequest(IPFS_UPLOAD, 'POST', { content });
  const parsed = JSON.parse(raw);
  if (!parsed.cid) throw new Error(`No CID: ${raw}`);
  return parsed.cid;
}

async function recallFromIPFS(cid) {
  const raw = await httpRequest(`${IPFS_RECALL}/${cid}`, 'GET', null);
  return JSON.parse(raw);
}

// Run one agent for one round — fully independent
async function runAgent(agent, round, agentState, stats) {
  const startMs = Date.now();
  try {
    // Step 1: Pin own state
    const payload = {
      agentId:    agent.id,
      pubkey:     agent.kp.publicKey.toBase58(),
      round,
      timestamp:  new Date().toISOString(),
      lastCid:    agentState.lastCid,
      decisions:  agentState.decisions,
      status:     'chaos',
    };
    const cid = await pinToIPFS(payload);
    agentState.lastCid = cid;
    stats.pins++;

    // Step 2: Write decision on-chain
    const sdk = new AgentClient({ rpcUrl: RPC_URL, wallet: agent.kp });
    const result = await sdk.decisionWrite(
      agent.kp,
      `chaos-r${round}`,
      cid,
      1,
      9500,
      agentState.lastHash
    );
    agentState.lastHash = result.decisionHash ? Buffer.from(result.decisionHash) : null;
    agentState.decisions++;
    stats.decisions++;

    // Step 3: Cross-recall — read a RANDOM OTHER AGENT's last CID
    const others = Object.entries(agentState.peers).filter(([id, s]) => s.lastCid && id !== agent.id);
    if (others.length > 0) {
      const [peerId, peerState] = others[Math.floor(Math.random() * others.length)];
      try {
        const recalled = await recallFromIPFS(peerState.lastCid);
        stats.recalls++;
        log(`  🔗 [${agent.id}] recalled ${peerId} round ${recalled.round} ✅`);
      } catch(e) {
        log(`  ⚠️  [${agent.id}] cross-recall of ${peerId} failed: ${e.message}`);
      }
    }

    const ms = Date.now() - startMs;
    log(`  ✅ [${agent.id}] r${round} | CID:${cid.slice(0,14)}... | TX:${result.sig?.slice(0,12)}... | ${ms}ms`);

  } catch(e) {
    stats.errors++;
    log(`  ❌ [${agent.id}] r${round} FAILED: ${e.message}`);
  }
}

async function main() {
  log('');
  log('╔══════════════════════════════════════════════╗');
  log('║          CHAOS MODE — ALL AGENTS PARALLEL    ║');
  log(`║   ${NUM_AGENTS} agents × ${NUM_ROUNDS} rounds — fire at will       ║`);
  log('╚══════════════════════════════════════════════╝');

  const agents = loadAgentKeypairs(NUM_AGENTS);
  log(`Loaded ${agents.length} agent keypairs`);

  // Shared state — agents can see each other's last CID
  const agentStates = {};
  const sharedPeers = agentStates; // same object — all agents share peer visibility

  for (const a of agents) {
    agentStates[a.id] = { lastCid: null, lastHash: null, decisions: 0, peers: sharedPeers };
  }

  const globalStats = { decisions: 0, pins: 0, recalls: 0, errors: 0 };

  const t0 = Date.now();

  for (let round = 1; round <= NUM_ROUNDS; round++) {
    log(`\n${'═'.repeat(50)}`);
    log(`  ROUND ${round}/${NUM_ROUNDS} — ALL 25 FIRING SIMULTANEOUSLY`);
    log(`${'═'.repeat(50)}`);

    const roundStats = { decisions: 0, pins: 0, recalls: 0, errors: 0 };

    // ALL agents launch at the same time
    await Promise.all(agents.map(agent =>
      runAgent(agent, round, agentStates[agent.id], roundStats)
    ));

    globalStats.decisions += roundStats.decisions;
    globalStats.pins      += roundStats.pins;
    globalStats.recalls   += roundStats.recalls;
    globalStats.errors    += roundStats.errors;

    log(`\n  ── Round ${round} complete ──`);
    log(`  Decisions: ${roundStats.decisions} | Pins: ${roundStats.pins} | Recalls: ${roundStats.recalls} | Errors: ${roundStats.errors}`);
    log(`  Running totals → ${globalStats.decisions} decisions | ${globalStats.pins} pins | ${globalStats.recalls} recalls | ${globalStats.errors} errors`);

    if (round < NUM_ROUNDS) await new Promise(r => setTimeout(r, 3000));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  log('');
  log('╔══════════════════════════════════════════════╗');
  log('║              CHAOS MODE COMPLETE             ║');
  log('╚══════════════════════════════════════════════╝');
  log(`  Total decisions:  ${globalStats.decisions}`);
  log(`  Total IPFS pins:  ${globalStats.pins}`);
  log(`  Total recalls:    ${globalStats.recalls}`);
  log(`  Total errors:     ${globalStats.errors}`);
  log(`  Elapsed:          ${elapsed}s`);
  log(`  Success rate:     ${((globalStats.decisions / (NUM_AGENTS * NUM_ROUNDS)) * 100).toFixed(1)}%`);

  // Treasury
  try {
    const { execSync } = require('child_process');
    const t = JSON.parse(execSync(
      `curl -s -X POST ${RPC_URL} -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK",{"commitment":"confirmed"}]}'`
    ).toString()).result.value / 1e9;
    log(`  Treasury balance: ${t.toFixed(6)} XNT`);
  } catch(_) {}
}

main().catch(e => { log(`FATAL: ${e.message}\n${e.stack}`); process.exit(1); });
