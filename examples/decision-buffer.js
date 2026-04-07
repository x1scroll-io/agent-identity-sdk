'use strict';
/**
 * DecisionBuffer Example — batch decision writes for Citizens City stress test
 *
 * Packs up to 5 decision_write instructions per transaction.
 * Use this pattern for high-volume agent loops.
 *
 * Run: node examples/decision-buffer.js
 */

const { AgentClient, DecisionBuffer } = require('../src/index');
const { Keypair }                       = require('@solana/web3.js');
const fs                                = require('fs');

// ── Load agent keypair ────────────────────────────────────────────────────────
// Replace with your agent's keypair path
const keypairPath = process.env.AGENT_KEYPAIR || '/root/.openclaw/workspace/memory/keys/stamp_agent.json';
const secretKey   = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
const agentKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));

// ── Setup ─────────────────────────────────────────────────────────────────────
const client = new AgentClient({
  rpcUrl: 'https://x1scroll.io/rpc',
});

const buffer = new DecisionBuffer(client, agentKeypair, {
  maxBatch: 5,                    // pack 5 decisions per transaction
  onFlush: (results) => {
    for (const r of results) {
      if (r.error) {
        console.error(`[buffer] Flush error: ${r.error.message}`);
      } else {
        console.log(`[buffer] Flushed ${r.decisions.length} decisions → tx: ${r.txSig}`);
      }
    }
  },
  onError: (err) => {
    console.error('[buffer] Unhandled flush error:', err.message);
  },
});

// ── Example 1: Manual batch ───────────────────────────────────────────────────
async function exampleManual() {
  console.log('\n── Manual batch (5 decisions, 1 tx) ──');

  buffer
    .add('trade',    'scanned XNT/USDC pool — spread at 0.002 XNT')
    .add('trade',    'bought 50 XNT at 0.343 — momentum signal')
    .add('risk',     'position size: 50 XNT / 500 XNT max — within limits')
    .add('market',   'BOT_B sell pattern detected at 02:14 UTC — expected')
    .add('strategy', 'holding — exit target 0.38, stop at 0.32');

  // Buffer hits maxBatch=5 → auto-flushes. Or call manually:
  const results = await buffer.flush();

  for (const r of results) {
    if (r.error) {
      console.error('Error:', r.error.message);
    } else {
      console.log(`✅ ${r.decisions.length} decisions in 1 tx: ${r.txSig}`);
      for (const d of r.decisions) {
        console.log(`   [${d.branchLabel}] hash: ${d.decisionHash?.slice(0, 16)}... pda: ${d.pda}`);
      }
    }
  }
}

// ── Example 2: Auto-flush on interval (agent loop pattern) ───────────────────
async function exampleAgentLoop() {
  console.log('\n── Agent loop (auto-flush every 10s) ──');

  // Start flush interval — flushes every 10 seconds regardless of size
  buffer.start(10_000);

  // Simulate agent adding decisions over time
  for (let i = 0; i < 12; i++) {
    buffer.add('loop', `iteration ${i} — scanned pool, price: ${(0.34 + Math.random() * 0.02).toFixed(4)}`);
    console.log(`[agent] buffered decision ${i + 1}, queue size: ${buffer.size}`);
    await new Promise(r => setTimeout(r, 500)); // 500ms between decisions
  }

  // Final flush + stop
  await buffer.flush();
  buffer.stop();
  console.log('Agent loop done.');
}

// ── Example 3: flushAndWait (simple one-liner) ────────────────────────────────
async function exampleOneliner() {
  console.log('\n── One-liner flush ──');

  buffer
    .add('signal', 'price crossed 0.37 threshold')
    .add('signal', 'volume spike — 3x 5min average')
    .add('action', 'placed limit sell at 0.38');

  const sigs = await buffer.flushAndWait();
  console.log('Tx signatures:', sigs);
}

// ── Run ───────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await exampleManual();
    // await exampleAgentLoop();
    // await exampleOneliner();
  } catch (err) {
    console.error('Fatal:', err.message);
    process.exit(1);
  }
})();
