'use strict';

/**
 * examples/basic.js
 *
 * Basic Agent Identity Protocol demo:
 * 1. Register an agent on-chain
 * 2. Store a memory entry
 * 3. Read the agent record back
 * 4. List memories
 *
 * Prerequisites:
 *   - npm install @x1scroll/agent-sdk
 *   - Human wallet funded with at least 0.1 XNT
 *   - Agent wallet funded with at least 0.01 XNT (for memory fee + rent)
 */

const { AgentClient } = require('@x1scroll/agent-sdk');
const { Keypair, Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js');

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_URL = 'https://rpc.x1.xyz';

// In production, load these from env vars or a secure keystore — never hardcode
// For this demo, we generate ephemeral keypairs (they'll have no balance)
const humanKeypair = Keypair.generate();  // wallet that owns the agent
const agentKeypair = Keypair.generate();  // the agent's identity keypair

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Agent Identity Protocol — Basic Example\n');
  console.log('Human wallet: ', humanKeypair.publicKey.toBase58());
  console.log('Agent wallet: ', agentKeypair.publicKey.toBase58());
  console.log('');

  const client = new AgentClient({
    wallet: humanKeypair,
    rpcUrl: RPC_URL,
  });

  // ── Step 1: Register the agent ────────────────────────────────────────────
  console.log('Step 1: Registering agent...');
  console.log('  Fee: 0.05 XNT (paid automatically)');

  // NOTE: Your humanKeypair needs 0.05 XNT + rent for the AgentRecord account
  // For this demo we skip the actual tx — uncomment below when you have a funded wallet

  /*
  const { txSig, agentRecordPDA } = await client.register(
    agentKeypair,                             // agent MUST co-sign (anti-squatting)
    'aria-v1',                                // name (max 32 chars)
    'ipfs://bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'  // metadata URI
  );
  console.log('  ✓ Registered!');
  console.log('  TX:            ', txSig);
  console.log('  AgentRecord:   ', agentRecordPDA);
  */

  // ── Step 2: Store a memory ────────────────────────────────────────────────
  console.log('\nStep 2: Storing a memory...');
  console.log('  Fee: 0.001 XNT (paid automatically by the agent)');

  // NOTE: Your agentKeypair needs 0.001 XNT + rent for the MemoryEntry account

  /*
  const { txSig: memTx, memoryEntryPDA } = await client.storeMemory(
    agentKeypair,                             // agent signs and pays
    humanKeypair.publicKey.toBase58(),        // human wallet (for PDA lookup)
    'session-2026-04-06',                     // topic label
    'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',  // IPFS CID
    ['session', 'daily'],                     // tags (max 5)
    false                                     // encrypted?
  );
  console.log('  ✓ Memory stored!');
  console.log('  TX:          ', memTx);
  console.log('  MemoryEntry: ', memoryEntryPDA);
  */

  // ── Step 3: Read the agent record ─────────────────────────────────────────
  console.log('\nStep 3: Reading agent from chain...');

  /*
  const agentRecord = await client.getAgent(agentKeypair.publicKey.toBase58());
  console.log('  Agent record:');
  console.log('    Name:         ', agentRecord.name);
  console.log('    Human:        ', agentRecord.human);
  console.log('    Memory count: ', agentRecord.memoryCount);
  console.log('    Created at:   ', new Date(agentRecord.createdAt * 1000).toISOString());
  */

  // ── Step 4: List memories ─────────────────────────────────────────────────
  console.log('\nStep 4: Listing memories (most recent first)...');

  /*
  const memories = await client.listMemories(agentKeypair.publicKey.toBase58(), 10);
  console.log(`  Found ${memories.length} memories:`);
  for (const mem of memories) {
    console.log(`  [${mem.topic}] CID: ${mem.cid} | Tags: ${mem.tags.join(', ')} | ${new Date(mem.timestamp * 1000).toISOString()}`);
  }
  */

  // ── PDA derivation (no RPC needed) ────────────────────────────────────────
  console.log('\nBonus: PDA derivation (no wallet or RPC needed):');

  const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(agentKeypair.publicKey);
  const { pda: memory0PDA }     = AgentClient.deriveMemoryEntry(agentKeypair.publicKey, 0);

  console.log('  AgentRecord PDA (index 0):   ', agentRecordPDA.toBase58());
  console.log('  MemoryEntry PDA (memory 0):  ', memory0PDA.toBase58());

  console.log('\n✓ Done. Fund your wallets with XNT and uncomment the transaction calls above.');
  console.log('  Get XNT: https://app.xdex.xyz');
  console.log('  Explorer: https://explorer.x1.xyz');
}

main().catch(err => {
  console.error('Error:', err.message);
  if (err.code) console.error('Code:', err.code);
  process.exit(1);
});
