/**
 * Citizens City Stress Test — 1000 agents, 24h run
 * Uses DecisionBuffer to batch decision_write calls (5 per tx)
 *
 * Budget: ~60 XNT from Strategy D wallet
 * Fee per decision: 0.001 XNT
 * Fee per registration: 0.05 XNT
 * Max agents: 100 (10 decisions each = 1000 total decisions = ~1 XNT fees)
 * Full 24h run: agents loop every 30s, ~2880 decisions/agent/24h (batched)
 *
 * Run: node sim/citizens-city-stress.mjs
 * Stop: Ctrl+C (graceful shutdown, flushes buffer)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { AgentClient, DecisionBuffer } = require('../src/index.js');
const { Keypair, Connection }          = require('@solana/web3.js');
const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
  rpcUrl:        process.env.RPC_URL || 'https://rpc.x1scroll.io',
  humanWallet:   process.env.HUMAN_WALLET || './wallet.json',  // set HUMAN_WALLET env or drop wallet.json in this dir
  numAgents:     parseInt(process.env.NUM_AGENTS  || '10'),    // scale up: 10 → 100 → 1000
  decisionsEach: 10,       // decisions per agent per round
  roundIntervalMs: 30000,  // 30s between rounds (production cadence)
  maxRounds: parseInt(process.env.MAX_ROUNDS || 'Infinity'), // runs until Ctrl+C — 24h+ continuous
  batchSize:     5,        // decisions per tx (5x compression)
  logFile:       process.env.LOG_FILE   || './citizens_city_sim.log',
  stateFile:     process.env.STATE_FILE || './citizens_city_sim_state.json',
};

// ── Logging ───────────────────────────────────────────────────────────────────
const logStream = fs.createWriteStream(CONFIG.logFile, { flags: 'a' });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ── bs58 compat ───────────────────────────────────────────────────────────────
const bs58mod = require('bs58');
const bs58decode = (typeof bs58mod.decode === 'function') ? bs58mod.decode : bs58mod.default.decode;

// ── Load keypair helper ───────────────────────────────────────────────────────
function loadKeypair(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  // Handle: {secret_b58: '...'}, plain array [0..63], or {secretKey: [...]}
  if (raw.secret_b58) {
    return Keypair.fromSecretKey(bs58decode(raw.secret_b58));
  }
  const arr = Array.isArray(raw) ? raw : (raw.secretKey || Object.values(raw));
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

// ── Agent behaviors ───────────────────────────────────────────────────────────
const BEHAVIORS = [
  { branch: 'trade',    messages: ['scanned XNT pool — spread nominal', 'price within buy zone', 'volume confirms momentum', 'placed limit order', 'order filled at target'] },
  { branch: 'risk',     messages: ['position within 10% limit', 'max drawdown not triggered', 'portfolio rebalanced', 'stop-loss updated', 'risk score: low'] },
  { branch: 'market',   messages: ['mempool scan complete — no front-run detected', 'liquidity depth: adequate', 'spread tightened since last check', 'bot pattern: none', 'oracle price confirmed'] },
  { branch: 'strategy', messages: ['branch hypothesis still valid', 'exit target unchanged at 0.38', 'holding position', 'signal strength: 0.82', 'next review in 30s'] },
  { branch: 'memory',   messages: ['compressed session state to IPFS', 'recalled prior context: ok', 'decision chain: 12 entries', 'parent hash linked', 'context integrity: verified'] },
];

function randomBehavior() {
  return BEHAVIORS[Math.floor(Math.random() * BEHAVIORS.length)];
}
function randomMessage(behavior) {
  return behavior.messages[Math.floor(Math.random() * behavior.messages.length)];
}

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  startedAt:       null,
  round:           0,
  totalDecisions:  0,
  totalTxns:       0,
  totalFeeXNT:     0,
  agentKeys:       [],   // base58 pubkeys of registered agents
  errors:          0,
};

function saveState() {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

function loadState() {
  if (fs.existsSync(CONFIG.stateFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
      // Only restore if started within last 25 hours
      if (saved.startedAt && Date.now() - new Date(saved.startedAt).getTime() < 25 * 3600 * 1000) {
        state = saved;
        log(`Resumed state: round ${state.round}, ${state.totalDecisions} decisions so far`);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('=== Citizens City Stress Test STARTING ===');
  log(`Config: ${CONFIG.numAgents} agents, ${CONFIG.decisionsEach} decisions/round, batch=${CONFIG.batchSize}`);

  const humanKeypair = loadKeypair(CONFIG.humanWallet);
  log(`Human wallet: ${humanKeypair.publicKey.toBase58()}`);

  // Check balance
  const conn = new Connection(CONFIG.rpcUrl, 'confirmed');
  const balLamports = await conn.getBalance(humanKeypair.publicKey);
  const balXNT      = balLamports / 1e9;
  log(`Wallet balance: ${balXNT.toFixed(4)} XNT`);

  if (balXNT < 1) {
    log('ERROR: Insufficient balance — need at least 1 XNT to start');
    process.exit(1);
  }

  const client = new AgentClient({ rpcUrl: CONFIG.rpcUrl, wallet: humanKeypair });

  const resumed = loadState();
  if (!resumed) {
    state.startedAt = new Date().toISOString();
  }

  // ── Phase 1: Register agents (if not resumed) ──────────────────────────────
  let agentKeypairs = [];

  if (state.agentKeys.length === 0) {
    log(`\n── Phase 1: Registering ${CONFIG.numAgents} agents ──`);

    for (let i = 0; i < CONFIG.numAgents; i++) {
      const agentKp = Keypair.generate();
      const agentId = `CC-Agent-${i.toString().padStart(3, '0')}`;

      // Fund agent with enough for decisions (0.001 XNT * 100 rounds + buffer)
      const fundLamports = 200_000_000; // 0.2 XNT per agent
      try {
        // Transfer funding to agent
        const { Transaction, SystemProgram } = require('@solana/web3.js');
        const fundTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: humanKeypair.publicKey,
            toPubkey:   agentKp.publicKey,
            lamports:   fundLamports,
          })
        );
        await client._sendAndConfirm(fundTx, [humanKeypair]);
        log(`  Funded agent ${agentId}: ${agentKp.publicKey.toBase58().slice(0, 12)}... (0.2 XNT)`);

        // Register agent — agentId is now part of PDA seeds
        const { txSig, agentRecordPDA } = await client.register(
          humanKeypair,
          agentKp,
          agentId,
          'QmSimStart000000000000000000000000000000000000',
          'QmSimManifest0000000000000000000000000000000000'.slice(0, 64)
        );
        // Store agentId alongside secretKey so we can reconstruct the PDA later
        state.agentKeys.push(agentKp.secretKey.toString() + '|' + agentId);
        log(`  ✅ Registered ${agentId} | tx: ${txSig.slice(0, 16)}...`);

        agentKeypairs.push({ kp: agentKp, agentId });
        saveState();

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 800));
      } catch (err) {
        log(`  ❌ Failed to register ${agentId}: ${err.message}`);
        state.errors++;
      }
    }
    log(`Registration complete: ${agentKeypairs.length}/${CONFIG.numAgents} agents registered`);
    saveState(); // Save again with updated agentKeys format
  } else {
    // Restore agent keypairs from state
    log(`Restoring ${state.agentKeys.length} agent keypairs from state...`);
    for (const entry of state.agentKeys) {
      // New format: "<secretKey bytes comma-joined>|<agentId>"
      // Old format: "<secretKey bytes comma-joined>" (no pipe — agentId derived from index)
      let skStr, agentId;
      if (entry.includes('|')) {
        const pipeIdx = entry.lastIndexOf('|');
        skStr   = entry.slice(0, pipeIdx);
        agentId = entry.slice(pipeIdx + 1);
      } else {
        skStr   = entry;
        agentId = `CC-Agent-${String(agentKeypairs.length).padStart(3, '0')}`;
      }
      const skArr = skStr.split(',').map(Number);
      agentKeypairs.push({ kp: Keypair.fromSecretKey(Uint8Array.from(skArr)), agentId });
    }
    log(`Restored ${agentKeypairs.length} agents`);
  }

  if (agentKeypairs.length === 0) {
    log('FATAL: No agents registered — aborting');
    process.exit(1);
  }

  // ── Phase 2: Decision loop ─────────────────────────────────────────────────
  log(`\n── Phase 2: Decision loop (${CONFIG.maxRounds === Infinity ? '24h' : CONFIG.maxRounds + ' rounds'}) ──`);

  // Graceful shutdown handler
  let running = true;
  process.on('SIGINT', async () => {
    log('\nShutdown signal received — flushing buffers...');
    running = false;
  });

  while (running && state.round < CONFIG.maxRounds) {
    state.round++;
    log(`\n── Round ${state.round} ──`);

    let roundDecisions = 0;
    let roundTxns      = 0;

    // Each agent runs a DecisionBuffer round
    // Run agents serially to keep RPC load manageable
    for (const { kp: agentKp, agentId: agentIdLocal } of agentKeypairs) {
      if (!running) break;

      const agentClient = new AgentClient({ rpcUrl: CONFIG.rpcUrl, wallet: agentKp });
      const shortId = agentKp.publicKey.toBase58().slice(0, 8);

      // Build decision list
      const decisions = [];
      for (let d = 0; d < CONFIG.decisionsEach; d++) {
        const behavior = randomBehavior();
        decisions.push({ branch: behavior.branch, message: `[R${state.round}] ${randomMessage(behavior)}` });
      }

      let agentDecisions = 0;
      let agentTxns = 0;

      // Write in explicit batches using DecisionBuffer._sendBatch directly
      // This bypasses the async auto-flush race and gives us full control
      const { DecisionBuffer: DB } = require('../src/decision-buffer.js');
      const buffer = new DB(agentClient, agentKp, { maxBatch: 9999, agentId: agentIdLocal }); // no auto-flush

      for (const d of decisions) {
        buffer.add(d.branch, d.message);
      }

      // Drain in batches of CONFIG.batchSize
      try {
        while (buffer._queue.length > 0) {
          const batch = buffer._queue.splice(0, CONFIG.batchSize);
          const txSig = await buffer._sendBatch(batch);
          agentDecisions += batch.length;
          agentTxns++;
        }
        if (agentTxns > 0) {
          log(`  [${shortId}] ${agentDecisions} decisions → ${agentTxns} txns (${(agentDecisions/agentTxns).toFixed(1)}x batch)`);
        }
      } catch (err) {
        log(`  ❌ [${shortId}] ${err.message.slice(0, 100)}`);
        state.errors++;
      }

      roundDecisions += agentDecisions;
      roundTxns      += agentTxns;
    }

    state.totalDecisions += roundDecisions;
    state.totalTxns      += roundTxns;
    state.totalFeeXNT    += roundTxns * 0.001; // approximate (decisions * 0.001 per decision)
    saveState();

    log(`  Round ${state.round} complete: ${roundDecisions} decisions, ${roundTxns} txns`);
    log(`  Totals: ${state.totalDecisions} decisions | ${state.totalTxns} txns | ~${state.totalFeeXNT.toFixed(3)} XNT fees | ${state.errors} errors`);

    if (running && state.round < CONFIG.maxRounds) {
      log(`  Waiting ${CONFIG.roundIntervalMs / 1000}s...`);
      await new Promise(r => setTimeout(r, CONFIG.roundIntervalMs));
    }
  }

  // ── Final report ────────────────────────────────────────────────────────────
  const durationMs = Date.now() - new Date(state.startedAt).getTime();
  const durationMin = (durationMs / 60000).toFixed(1);

  log('\n=== STRESS TEST COMPLETE ===');
  log(`Duration:        ${durationMin} minutes`);
  log(`Agents:          ${agentKeypairs.length}`);
  log(`Rounds:          ${state.round}`);
  log(`Total decisions: ${state.totalDecisions}`);
  log(`Total txns:      ${state.totalTxns}`);
  log(`Batch ratio:     ${(state.totalDecisions / Math.max(state.totalTxns, 1)).toFixed(1)}x compression`);
  log(`Est. fees spent: ~${state.totalFeeXNT.toFixed(3)} XNT`);
  log(`Errors:          ${state.errors}`);
  log(`Error rate:      ${((state.errors / Math.max(state.totalDecisions, 1)) * 100).toFixed(2)}%`);
  log(`State file:      ${CONFIG.stateFile}`);
  log(`Log file:        ${CONFIG.logFile}`);

  // Clean up state file
  saveState();
  logStream.end();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
