/**
 * Citizens City Stress Test — FIXED for current SDK API
 * 
 * Key SDK changes since original script:
 * - register(humanKeypair, agentId, memoryCid, manifestCid) — no separate agentKp
 *   Each agent IS its own authority; fund agents first, then register with their own keypair
 * - decisionWrite(humanKeypair, branchLabel, cid) — agentKp is the authority
 * - DecisionBuffer has agentId seed mismatch bug — use manual batching via decisionWrite
 * 
 * Run: node sim/cc_fixed_50.mjs
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { AgentClient }            = require('../src/index.js');
const { Keypair, Connection, Transaction, SystemProgram } = require('@solana/web3.js');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
  rpcUrl:        process.env.RPC_URL        || 'https://rpc.x1scroll.io',
  humanWallet:   process.env.HUMAN_WALLET   || './wallet.json',
  numAgents:     parseInt(process.env.NUM_AGENTS   || '50'),
  decisionsEach: 10,
  roundIntervalMs: 5000,   // 5s between rounds (stress test, not production cadence)
  maxRounds:     parseInt(process.env.MAX_ROUNDS || '3'),
  logFile:       process.env.LOG_FILE   || '/root/.openclaw/workspace/memory/citizens_city_sim.log',
  stateFile:     process.env.STATE_FILE || '/root/.openclaw/workspace/memory/citizens_city_sim_state.json',
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

function loadKeypair(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (raw.secret_b58) return Keypair.fromSecretKey(bs58decode(raw.secret_b58));
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

function randomBehavior() { return BEHAVIORS[Math.floor(Math.random() * BEHAVIORS.length)]; }
function randomMessage(b)  { return b.messages[Math.floor(Math.random() * b.messages.length)]; }

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  startedAt:      null,
  round:          0,
  totalDecisions: 0,
  totalTxns:      0,
  totalFeeXNT:    0,
  errors:         0,
  registeredCount: 0,
  failedCount:    0,
  // Stored as "<comma-sk>|<agentId>" per registered agent
  agentEntries:   [],
};

function saveState() {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('=== Citizens City Stress Test (FIXED API) STARTING ===');
  log(`Config: ${CONFIG.numAgents} agents, ${CONFIG.decisionsEach} decisions/round, maxRounds=${CONFIG.maxRounds}`);

  const humanKeypair = loadKeypair(CONFIG.humanWallet);
  const conn = new Connection(CONFIG.rpcUrl, 'confirmed');

  const balBefore = await conn.getBalance(humanKeypair.publicKey);
  const xntBefore = balBefore / 1e9;
  log(`Human wallet: ${humanKeypair.publicKey.toBase58()}`);
  log(`Balance BEFORE: ${xntBefore.toFixed(4)} XNT`);

  if (xntBefore < 5) {
    log('ERROR: Insufficient balance — need at least 5 XNT');
    process.exit(1);
  }

  // We use humanKeypair to fund each agent; then each agent registers itself
  const humanClient = new AgentClient({ rpcUrl: CONFIG.rpcUrl, wallet: humanKeypair });

  state.startedAt = new Date().toISOString();

  // ── Phase 1: Register agents ───────────────────────────────────────────────
  log(`\n── Phase 1: Registering ${CONFIG.numAgents} agents ──`);

  const agentKeypairs = []; // { kp, agentId }
  let regSuccess = 0;
  let regFailed  = 0;

  for (let i = 0; i < CONFIG.numAgents; i++) {
    const agentKp  = Keypair.generate();
    const agentId  = `CC-${i.toString().padStart(3, '0')}`;
    const shortPub = agentKp.publicKey.toBase58().slice(0, 12);

    // Step 1: Fund the agent keypair (0.2 XNT — covers reg fee 0.05 + ~100 decisions)
    try {
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: humanKeypair.publicKey,
          toPubkey:   agentKp.publicKey,
          lamports:   200_000_000, // 0.2 XNT
        })
      );
      await humanClient._sendAndConfirm(fundTx, [humanKeypair]);
    } catch (err) {
      log(`  ❌ Fund failed [${agentId}]: ${err.message.slice(0, 80)}`);
      regFailed++;
      state.errors++;
      continue;
    }

    // Step 2: Register with agent's OWN keypair as authority (new SDK API)
    try {
      const agentClient = new AgentClient({ rpcUrl: CONFIG.rpcUrl, wallet: agentKp });
      const { txSig, agentRecordPDA } = await agentClient.register(
        agentKp,
        agentId,
        'QmSimStart000000000000000000000000000000000000',
        'QmSimManifest000000000000000000000000000000000'
      );
      log(`  ✅ ${agentId} | ${shortPub}... | PDA: ${agentRecordPDA.slice(0, 12)}... | tx: ${txSig.slice(0, 16)}...`);
      agentKeypairs.push({ kp: agentKp, agentId });
      state.agentEntries.push(Array.from(agentKp.secretKey).join(',') + '|' + agentId);
      regSuccess++;
      saveState();
    } catch (err) {
      log(`  ❌ Register failed [${agentId}]: ${err.message.slice(0, 100)}`);
      regFailed++;
      state.errors++;
    }

    // Small delay — avoid hammering RPC
    await new Promise(r => setTimeout(r, 600));
  }

  state.registeredCount = regSuccess;
  state.failedCount     = regFailed;
  saveState();

  log(`\nRegistration complete: ${regSuccess} succeeded, ${regFailed} failed`);

  if (agentKeypairs.length === 0) {
    log('FATAL: No agents registered — aborting');
    process.exit(1);
  }

  // ── Phase 2: Decision rounds ───────────────────────────────────────────────
  log(`\n── Phase 2: ${CONFIG.maxRounds} decision rounds ──`);

  let running = true;
  process.on('SIGINT',  () => { log('\nSIGINT received — stopping after this round'); running = false; });
  process.on('SIGTERM', () => { log('\nSIGTERM received — stopping after this round'); running = false; });

  while (running && state.round < CONFIG.maxRounds) {
    state.round++;
    log(`\n── Round ${state.round}/${CONFIG.maxRounds} ──`);

    let roundDecisions = 0;
    let roundTxns      = 0;
    let roundErrors    = 0;

    for (const { kp: agentKp, agentId } of agentKeypairs) {
      if (!running) break;

      const agentClient = new AgentClient({ rpcUrl: CONFIG.rpcUrl, wallet: agentKp });
      const shortPub    = agentKp.publicKey.toBase58().slice(0, 8);
      let agentDec = 0;
      let agentTxn = 0;

      for (let d = 0; d < CONFIG.decisionsEach; d++) {
        const behavior = randomBehavior();
        const msg      = `[R${state.round}] ${randomMessage(behavior)}`;
        // CID: sha256 of message truncated to 48 chars, with msg: prefix = 52 chars (< 64)
        const cid = 'msg:' + crypto.createHash('sha256').update(msg).digest('hex').slice(0, 44);

        try {
          await agentClient.decisionWrite(agentKp, behavior.branch, cid);
          agentDec++;
          agentTxn++;
          // Small delay per decision to avoid rate limiting
          await new Promise(r => setTimeout(r, 100));
        } catch (err) {
          log(`  ❌ [${shortPub}] decision ${d}: ${err.message.slice(0, 80)}`);
          roundErrors++;
          state.errors++;
          break; // skip remaining decisions for this agent if error
        }
      }

      if (agentTxn > 0) {
        log(`  [${shortPub}] ${agentDec}/${CONFIG.decisionsEach} decisions written`);
      }

      roundDecisions += agentDec;
      roundTxns      += agentTxn;
    }

    state.totalDecisions += roundDecisions;
    state.totalTxns      += roundTxns;
    state.totalFeeXNT    += roundTxns * 0.001;
    saveState();

    log(`  Round ${state.round} summary: ${roundDecisions} decisions, ${roundTxns} txns, ${roundErrors} errors`);
    log(`  Running totals: ${state.totalDecisions} decisions | ${state.totalTxns} txns | ~${state.totalFeeXNT.toFixed(3)} XNT fees | ${state.errors} errors`);

    if (running && state.round < CONFIG.maxRounds) {
      log(`  Waiting ${CONFIG.roundIntervalMs / 1000}s...`);
      await new Promise(r => setTimeout(r, CONFIG.roundIntervalMs));
    }
  }

  // ── Final report ────────────────────────────────────────────────────────────
  const balAfter  = await conn.getBalance(humanKeypair.publicKey);
  const xntAfter  = balAfter / 1e9;
  const xntSpent  = xntBefore - xntAfter;

  const durationMs  = Date.now() - new Date(state.startedAt).getTime();
  const durationMin = (durationMs / 60000).toFixed(1);

  log('\n=== STRESS TEST COMPLETE ===');
  log(`Duration:            ${durationMin} minutes`);
  log(`Agents registered:   ${regSuccess}/${CONFIG.numAgents}`);
  log(`Registration errors: ${regFailed}`);
  log(`Rounds completed:    ${state.round}`);
  log(`Total decisions:     ${state.totalDecisions}`);
  log(`Total txns:          ${state.totalTxns}`);
  log(`Total errors:        ${state.errors}`);
  log(`Treasury balance before: ${xntBefore.toFixed(4)} XNT`);
  log(`Treasury balance after:  ${xntAfter.toFixed(4)} XNT`);
  log(`Total XNT spent:     ~${xntSpent.toFixed(4)} XNT`);
  log(`Est. fee spent:      ~${state.totalFeeXNT.toFixed(3)} XNT (decisions only)`);
  log(`State file:          ${CONFIG.stateFile}`);
  log(`Log file:            ${CONFIG.logFile}`);

  saveState();
  logStream.end();
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
});
