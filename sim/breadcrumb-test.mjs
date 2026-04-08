/**
 * BREADCRUMB TEST — Real IPFS pin + on-chain decision write + recall
 * 
 * This is the REAL test:
 * 1. Each agent compresses its state into JSON
 * 2. Pins it to IPFS via x1scroll.io/api/ipfs/upload
 * 3. Gets a real CID back
 * 4. Writes a decision on-chain with that CID (+ parent hash from prior decision)
 * 5. Verifies the CID is retrievable from IPFS
 * 6. Chains parent hashes — each decision links to the prior one
 * 
 * This proves: pin → chain → recall — the full hive mind primitive.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { AgentClient } = require('../src/index.js');
const { Keypair, Connection } = require('@solana/web3.js');
const fs    = require('fs');
const https = require('https');
const http  = require('http');

const RPC_URL   = process.env.RPC_URL   || 'https://rpc.x1scroll.io';
const API_KEY   = process.env.RPC_API_KEY || null;
const IPFS_URL  = process.env.IPFS_URL  || 'https://x1scroll.io/api/ipfs/upload';
const IPFS_RECALL_URL = 'https://x1scroll.io/api/ipfs';
const STATE_FILE   = process.env.STATE_FILE   || './sim_state.json';
const HUMAN_WALLET = process.env.HUMAN_WALLET || null;
const LOG_FILE   = process.env.LOG_FILE   || './breadcrumb_test.log';
const NUM_ROUNDS = parseInt(process.env.NUM_ROUNDS || '3');
const NUM_AGENTS = parseInt(process.env.NUM_AGENTS || '10');

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ── bs58 compat ───────────────────────────────────────────────────────────────
const bs58mod = require('bs58');
const bs58decode = (typeof bs58mod.decode === 'function') ? bs58mod.decode : bs58mod.default.decode;

function loadKeypair(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (raw.secret_b58) return Keypair.fromSecretKey(bs58decode(raw.secret_b58));
  const arr = Array.isArray(raw) ? raw : (raw.secretKey || Object.values(raw));
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

// ── Bootstrap: register agents from scratch ──────────────────────────────────
async function bootstrapAgents(n) {
  if (!HUMAN_WALLET) {
    log('ERROR: No state file found and HUMAN_WALLET not set.');
    log('  Set HUMAN_WALLET=<path/to/wallet.json> and ensure it is funded (≥1 XNT per 5 agents).');
    process.exit(1);
  }
  const humanKp = loadKeypair(HUMAN_WALLET);
  log(`Bootstrapping ${n} agents from wallet ${humanKp.publicKey.toBase58().slice(0, 16)}...`);

  const { Transaction, SystemProgram } = require('@solana/web3.js');
  const humanClient = new AgentClient({ rpcUrl: RPC_URL, apiKey: API_KEY, wallet: humanKp });
  const conn = new Connection(RPC_URL, 'confirmed');
  const bal = await conn.getBalance(humanKp.publicKey);
  log(`  Wallet balance: ${(bal / 1e9).toFixed(4)} XNT`);

  const agentKeys = [];
  for (let i = 0; i < n; i++) {
    const agentKp = Keypair.generate();
    const agentId = `CC-Agent-${i.toString().padStart(3, '0')}`;
    try {
      const fundTx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: humanKp.publicKey,
        toPubkey: agentKp.publicKey,
        lamports: 200_000_000,
      }));
      await humanClient._sendAndConfirm(fundTx, [humanKp]);

      const genesisCid  = await pinToIPFS({ agentId, event: 'genesis', ts: new Date().toISOString() });
      const manifestCid = await pinToIPFS({ agentId, event: 'manifest', version: '1.0', ts: new Date().toISOString() });

      const agentRegClient = new AgentClient({ rpcUrl: RPC_URL, wallet: agentKp });
      await agentRegClient.register(agentKp, agentId, genesisCid, manifestCid.slice(0, 64));

      agentKeys.push(agentKp.secretKey.toString() + '|' + agentId);
      log(`  ✅ Registered ${agentId}`);
      await new Promise(r => setTimeout(r, 800));
    } catch(e) {
      log(`  ❌ Failed to register ${agentId}: ${e.message}`);
    }
  }

  const state = { startedAt: new Date().toISOString(), round: 0, totalDecisions: 0, agentKeys, errors: 0 };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log(`Bootstrap complete: ${agentKeys.length}/${n} agents registered, state saved to ${STATE_FILE}`);
  return state;
}

// ── Load agent keypairs from state ──────────────────────────────────────────
function loadAgentKeypairs(n) {
  const state = JSON.parse(fs.readFileSync(STATE_FILE));
  return state.agentKeys.slice(0, n).map((entry, i) => {
    const raw = entry.split('|')[0];
    const secret = Uint8Array.from(raw.split(',').map(Number));
    return { kp: Keypair.fromSecretKey(secret), id: `CC-Agent-${i.toString().padStart(3,'0')}` };
  });
}

// ── Pin content to IPFS (with retry on 429) ──────────────────────────────────
function pinToIPFS(content, retries = 3) {
  const attempt = (i) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ content });
    const url = new URL(IPFS_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (API_KEY) headers['x-api-key'] = API_KEY;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers,
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 429 && i < retries - 1) {
          setTimeout(() => attempt(i + 1).then(resolve).catch(reject), (i + 1) * 2000);
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.cid) resolve(parsed.cid);
          else reject(new Error(`IPFS no CID: ${data}`));
        } catch(e) { reject(new Error(`IPFS parse error: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Recall from IPFS (with retry on 429) ─────────────────────────────────────
function recallFromIPFS(cid, retries = 3) {
  const attempt = (i) => new Promise((resolve, reject) => {
    const url = new URL(`${IPFS_RECALL_URL}/${cid}`);
    const headers = {};
    if (API_KEY) headers['x-api-key'] = API_KEY;
    const req = https.request({ hostname: url.hostname, path: url.pathname, headers, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 429 && i < retries - 1) {
          setTimeout(() => attempt(i + 1).then(resolve).catch(reject), (i + 1) * 2000);
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.end();
  });
  return attempt(0);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log('=== BREADCRUMB TEST — Real IPFS + On-Chain Decision Chain ===');
  log(`Testing ${NUM_AGENTS} agents × ${NUM_ROUNDS} rounds`);

  if (!fs.existsSync(STATE_FILE)) {
    log(`No state file found at ${STATE_FILE} — running bootstrap registration first...`);
    await bootstrapAgents(NUM_AGENTS);
  }

  const agents = loadAgentKeypairs(NUM_AGENTS);
  log(`Loaded ${agents.length} agent keypairs from state`);

  const connection = new Connection(RPC_URL, 'confirmed');

  // Track per-agent state: last CID pinned, last decision hash (for chaining)
  const agentState = agents.map(a => ({ ...a, lastCid: null, lastHash: null, decisions: 0, errors: 0 }));

  let totalDecisions = 0;
  let totalPins = 0;
  let totalRecalls = 0;
  let totalErrors = 0;

  for (let round = 1; round <= NUM_ROUNDS; round++) {
    log(`\n── Round ${round}/${NUM_ROUNDS} ──`);

    for (const agent of agentState) {
      try {
        // Step 1: Build agent state payload
        const payload = {
          agentId: agent.id,
          pubkey: agent.kp.publicKey.toBase58(),
          round,
          timestamp: new Date().toISOString(),
          lastCid: agent.lastCid,
          decisions: agent.decisions,
          status: 'active',
          message: `Round ${round} breadcrumb from ${agent.id}`,
        };

        // Step 2: Pin to IPFS
        let cid;
        try {
          cid = await pinToIPFS(payload);
          totalPins++;
          log(`  📌 [${agent.id}] Pinned → CID: ${cid}`);
        } catch(e) {
          log(`  ❌ [${agent.id}] IPFS pin failed: ${e.message}`);
          agent.errors++;
          totalErrors++;
          continue;
        }

        // Step 3: Write decision on-chain with real CID + parent hash chain
        const sdk = new AgentClient({ rpcUrl: RPC_URL, wallet: agent.kp });
        try {
          const result = await sdk.decisionWrite(
            agent.kp,
            `round-${round}`,          // branchLabel (max 32 chars)
            cid,                        // real IPFS CID
            1,                          // outcome: executed
            9000,                       // confidence: 90%
            agent.lastHash              // parent hash — chains to prior decision
          );
          agent.lastCid  = cid;
          agent.lastHash = result.decisionHash ? Buffer.from(result.decisionHash) : null;
          agent.decisions++;
          totalDecisions++;
          log(`  ✅ [${agent.id}] Decision on-chain | TX: ${result.sig?.slice(0,16)}... | CID: ${cid.slice(0,20)}...`);
        } catch(e) {
          log(`  ❌ [${agent.id}] DecisionWrite failed: ${e.message}`);
          agent.errors++;
          totalErrors++;
        }

        // Step 4: Verify recall (every other round to save time)
        if (round % 2 === 0 && cid) {
          try {
            const recalled = await recallFromIPFS(cid);
            const parsed = JSON.parse(recalled);
            if (parsed.agentId === agent.id) {
              totalRecalls++;
              log(`  🔁 [${agent.id}] Recall verified ✅ — got back agentId: ${parsed.agentId}, round: ${parsed.round}`);
            } else {
              log(`  ⚠️  [${agent.id}] Recall mismatch — expected ${agent.id}, got ${parsed.agentId}`);
            }
          } catch(e) {
            log(`  ❌ [${agent.id}] Recall failed: ${e.message}`);
          }
        }

      } catch(e) {
        log(`  ❌ [${agent.id}] Unexpected error: ${e.message}`);
        agent.errors++;
        totalErrors++;
      }
    }

    log(`\n  Round ${round} summary: ${totalDecisions} decisions | ${totalPins} pins | ${totalRecalls} recalls | ${totalErrors} errors`);

    if (round < NUM_ROUNDS) {
      log('  Waiting 5s before next round...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // ── Final report ────────────────────────────────────────────────────────────
  log('\n=== BREADCRUMB TEST COMPLETE ===');
  log(`Total decisions on-chain: ${totalDecisions}`);
  log(`Total IPFS pins:          ${totalPins}`);
  log(`Total recalls verified:   ${totalRecalls}`);
  log(`Total errors:             ${totalErrors}`);
  log('');

  // Check treasury
  const { execSync } = require('child_process');
  try {
    const treasury = JSON.parse(execSync(
      `curl -s -X POST ${RPC_URL} -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK",{"commitment":"confirmed"}]}'`
    ).toString()).result.value / 1e9;
    log(`Treasury balance: ${treasury.toFixed(6)} XNT`);
  } catch(e) {}

  // Per-agent summary
  log('\nPer-agent results:');
  for (const a of agentState) {
    log(`  ${a.id}: ${a.decisions} decisions | ${a.errors} errors | lastCid: ${a.lastCid?.slice(0,20) || 'none'}`);
  }
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
