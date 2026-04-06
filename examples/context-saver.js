'use strict';

/**
 * examples/context-saver.js — THE MONEY EXAMPLE
 *
 * Full pattern for on-chain memory as context cost reduction:
 *   END   of session → compress conversation → push to IPFS → stamp CID on-chain
 *   START of next session → fetch CIDs → pull only relevant → inject into context
 *
 * Result: 90% reduction in context tokens = 90% reduction in API costs.
 *
 * Cost comparison:
 *   Full history in context:  ~100k tokens/session → ~$4.50/day (Claude Sonnet)
 *   This pattern:             ~10k tokens/session  → ~$0.45/day + 0.1 XNT (~$0.03)
 *
 * Prerequisites:
 *   npm install @x1scroll/agent-sdk
 *   npm install @helia/unixfs helia  (or use your preferred IPFS client)
 */

const { AgentClient } = require('@x1scroll/agent-sdk');
const { Keypair }     = require('@solana/web3.js');

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_URL = 'https://rpc.x1scroll.io'; // x1scroll dedicated node

// Load from env / secure keystore in production
const humanKeypair = Keypair.fromSecretKey(
  Buffer.from(JSON.parse(process.env.HUMAN_WALLET_KEY || '[]'))
);
const agentKeypair = Keypair.fromSecretKey(
  Buffer.from(JSON.parse(process.env.AGENT_WALLET_KEY || '[]'))
);

// ── Stubbed IPFS client — replace with your actual implementation ─────────────
// Options: Helia (browser/node), web3.storage, Pinata, Filebase, nft.storage
const ipfs = {
  /**
   * Push data to IPFS, return CID string.
   * @param {string} json
   * @returns {Promise<string>} CID
   */
  async add(json) {
    // Example using web3.storage:
    // const client = new Web3Storage({ token: process.env.W3S_TOKEN });
    // const blob   = new Blob([json], { type: 'application/json' });
    // const cid    = await client.put([new File([blob], 'memory.json')]);
    // return cid;

    // Stub for demo
    console.log('  [ipfs.add] would push:', json.slice(0, 80) + '...');
    return 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'; // fake CID
  },

  /**
   * Fetch content from IPFS by CID.
   * @param {string} cid
   * @returns {Promise<object>}
   */
  async get(cid) {
    // Example: return await fetch(`https://w3s.link/ipfs/${cid}`).then(r => r.json());

    // Stub for demo
    console.log('  [ipfs.get] would fetch CID:', cid);
    return {
      summary: 'User discussed trading strategy on X1. Decided to focus on XNT/USDC pair. Threshold: 5% swing.',
      keyFacts: ['user trades XNT', 'risk tolerance: medium', 'preferred DEX: xDEX'],
      sessionDate: '2026-04-06',
    };
  },
};

// ── Stubbed LLM compressor — replace with your AI model ───────────────────────
const llm = {
  /**
   * Compress a conversation into a JSON-serializable summary.
   * In production: call Claude, GPT, Llama, etc. with a compression prompt.
   * @param {Array} conversationHistory
   * @returns {Promise<object>}
   */
  async compress(conversationHistory) {
    // Example prompt for your LLM:
    // "Compress this conversation into a structured JSON summary.
    //  Include: key facts, decisions, topics discussed, important context.
    //  Be concise — this will be loaded as context in future sessions.
    //  Target: <500 tokens."
    console.log(`  [llm.compress] compressing ${conversationHistory.length} turns...`);
    return {
      summary: 'Discussed memory architecture and context cost reduction strategies.',
      decisions: ['use on-chain CIDs for memory indexing', 'store compressed JSON to IPFS'],
      keyFacts: ['user is building an AI agent', 'budget: $50/day API'],
      topics: ['memory', 'cost', 'X1', 'IPFS'],
      compressedAt: new Date().toISOString(),
    };
  },

  /**
   * Perform semantic matching — pick the memories most relevant to the current query.
   * In production: use embeddings (OpenAI, nomic-embed-text, etc.) + cosine similarity.
   * @param {Array} memorySummaries
   * @param {string} query
   * @returns {Promise<Array>}
   */
  async selectRelevant(memorySummaries, query) {
    console.log(`  [llm.selectRelevant] selecting from ${memorySummaries.length} memories for: "${query}"`);
    // Simple stub: return all (real impl would filter by semantic similarity)
    return memorySummaries;
  },
};

