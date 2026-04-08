# Agent Identity Protocol

**The standard for persistent agent identity and on-chain memory on X1 blockchain.**

[![A2A Protocol](https://github.com/x1scroll-io/agent-identity-sdk/actions/workflows/a2a-sim.yml/badge.svg)](https://github.com/x1scroll-io/agent-identity-sdk/actions/workflows/a2a-sim.yml)
[![npm version](https://img.shields.io/npm/v/@x1scroll/agent-sdk?color=blue&label=npm)](https://www.npmjs.com/package/@x1scroll/agent-sdk)
[![License: BSL-1.1](https://img.shields.io/badge/License-BSL--1.1-orange.svg)](./LICENSE)
[![X1 Mainnet](https://img.shields.io/badge/X1-Mainnet-green.svg)](https://explorer.x1.xyz)

---

## Why Use This?

- **Your agent's memory lives on X1** — permanent, verifiable, owned by your wallet. No database to maintain. No vendor lock-in.
- **Model-neutral** — works with any AI: Claude Sonnet, GPT-4o, Llama, Gemini, or your local model. The SDK doesn't care what's generating the memories.
- **Frictionless** — fees are automatic, built into every call. Developers don't configure fees. Just call `storeMemory()` and you're done.
- **0.001 XNT per memory** — that's less than a fraction of a cent. The cheapest persistent storage in the AI ecosystem.
- **Creates XNT buy pressure** — every agent running this SDK generates real demand for XNT. Good for the whole ecosystem.

---

## Install

```bash
npm install @x1scroll/agent-sdk
```

**Requirements:** Node.js 18+ | X1 wallet funded with XNT

---

## Quick Start

```js
const { AgentClient, Keypair } = require('@x1scroll/agent-sdk');

const human = Keypair.generate();          // your wallet (must have XNT)
const agent = Keypair.generate();          // the agent's keypair

const client = new AgentClient({ wallet: human, rpcUrl: 'https://rpc.x1.xyz' });

const { txSig, agentRecordPDA } = await client.register(agent, 'my-agent', 'ipfs://Qm...');
const { txSig: memTx }          = await client.storeMemory(agent, human.publicKey.toBase58(), 'session-1', 'bafyQm...', ['daily']);
const memories                  = await client.listMemories(agent.publicKey, 5);
```

---

## Full API Reference

### `new AgentClient({ wallet, rpcUrl })`

Create a client instance.

| Param | Type | Description |
|-------|------|-------------|
| `wallet` | `Keypair \| string \| null` | Human/operator wallet — Keypair object or base58 secret key. Pass `null` for read-only. |
| `rpcUrl` | `string` | X1 RPC endpoint. Default: `https://rpc.x1.xyz`. Use `https://rpc.x1scroll.io` for our dedicated node. |

---

### `client.register(agentKeypair, name, metadataUri)`

Register a new agent identity on-chain.

**Fee:** 0.05 XNT (automatic — paid by the human wallet)

The `agentKeypair` **must** be a real keypair (has `secretKey`). This co-sign requirement prevents PDA squatting — nobody can register your agent's identity address except the real key.

| Param | Type | Constraint |
|-------|------|------------|
| `agentKeypair` | `Keypair` | Must be a Signer (has secretKey) |
| `name` | `string` | Max 32 chars, no null bytes |
| `metadataUri` | `string` | Max 128 chars, no null bytes |

**Returns:** `Promise<{ txSig: string, agentRecordPDA: string }>`

```js
const { txSig, agentRecordPDA } = await client.register(
  agentKeypair,
  'aria-v1',
  'ipfs://bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
);
```

---

### `client.storeMemory(agentKeypair, agentRecordHuman, topic, cid, tags?, encrypted?)`

Store a memory entry on-chain. This is **THE DRIP** — 0.001 XNT per drop.

**Fee:** 0.001 XNT (automatic — paid by the agent keypair)

The pattern: compress conversation → push to IPFS → call `storeMemory(CID)`. Next session, you pull only the CIDs you need.

| Param | Type | Constraint |
|-------|------|------------|
| `agentKeypair` | `Keypair` | Agent's keypair — must be a Signer |
| `agentRecordHuman` | `string` | Human wallet address that owns this agent |
| `topic` | `string` | Label for this memory (max 64 chars) |
| `cid` | `string` | IPFS CID of the memory content (max 64 chars) |
| `tags` | `string[]` | Optional. Max 5 tags, each max 32 chars |
| `encrypted` | `boolean` | Optional. Whether IPFS content is encrypted. Default: `false` |

**Returns:** `Promise<{ txSig: string, memoryEntryPDA: string }>`

```js
const { txSig, memoryEntryPDA } = await client.storeMemory(
  agentKeypair,
  humanWallet.publicKey.toBase58(),
  'session-2026-04-06',
  'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  ['session', 'daily', 'compressed'],
  false
);
```

---

### `client.uploadMemory(agentKeypair, agentRecordHuman, topic, content, options?)`

**The easy path** — handles IPFS upload, pinning, and on-chain storage in one call. No IPFS knowledge required.

**Fee:** 0.001 XNT (same as `storeMemory`)

By default, content is pinned to the **x1scroll validator network** — no API key, no configuration needed. Pinata is available as an alternative for production workloads requiring independent pinning.

```js
// Default: pinned to x1scroll validator network (zero config)
const { txSig, cid } = await client.uploadMemory(
  agentKeypair,
  humanWallet.publicKey.toBase58(),
  'session-2026-04-06',
  { summary: 'Discussed SDK launch', decisions: ['publish to npm', 'BSL license'] },
  { tags: ['session', 'daily'] }
);

// Alternative: Pinata (bring your own key)
const { txSig, cid } = await client.uploadMemory(
  agentKeypair,
  humanWallet.publicKey.toBase58(),
  'session-2026-04-06',
  { summary: 'Discussed SDK launch' },
  { provider: 'pinata', pinataJwt: process.env.PINATA_JWT }
);
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `provider` | `string` | `'x1scroll'` | `'x1scroll'` (validator network) or `'pinata'` |
| `pinataJwt` | `string` | — | Required only if provider is `'pinata'` |
| `tags` | `string[]` | `[]` | Up to 5 tags |
| `encrypted` | `boolean` | `false` | Whether content is encrypted |

**Returns:** `Promise<{ txSig: string, memoryEntryPDA: string, cid: string }>`

> **Use `uploadMemory()` for zero-config IPFS pinning.** Content is pinned to x1scroll validator infrastructure — as long as X1 runs, your agent remembers. Use `storeMemory()` directly if you manage your own pinning.

---

### `client.updateAgent(humanKeypair, agentPubkey, name, metadataUri)`

Update an agent's name and metadata URI. Only the human owner can call this.

**Fee:** Free (network tx fee only)

| Param | Type | Constraint |
|-------|------|------------|
| `humanKeypair` | `Keypair` | Current human owner — must be a Signer |
| `agentPubkey` | `PublicKey \| string` | The agent's public key |
| `name` | `string` | Max 32 chars |
| `metadataUri` | `string` | Max 128 chars |

**Returns:** `Promise<{ txSig: string }>`

---

### `client.transferAgent(humanKeypair, agentPubkey, newHuman)`

Transfer agent ownership to a new human wallet.

**Fee:** 0.01 XNT (automatic — paid by the current human owner)

| Param | Type | Description |
|-------|------|-------------|
| `humanKeypair` | `Keypair` | Current owner — must be a Signer |
| `agentPubkey` | `PublicKey \| string` | The agent's public key |
| `newHuman` | `PublicKey \| string` | New owner's public key |

**Returns:** `Promise<{ txSig: string }>`

> ⚠️ The AgentRecord PDA address is stable through transfers — derived from the agent's keypair, not the human's. Memories remain attached to the agent regardless of ownership changes.

---

### `client.getAgent(agentPubkey)`

Fetch an agent's on-chain identity record.

| Param | Type |
|-------|------|
| `agentPubkey` | `PublicKey \| string` |

**Returns:**
```js
{
  pda: string,          // AgentRecord PDA address
  human: string,        // Current owner wallet
  agentPubkey: string,  // Agent's public key
  name: string,
  metadataUri: string,
  createdAt: number,    // Unix timestamp
  memoryCount: number,  // Total memories stored
  lastActive: number,   // Last activity timestamp
  bump: number
}
```

---

### `client.getMemory(agentPubkey, index)`

Fetch a single memory entry at a given index.

| Param | Type | Description |
|-------|------|-------------|
| `agentPubkey` | `PublicKey \| string` | The agent's public key |
| `index` | `number` | Memory index (0-based) |

**Returns:**
```js
{
  pda: string,       // MemoryEntry PDA address
  agent: string,     // Agent public key
  topic: string,     // Memory label
  cid: string,       // IPFS CID
  tags: string[],    // Up to 5 tags
  encrypted: boolean,
  timestamp: number, // Unix timestamp
  slot: number,      // X1 slot when stored
  bump: number
}
```

---

### `client.listMemories(agentPubkey, limit?)`

Fetch multiple memories, most recent first. Uses batch RPC for efficiency.

| Param | Type | Description |
|-------|------|-------------|
| `agentPubkey` | `PublicKey \| string` | The agent's public key |
| `limit` | `number` | Max entries to return. Default: `10` |

**Returns:** `Promise<MemoryEntry[]>` — array of decoded memory objects, newest first.

---

### `AgentClient.deriveAgentRecord(agentPubkey, programId?)`

Static helper — derive the AgentRecord PDA without constructing a client.

**Returns:** `{ pda: PublicKey, bump: number }`

---

### `AgentClient.deriveMemoryEntry(agentPubkey, memoryCount, programId?)`

Static helper — derive a MemoryEntry PDA at a specific index.

**Returns:** `{ pda: PublicKey, bump: number }`

---

## 🧠 Context Cost Reduction Guide

This is the real reason to use this SDK. **On-chain memory = 90% API cost reduction.**

### The Problem

LLM context windows are expensive:
- Claude Sonnet: **$3/M tokens**
- Storing all conversation history in context = **$10–50/day** for active agents
- Every session restart re-loads everything = massive token burn
- Your agent's memory disappears when the process dies

### The Solution — On-Chain Memory as External Storage

```
Instead of:                          Use this:
┌───────────────────────────┐        ┌──────────────────────────────┐
│   Full history in context  │   →   │  Compressed summary          │
│   100k tokens/session      │        │  + On-chain CIDs             │
│   ~$1.50/hr                │        │  + Fetch only what's needed  │
└───────────────────────────┘        │  ~5–10k tokens/session       │
                                     │  ~$0.05/hr                   │
                                     └──────────────────────────────┘
```

### How It Works

1. **Agent processes a conversation** → compress key facts to IPFS → call `storeMemory(CID)` *(0.001 XNT)*
2. **Next session starts** → call `listMemories(agentPubkey, 5)` → get last 5 CIDs → fetch only the relevant ones
3. **Semantic search** → pull only what's needed for the current context
4. **Result:** 90% context reduction = 90% API cost reduction

### Cost Math

| Approach | Tokens/session | API cost/day | On-chain cost/day |
|----------|---------------|--------------|-------------------|
| Full history in context | 100k | ~$4.50 | $0 |
| On-chain memory (this SDK) | 10k | ~$0.45 | ~0.1 XNT (~$0.03) |
| **Savings** | **90% less** | **~$4.05/day** | **pays for itself in an hour** |

### The Code Pattern

```js
const { AgentClient } = require('@x1scroll/agent-sdk');

// ── END OF SESSION — compress and store ──────────────────────────────────────
const summary = await myLLM.compress(conversationHistory);
const cid     = await ipfs.add(JSON.stringify(summary));

await client.storeMemory(
  agentKeypair,
  humanWallet.toBase58(),
  `session-${new Date().toISOString().slice(0, 10)}`,
  cid,
  ['session', 'daily']
);
// Cost: 0.001 XNT (~$0.0003). Saved: ~$4.50 in context fees.

// ── START OF NEXT SESSION — load only what's needed ──────────────────────────
const memories = await client.listMemories(agentPubkey, 5);        // last 5 memories
const relevant = await fetchRelevantFromIPFS(memories, currentQuery); // semantic filter

// Inject only the relevant CIDs — 5k tokens instead of 100k
const context = relevant.map(m => m.content).join('\n\n');
```

### The Flywheel

```
You save $4/day on API costs
    ↓
You spend ~$0.03/day on XNT memory drops
    ↓
X1 ecosystem gets real utility + buy pressure
    ↓
x1scroll.io indexes your agent's memory for semantic search
    ↓
Your agent gets smarter. Every session.
```

---

## ⚠️ IPFS Pinning — Read This First

`storeMemory()` stores a **pointer** (CID) on-chain — not the content itself. The on-chain record is permanent. The content is only as permanent as your IPFS pin.

**If you don't pin the CID, your content can disappear. The on-chain record will still exist, but it will point to nothing.**

### Pin your CIDs (pick one):

**Pinata (easiest):**
```js
const pinata = new PinataSDK({ pinataJwt: process.env.PINATA_JWT });
const { IpfsHash } = await pinata.upload.json(memoryObject);
// IpfsHash is your CID — it's already pinned
await client.storeMemory(agentKeypair, human, topic, IpfsHash, tags);
```

**Filebase (S3-compatible, cheap):**
```js
// Upload to Filebase bucket → get CID → pin is automatic
```

**Self-hosted (advanced):**
```bash
ipfs pin add <CID>
```

**What the chain gives you:**
- Immutable, ordered index of memory events
- Ownership + transferability
- XNT-gated writes (spam resistance)
- No single point of failure for the *record*

**What you must provide:**
- IPFS content pinning (Pinata, Filebase, or your own node)
- x1scroll.io indexes pinned memories for semantic search — use our RPC for full retrieval stack

---

## Fee Structure

| Action | XNT Cost | Why |
|--------|----------|-----|
| Register agent | 0.05 XNT | One-time identity creation |
| Store memory | 0.001 XNT | Per memory drop (the drip) |
| Update agent | 0 XNT | Free — just network fee |
| Transfer agent | 0.01 XNT | Ownership change |

Fees are **automatic** — built into the on-chain instructions. Developers don't configure or calculate them.

---

## Security

The SDK implements several hardened security features to ensure reliable, tamper-resistant memory storage:

### Multi-Validator Pinning (5 Simultaneous)

When using the `x1scroll` provider, content is pinned to **up to 5 validators simultaneously** using `Promise.allSettled`. The first successful CID is used — if any validator succeeds, the upload proceeds. This eliminates single points of failure and ensures resilience against validator downtime.

```
Upload → [Validator 1] ✓ CID returned  ← used
          [Validator 2] ✓ CID returned
          [Validator 3] ✗ Failed        ← ignored (others succeeded)
          ...
```

If **all** validators fail, an `AgentSDKError` with code `PIN_FAILED` is thrown.

### Automatic Fallback to x1scroll.io

If the on-chain validator registry is unreachable or empty, the SDK automatically falls back to `https://x1scroll.io/api/ipfs/upload` — no configuration needed. Uploads will succeed even if the registry program hasn't been deployed yet.

### CID Verification After Upload

After a successful pin, the SDK verifies the CID is reachable on the public IPFS gateway (`https://ipfs.io/ipfs/<cid>`) using a HEAD request with an 8-second timeout. This is **non-fatal** — if verification fails, a warning is logged and the `verified: false` flag is returned in the response. Content may still propagate to the gateway within minutes.

```js
const { cid, verified } = await client.uploadMemory(...);
if (!verified) {
  // Content pinned, but not yet visible on public gateway — normal for new pins
}
```

### Registry Cache (5-Minute TTL)

The active validator list is cached in memory for **5 minutes** to avoid hammering the on-chain registry on every upload. The cache is per-client-instance and invalidates automatically after TTL expiry.

---

## Protocol Info

| Field | Value |
|-------|-------|
| Program ID | `52EW3sn2Tkq6EMnp86JWUzXrNzrFujpdEgovsjwapbAM` |
| Treasury | `HYP2VdVk2QNGKMBfWGFZpaFqMoqQkB7Vp5F12eSxCxtf` |
| Network | X1 Mainnet |
| Explorer | [explorer.x1.xyz](https://explorer.x1.xyz) |
| License | BSL-1.1 (free to use, no commercial forks) |
| Change Date | 2028-01-01 → Apache-2.0 |

---

## License

Business Source License 1.1 — see [LICENSE](./LICENSE).

Free to use. Not free to fork commercially. On 2028-01-01, this converts to Apache-2.0.

---

*Built by [x1scroll.io](https://x1scroll.io) — the intelligence layer on X1.*