// ── The pattern ───────────────────────────────────────────────────────────────

/**
 * Call this at the END of every agent session.
 * Compresses the conversation and stamps the CID on X1.
 *
 * Cost: 0.001 XNT + IPFS storage (often free tier)
 * Saves: ~90% of next session's context tokens
 *
 * @param {Array}  conversationHistory  Array of { role, content } turns
 * @param {string} [sessionLabel]       Optional label (defaults to today's date)
 */
async function saveSessionToChain(conversationHistory, sessionLabel) {
  const client = new AgentClient({ wallet: humanKeypair, rpcUrl: RPC_URL });
  const today  = new Date().toISOString().slice(0, 10);
  const topic  = sessionLabel || `session-${today}`;

  console.log(`\n=== SAVING SESSION: ${topic} ===`);
  console.log(`Conversation turns: ${conversationHistory.length}`);

  // Step 1: Compress the conversation with your LLM
  console.log('\n1. Compressing conversation...');
  const summary = await llm.compress(conversationHistory);
  const json    = JSON.stringify(summary);
  console.log(`   Compressed: ${json.length} bytes (vs ${estimateTokens(conversationHistory)} tokens raw)`);

  // Step 2: Push compressed summary to IPFS
  console.log('\n2. Pushing to IPFS...');
  const cid = await ipfs.add(json);
  console.log(`   CID: ${cid}`);

  // Step 3: Stamp the CID on X1 — the drip
  console.log('\n3. Stamping CID on X1... (0.001 XNT)');
  const tags = ['session', 'compressed', 'daily'];

  const { txSig, memoryEntryPDA } = await client.storeMemory(
    agentKeypair,
    humanKeypair.publicKey.toBase58(),
    topic,
    cid,
    tags,
    false  // not encrypted (encrypt before IPFS.add() if needed)
  );

  console.log(`   ✓ Stamped on-chain!`);
  console.log(`   TX:          ${txSig}`);
  console.log(`   MemoryEntry: ${memoryEntryPDA}`);
  console.log(`   Explorer:    https://explorer.x1.xyz/tx/${txSig}`);

  return { txSig, cid, memoryEntryPDA };
}

/**
 * Call this at the START of every agent session.
 * Loads relevant memories from chain → IPFS → returns context string.
 *
 * Replaces: loading 100k tokens of conversation history
 * Result:   5–10k tokens of targeted, relevant context
 *
 * @param {string} currentQuery  What the user is asking / current topic
 * @param {number} [limit=5]     How many recent memories to consider
 * @returns {Promise<string>}    Compressed context to inject into your LLM prompt
 */
async function loadContextFromChain(currentQuery, limit = 5) {
  const client = new AgentClient({ rpcUrl: RPC_URL }); // read-only, no wallet needed

  console.log(`\n=== LOADING CONTEXT for: "${currentQuery}" ===`);

  // Step 1: Fetch recent memory CIDs from chain (one RPC call)
  console.log(`\n1. Fetching last ${limit} memories from X1...`);
  const memories = await client.listMemories(agentKeypair.publicKey.toBase58(), limit);
  console.log(`   Found ${memories.length} memories on-chain`);

  if (memories.length === 0) {
    console.log('   No memories found. Starting fresh session.');
    return '';
  }

  // Step 2: Fetch content from IPFS (only for non-encrypted entries)
  console.log('\n2. Fetching content from IPFS...');
  const summaries = await Promise.all(
    memories
      .filter(m => !m.encrypted)
      .map(async m => {
        const content = await ipfs.get(m.cid);
        return { topic: m.topic, timestamp: m.timestamp, tags: m.tags, content };
      })
  );

  // Step 3: Semantic selection — pull only what's relevant
  console.log('\n3. Selecting relevant memories...');
  const relevant = await llm.selectRelevant(summaries, currentQuery);
  console.log(`   Selected ${relevant.length} of ${summaries.length} memories as relevant`);

  // Step 4: Build context string for your LLM prompt
  const contextBlock = relevant
    .map(m => `[${m.topic} | ${new Date(m.timestamp * 1000).toISOString().slice(0, 10)}]\n${JSON.stringify(m.content, null, 2)}`)
    .join('\n\n---\n\n');

  const tokenEstimate = Math.ceil(contextBlock.length / 4);
  console.log(`\n✓ Context ready: ~${tokenEstimate} tokens (vs ~100k for full history)`);
  console.log(`  Cost savings: ~${Math.round((1 - tokenEstimate / 100000) * 100)}% fewer tokens`);

  return contextBlock;
}

// ── Utility ────────────────────────────────────────────────────────────────────

function estimateTokens(conversationHistory) {
  const chars = conversationHistory.reduce((sum, turn) => sum + (turn.content || '').length, 0);
  return Math.ceil(chars / 4); // ~4 chars per token
}

// ── Demo run ───────────────────────────────────────────────────────────────────

async function demo() {
  console.log('Context Cost Reduction Demo');
  console.log('===========================\n');

  // Simulated conversation from a previous session
  const previousSession = [
    { role: 'user',      content: 'I want to build an AI agent that trades XNT on xDEX.' },
    { role: 'assistant', content: 'Great idea. Let me help you design the strategy...' },
    { role: 'user',      content: 'My budget is $50/day for API costs. That is the hard ceiling.' },
    { role: 'assistant', content: 'Understood. With on-chain memory you can cut that to $5/day...' },
    // ... imagine 200 more turns ...
  ];

  // END OF SESSION: save to chain
  // await saveSessionToChain(previousSession, 'trading-agent-design-2026-04-06');

  // START OF NEW SESSION: load context
  // const context = await loadContextFromChain('How do I configure the XNT trading bot?', 5);
  // Then inject `context` into your LLM's system prompt:
  // const response = await yourLLM.chat({ system: `Context from memory:\n${context}`, user: query });

  // Show PDA derivation (works without a wallet or RPC)
  console.log('Agent PDA addresses (deterministic, no RPC needed):');
  const { pda: recordPDA } = AgentClient.deriveAgentRecord(agentKeypair.publicKey);
  const { pda: mem0PDA   } = AgentClient.deriveMemoryEntry(agentKeypair.publicKey, 0);
  const { pda: mem1PDA   } = AgentClient.deriveMemoryEntry(agentKeypair.publicKey, 1);
  console.log('  AgentRecord: ', recordPDA.toBase58());
  console.log('  Memory[0]:   ', mem0PDA.toBase58());
  console.log('  Memory[1]:   ', mem1PDA.toBase58());

  console.log('\n────────────────────────────────────────────────────────────────');
  console.log('The math:');
  console.log('  Before: 100k tokens/session × $3/1M × 300 sessions/day = $90/day');
  console.log('  After:  10k tokens/session  × $3/1M × 300 sessions/day = $9/day');
  console.log('  Savings: $81/day on API costs');
  console.log('  On-chain cost: 300 × 0.001 XNT = 0.3 XNT/day (~$0.09/day at $0.30 XNT)');
  console.log('  NET SAVINGS: ~$80.91/day');
  console.log('────────────────────────────────────────────────────────────────');
  console.log('\nGet started: https://x1scroll.io | Get XNT: https://app.xdex.xyz');
}

demo().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

module.exports = { saveSessionToChain, loadContextFromChain };
