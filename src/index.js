'use strict';

/**
 * @x1scroll/agent-sdk
 * Agent Identity Protocol — persistent agent identity and on-chain memory for X1 blockchain.
 *
 * Program ID:  ECgaMEwH4KLSz3awDo1vz84mSrx5n6h1ZCrbmunB5UxB  (immutable)
 * Treasury:    A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK
 * Network:     X1 Mainnet
 * License:     BSL-1.1 — https://x1scroll.io/license
 *
 * https://x1scroll.io | https://github.com/x1scroll/agent-identity-sdk
 */

const {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const bs58   = require('bs58');
const crypto = require('crypto');

// ── bs58 compat (v4 vs v5 API shape) ─────────────────────────────────────────
const bs58encode = (typeof bs58.encode === 'function') ? bs58.encode : bs58.default.encode;
const bs58decode = (typeof bs58.decode === 'function') ? bs58.decode : bs58.default.decode;

// ── Registry cache TTL ────────────────────────────────────────────────────────
const REGISTRY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes in ms

// ── Validator Storage Registry Program (LIVE on X1 Mainnet) ──────────────────
const STORAGE_REGISTRY_PROGRAM_ID = new PublicKey('GqzvCjz8nzxWxH39twk4oPfFaHXeyVDty9oJ6F4UcfF5');

// ── Fallback validators — used when registry is empty or unreachable ───────────
const FALLBACK_VALIDATORS = [
  { endpoint: 'https://x1scroll.io/api/ipfs/upload', active: true, fallback: true },
];

// ── Protocol constants — hardcoded, do not change ─────────────────────────────
/**
 * On-chain program address. Immutable — this SDK only talks to this program.
 * Forks that swap this address are out of the protocol.
 */
const PROGRAM_ID = new PublicKey('ECgaMEwH4KLSz3awDo1vz84mSrx5n6h1ZCrbmunB5UxB');

/**
 * Fee collector wallet. Built into every instruction on-chain.
 * Developers don't configure fees — the program handles it automatically.
 */
// A1TRS — treasury address hardcoded in the deployed program (ECgaMEwH4...)
// This must match exactly what was compiled into the on-chain binary.
// Updated 2026-04-07: upgraded program to use A1TRS treasury. TX: f9vkecPJWH6K6cxthi2aagDaeuTTDMU5NuB7W7bzZUTfXKaKWrGG319FN6TPdYZnBGpaT5WLo9hSBHNRzZiu2E2
const TREASURY = new PublicKey('A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK');

const DEFAULT_RPC_URL = 'https://x1scroll.io/rpc';

// ── Anchor instruction discriminators (sha256("global:<name>")[0..8]) ─────────
// Pre-computed from the IDL. These are fixed for the deployed program version.
// All discriminators computed from sha256("global:<name>")[0..8] — matches Anchor's derivation
const DISCRIMINATORS = {
  register_agent:        crypto.createHash('sha256').update('global:register_agent').digest().slice(0, 8),
  store_memory:          crypto.createHash('sha256').update('global:store_memory').digest().slice(0, 8),
  update_agent:          crypto.createHash('sha256').update('global:update_manifest').digest().slice(0, 8),
  transfer_agent:        crypto.createHash('sha256').update('global:transfer_agent').digest().slice(0, 8),
  serve_context:         crypto.createHash('sha256').update('global:serve_context').digest().slice(0, 8),
  decision_write:        crypto.createHash('sha256').update('global:decision_write').digest().slice(0, 8),
  strategy_branch_open:  crypto.createHash('sha256').update('global:strategy_branch_open').digest().slice(0, 8),
  strategy_branch_close: crypto.createHash('sha256').update('global:strategy_branch_close').digest().slice(0, 8),
};

// ── Anchor account discriminators (sha256("account:<Name>")[0..8]) ─────────────
const ACCOUNT_DISCRIMINATORS = {
  AgentRecord:  Buffer.from([145, 32, 212, 194, 68, 255, 174, 93]),
  MemoryEntry:  Buffer.from([118, 222, 57, 170, 233, 233, 20, 38]),
};

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

class AgentSDKError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   * @param {any}    [cause]
   */
  constructor(message, code, cause) {
    super(message);
    this.name    = 'AgentSDKError';
    this.code    = code  || 'UNKNOWN';
    this.cause   = cause || null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Encoding helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode a Borsh string: 4-byte LE u32 length prefix + UTF-8 bytes.
 * @param {string} s
 * @returns {Buffer}
 */
function encodeString(s) {
  const bytes  = Buffer.from(s, 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([prefix, bytes]);
}

/**
 * Encode a Borsh Vec<String>: 4-byte LE u32 count + each item encoded as string.
 * @param {string[]} arr
 * @returns {Buffer}
 */
function encodeStringVec(arr) {
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(arr.length, 0);
  const items = arr.map(encodeString);
  return Buffer.concat([countBuf, ...items]);
}

/**
 * Encode a bool as a single byte.
 * @param {boolean} b
 * @returns {Buffer}
 */
function encodeBool(b) {
  return Buffer.from([b ? 1 : 0]);
}

/**
 * Encode a u64 as 8-byte little-endian buffer.
 * @param {number|bigint} n
 * @returns {Buffer}
 */
function encodeU64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n), 0);
  return buf;
}

/**
 * Pad or truncate a label string to exactly 32 bytes (for branch PDA seeds).
 * @param {string} label
 * @returns {Buffer}  32-byte buffer
 */
function padLabel(label) {
  const src = Buffer.from(label, 'utf8');
  const out = Buffer.alloc(32);
  src.copy(out, 0, 0, Math.min(src.length, 32));
  return out;
}

/**
 * Compute sha256 of a string and return a 32-byte Buffer.
 * @param {string} s
 * @returns {Buffer}
 */
function sha256Str(s) {
  return crypto.createHash('sha256').update(s).digest();
}

// ─────────────────────────────────────────────────────────────────────────────
// Borsh decoding helpers
// ─────────────────────────────────────────────────────────────────────────────

class BorshReader {
  constructor(data) {
    this.buf    = data;
    this.offset = 0;
  }

  readU8() {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readU32() {
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readU64() {
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return Number(v);
  }

  readI64() {
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return Number(v);
  }

  readBytes(n) {
    const v = this.buf.slice(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }

  readPublicKey() {
    return new PublicKey(this.readBytes(32));
  }

  readString() {
    const len = this.readU32();
    const bytes = this.readBytes(len);
    return bytes.toString('utf8');
  }

  readStringVec() {
    const count = this.readU32();
    const items = [];
    for (let i = 0; i < count; i++) {
      items.push(this.readString());
    }
    return items;
  }

  readBool() {
    return this.readU8() !== 0;
  }
}

/**
 * Decode an AgentRecord account (skip 8-byte discriminator).
 * @param {Buffer} data
 * @returns {object}
 */
function decodeAgentRecord(data) {
  // AgentRecord layout (v3 program — human + agent_pubkey separated):
  // [8 discriminator] human(32) agent_pubkey(32) agent_id(str) version(u32)
  // memory_cid(str) manifest_cid(str) created_at(i64) last_updated(i64)
  // total_memory_ops(u64) total_context_serves(u64) bump(u8)
  const r = new BorshReader(data.slice(8));
  return {
    human:              r.readPublicKey().toBase58(),
    agentPubkey:        r.readPublicKey().toBase58(),
    agentId:            r.readString(),
    version:            r.readU32(),
    memoryCid:          r.readString(),
    manifestCid:        r.readString(),
    createdAt:          r.readI64(),
    lastUpdated:        r.readI64(),
    totalMemoryOps:     r.readU64(),
    totalContextServes: r.readU64(),
    bump:               r.readU8(),
  };
}

/**
 * Decode a MemoryEntry account (skip 8-byte discriminator).
 * @param {Buffer} data
 * @returns {object}
 */
function decodeMemoryEntry(data) {
  const r = new BorshReader(data.slice(8));
  return {
    agent:      r.readPublicKey().toBase58(),
    topic:      r.readString(),
    cid:        r.readString(),
    tags:       r.readStringVec(),
    encrypted:  r.readBool(),
    timestamp:  r.readI64(),
    slot:       r.readU64(),
    bump:       r.readU8(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reject any string containing null bytes (to prevent injection/truncation bugs).
 * @param {string} s
 * @param {string} field
 */
function rejectNullBytes(s, field) {
  if (s.includes('\0')) {
    throw new AgentSDKError(`${field} must not contain null bytes`, 'INVALID_INPUT');
  }
}

/**
 * Validate a string field: non-empty, no null bytes, within max length.
 * @param {string} value
 * @param {string} field
 * @param {number} maxLen
 */
function validateString(value, field, maxLen) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentSDKError(`${field} must be a non-empty string`, 'INVALID_INPUT');
  }
  rejectNullBytes(value, field);
  if (value.length > maxLen) {
    throw new AgentSDKError(`${field} exceeds ${maxLen} character limit`, 'INVALID_INPUT');
  }
}

/**
 * Assert that the provided keypair is a Signer (has a secretKey).
 * This prevents callers from passing a PublicKey where a signing keypair is required,
 * which would allow PDA squatting or unauthorised instruction submission.
 * @param {any} keypair
 * @param {string} paramName
 */
function assertIsSigner(keypair, paramName) {
  if (!keypair || !keypair.secretKey) {
    throw new AgentSDKError(
      `${paramName} must be a Keypair with a secretKey — a PublicKey alone cannot sign transactions. ` +
      'This validation prevents PDA squatting.',
      'NOT_A_SIGNER'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentClient — main SDK class
// ─────────────────────────────────────────────────────────────────────────────

class AgentClient {
  /**
   * Create an AgentClient instance.
   *
   * @param {object} opts
   * @param {import('@solana/web3.js').Keypair|string|null} [opts.wallet]
   *   The human/operator wallet — a @solana/web3.js Keypair OR a base58 secret key string.
   *   Pass null for read-only use (getAgent, getMemory, listMemories).
   * @param {string} [opts.rpcUrl]
   *   X1 RPC endpoint (default: https://rpc.x1.xyz).
   *   Use https://rpc.x1scroll.io for our dedicated node.
   */
  constructor({ wallet = null, keypair = null, rpcUrl = DEFAULT_RPC_URL } = {}) {
    // ── resolve wallet — accept both `wallet` and `keypair` param names ──
    const resolvedWallet = wallet || keypair;
    if (resolvedWallet === null || resolvedWallet === undefined) {
      this.keypair       = null;
      this.walletAddress = null;
    } else if (resolvedWallet instanceof Keypair) {
      this.keypair       = resolvedWallet;
      this.walletAddress = resolvedWallet.publicKey.toBase58();
    } else if (typeof resolvedWallet === 'string') {
      const secretKey    = bs58decode(resolvedWallet);
      this.keypair       = Keypair.fromSecretKey(secretKey);
      this.walletAddress = this.keypair.publicKey.toBase58();
    } else if (resolvedWallet && resolvedWallet.secretKey && resolvedWallet.publicKey) {
      // Keypair-like object
      this.keypair       = resolvedWallet;
      this.walletAddress = resolvedWallet.publicKey.toBase58();
    } else {
      throw new AgentSDKError(
        'wallet (or keypair) must be a Keypair, a base58 secret key string, or null',
        'INVALID_WALLET'
      );
    }

    this.rpcUrl            = rpcUrl;
    this._connection       = null; // lazy
    this._registryCache    = null;
    this._registryCacheExpiry = 0;
  }

  /**
   * Check RPC connectivity. Throws AgentSDKError with fallback suggestion if unreachable.
   * @returns {Promise<{ ok: boolean, slot: number, rpcUrl: string }>}
   */
  async healthCheck() {
    const conn = this._getConnection();
    try {
      const slot = await Promise.race([
        conn.getSlot(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ]);
      return { ok: true, slot, rpcUrl: this.rpcUrl };
    } catch (err) {
      throw new AgentSDKError(
        `RPC endpoint unreachable: ${this.rpcUrl}. ` +
        `Try the public fallback: https://x1scroll.io/rpc\n` +
        `Original error: ${err.message}`,
        'RPC_UNREACHABLE',
        err
      );
    }
  }

  /**
   * Check that a keypair has sufficient XNT balance for an operation.
   * Throws AgentSDKError with current balance and required amount if insufficient.
   * @param {Keypair} keypair
   * @param {number}  requiredLamports
   * @param {string}  [operationName]
   */
  async _assertSufficientBalance(keypair, requiredLamports, operationName = 'operation') {
    const conn = this._getConnection();
    let balance;
    try {
      balance = await Promise.race([
        conn.getBalance(keypair.publicKey),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ]);
    } catch (err) {
      // Network issue on balance check — warn but don't block the operation
      console.warn(
        `[agent-sdk] Balance check failed for ${operationName} (${err.message}). ` +
        `Proceeding — transaction will fail on-chain if balance is insufficient. ` +
        `RPC: ${this.rpcUrl}`
      );
      return null; // allow the tx to proceed — chain will reject if balance is truly insufficient
    }
    // Add 5000 lamports buffer for network tx fee
    const totalRequired = requiredLamports + 5000;
    if (balance < totalRequired) {
      const balanceXNT  = (balance / 1e9).toFixed(6);
      const requiredXNT = (totalRequired / 1e9).toFixed(6);
      throw new AgentSDKError(
        `Insufficient balance for ${operationName}. ` +
        `Have: ${balanceXNT} XNT, Need: ${requiredXNT} XNT. ` +
        `Fund wallet: ${keypair.publicKey.toBase58()}`,
        'INSUFFICIENT_BALANCE'
      );
    }
    return balance;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /** @returns {Connection} */
  _getConnection() {
    if (!this._connection) {
      this._connection = new Connection(this.rpcUrl, 'confirmed');
    }
    return this._connection;
  }

  /**
   * Send and confirm a transaction.
   * @param {Transaction} tx
   * @param {Keypair[]} signers
   * @returns {Promise<string>} transaction signature
   */
  async _sendAndConfirm(tx, signers) {
    const connection = this._getConnection();
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer        = signers[0].publicKey;

    tx.sign(...signers);

    const rawTx = tx.serialize();
    const sig   = await connection.sendRawTransaction(rawTx, { skipPreflight: false });

    // ── HTTP polling confirmation (avoids WS 405 errors on some RPC providers) ──
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const { value } = await connection.getSignatureStatuses([sig]);
      const status = value?.[0];
      if (status) {
        if (status.err) throw new AgentSDKError(
          `Transaction failed: ${JSON.stringify(status.err)}`, 'TX_FAILED'
        );
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return sig;
        }
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    // TX sent but confirmation timed out — return sig anyway (likely confirmed)
    return sig;
  }

  /**
   * Get active validators from on-chain registry (simulated — falls back to hardcoded list).
   * Results are cached for REGISTRY_CACHE_TTL (5 minutes).
   * @returns {Promise<Array<{endpoint: string, active: boolean, fallback?: boolean}>>}
   */
  async _getActiveValidators() {
    const now = Date.now();
    if (this._registryCache && now < this._registryCacheExpiry) {
      return this._registryCache;
    }
    // Registry program is live: GqzvCjz8nzxWxH39twk4oPfFaHXeyVDty9oJ6F4UcfF5
    // TODO: query on-chain StorageNode accounts via getProgramAccounts
    // For now: return fallback while validator onboarding ramps up
    this._registryCache = FALLBACK_VALIDATORS;
    this._registryCacheExpiry = now + REGISTRY_CACHE_TTL;
    return this._registryCache;
  }

  /**
   * Verify that a pinned CID is reachable on the public IPFS gateway.
   * Non-fatal — returns false on failure (content may still propagate).
   * @param {string} cid
   * @returns {Promise<boolean>}
   */
  async _verifyPin(cid) {
    try {
      const res = await fetch(`https://ipfs.io/ipfs/${cid}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch {
      return false; // non-fatal — log warning but don't throw
    }
  }

  /**
   * Pin content to a single validator endpoint.
   * @param {string} endpoint
   * @param {string} body          Serialized content
   * @param {string} topic
   * @param {string} agentPubkey
   * @returns {Promise<string|null>}  CID string on success, null on failure
   */
  async _pinToEndpoint(endpoint, body, topic, agentPubkey) {
    const res = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content: body, topic, agentPubkey }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new AgentSDKError(`Validator pin failed at ${endpoint} (${res.status}): ${err}`, 'PIN_ENDPOINT_ERROR');
    }
    const json = await res.json();
    return json.cid || null;
  }

  // ── Static PDA Helpers ──────────────────────────────────────────────────────

  /**
   * Derive the AgentRecord PDA for a given agent public key.
   * Seeds: [b"agent", agentPubkey]
   *
   * @param {PublicKey|string} agentPubkey
   * @param {PublicKey|string} [programId]
   * @returns {{ pda: PublicKey, bump: number }}
   */
  static deriveAgentRecord(agentPubkey, programId = PROGRAM_ID) {
    const agentKey = new PublicKey(agentPubkey);
    const progKey  = new PublicKey(programId);
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), agentKey.toBuffer()],
      progKey
    );
    return { pda, bump };
  }

  /**
   * Derive the MemoryEntry PDA for a given agent at a specific memory index.
   * Seeds: [b"memory", agentPubkey, memoryCount (u64 LE)]
   *
   * @param {PublicKey|string} agentPubkey
   * @param {number}           memoryCount  — the index of this memory (0-based; pass agent.memoryCount BEFORE storing)
   * @param {PublicKey|string} [programId]
   * @returns {{ pda: PublicKey, bump: number }}
   */
  static deriveMemoryEntry(agentPubkey, memoryCount, programId = PROGRAM_ID) {
    const agentKey   = new PublicKey(agentPubkey);
    const progKey    = new PublicKey(programId);
    const indexBytes = encodeU64(memoryCount);
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('memory'), agentKey.toBuffer(), indexBytes],
      progKey
    );
    return { pda, bump };
  }

  // ── Write Methods ───────────────────────────────────────────────────────────

  /**
   * Register a new agent on-chain.
   *
   * The agent keypair IS the authority — it signs and pays the registration fee.
   * This matches the deployed program: register_agent(agent_id, memory_cid, manifest_cid)
   * PDA seeds: [b"agent", agent_authority.pubkey]
   *
   * Fee: 0.05 XNT (automatic — built into the instruction, paid by agentKeypair).
   *
   * @param {Keypair} agentKeypair   The agent's keypair — MUST be a real Keypair (has secretKey)
   * @param {string}  agentId        Agent identifier string (max 32 chars)
   * @param {string}  memoryCid      IPFS CID for initial memory (use a placeholder if none)
   * @param {string}  manifestCid    IPFS CID for agent manifest (use a placeholder if none)
   * @returns {Promise<{ txSig: string, agentRecordPDA: string }>}
   */
  async register(humanKeypair, agentKeypair, agentId, memoryCid, manifestCid) {
    // v3 design: human owns + pays, agent co-signs (anti-squatting)
    // PDA seeds: [b"agent", agent_identity.key()]
    assertIsSigner(humanKeypair, 'humanKeypair');
    assertIsSigner(agentKeypair, 'agentKeypair');

    validateString(agentId,     'agentId',     32);
    validateString(memoryCid,   'memoryCid',   64);
    validateString(manifestCid, 'manifestCid', 64);

    // Human pays: 0.05 XNT fee + rent (~0.012 XNT)
    await this._assertSufficientBalance(humanKeypair, 65_000_000, 'register_agent (0.05 XNT fee + rent)');

    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(agentKeypair.publicKey);

    const data = Buffer.concat([
      DISCRIMINATORS.register_agent,
      encodeString(agentId),
      encodeString(memoryCid),
      encodeString(manifestCid),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: humanKeypair.publicKey,  isSigner: true,  isWritable: true  }, // agent_authority (payer)
        { pubkey: agentRecordPDA,          isSigner: false, isWritable: true  }, // agent_record (init)
        { pubkey: TREASURY,                isSigner: false, isWritable: true  }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [humanKeypair]);

    return {
      txSig:          sig,
      agentRecordPDA: agentRecordPDA.toBase58(),
    };
  }

  /**
   * Store a memory entry on-chain.
   *
   * The agent keypair signs and pays the 0.001 XNT fee (THE DRIP).
   * This is the core loop: compress → IPFS → storeMemory(CID).
   *
   * Fee: 0.001 XNT per call (automatic).
   *
   * @param {Keypair}  agentKeypair        The agent's keypair — must be a real Signer
   * @param {string}   agentRecordHuman    The human wallet address that owns this agent (used for PDA lookup)
   * @param {string}   topic               Memory topic label (max 64 chars)
   * @param {string}   cid                 IPFS CID of the memory content (max 64 chars)
   * @param {string[]} [tags=[]]           Optional tags, max 5, each max 32 chars
   * @param {boolean}  [encrypted=false]   Whether the IPFS content is encrypted
   * @returns {Promise<{ txSig: string, memoryEntryPDA: string }>}
   */
  async storeMemory(agentKeypair, newMemoryCid) {
    // v3: agent signs, PDA seeded by agent pubkey
    assertIsSigner(agentKeypair, 'agentKeypair');
    validateString(newMemoryCid, 'newMemoryCid', 64);

    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(agentKeypair.publicKey);

    const data = Buffer.concat([
      DISCRIMINATORS.store_memory,
      encodeString(newMemoryCid),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: agentKeypair.publicKey,  isSigner: true,  isWritable: true  }, // agent
        { pubkey: agentRecordPDA,          isSigner: false, isWritable: true  }, // agent_record
        { pubkey: TREASURY,                isSigner: false, isWritable: true  }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [agentKeypair]);
    return { txSig: sig };
  }

  /**
   * Upload memory content to IPFS (with auto-pinning) and store the CID on-chain.
   *
   * This is the one-stop method for developers who don't want to manage IPFS manually.
   * It handles: JSON serialization → IPFS upload → pinning → on-chain storeMemory().
   *
   * Supported pinning providers:
   *   - 'pinata'   — requires { pinataJwt } in options
   *   - 'x1scroll' — uses x1scroll.io IPFS node (free, rate-limited). Default.
   *
   * Fee: 0.001 XNT (same as storeMemory — automatic).
   *
   * @param {Keypair}  agentKeypair        The agent's keypair — must be a real Signer
   * @param {string}   agentRecordHuman    The human wallet address that owns this agent
   * @param {string}   topic               Memory topic label (max 64 chars)
   * @param {object|string} content        Memory content — object (auto-serialized) or string
   * @param {object}   [options={}]
   * @param {string}   [options.provider='x1scroll']  Pinning provider: 'pinata' | 'x1scroll'
   * @param {string}   [options.pinataJwt]             Required if provider='pinata'
   * @param {string[]} [options.tags=[]]               Tags (max 5)
   * @param {boolean}  [options.encrypted=false]       Whether content is encrypted before upload
   * @returns {Promise<{ txSig: string, memoryEntryPDA: string, cid: string }>}
   */
  async uploadMemory(agentKeypair, agentRecordHuman, topic, content, options = {}) {
    const {
      provider  = 'x1scroll',
      pinataJwt = null,
      tags      = [],
      encrypted = false,
    } = options;

    // Serialize content
    const body = (typeof content === 'string') ? content : JSON.stringify(content);

    let cid;

    if (provider === 'x1scroll' || !provider) {
      // Multi-pin to up to 5 active validators simultaneously for resilience
      const validators = await this._getActiveValidators();
      const selected = validators
        .slice()
        .sort(() => Math.random() - 0.5)
        .slice(0, Math.min(5, validators.length));

      const agentPubkeyStr = agentKeypair.publicKey.toBase58();
      const results = await Promise.allSettled(
        selected.map(v => this._pinToEndpoint(v.endpoint, body, topic, agentPubkeyStr))
      );

      const success = results.find(r => r.status === 'fulfilled' && r.value);
      if (!success) {
        throw new AgentSDKError('All validator pins failed', 'PIN_FAILED');
      }
      cid = success.value;

    } else if (provider === 'pinata') {
      if (!pinataJwt) {
        throw new AgentSDKError(
          'pinataJwt is required when provider is "pinata". Get one at https://pinata.cloud',
          'MISSING_PINATA_JWT'
        );
      }
      const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${pinataJwt}`,
        },
        body: JSON.stringify({ pinataContent: body, pinataMetadata: { name: topic } }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new AgentSDKError(`Pinata upload failed: ${err}`, 'PINATA_ERROR');
      }
      const json = await res.json();
      cid = json.IpfsHash;

    } else {
      throw new AgentSDKError(
        `Unknown provider "${provider}". Supported: 'x1scroll' (default), 'pinata'`,
        'INVALID_PROVIDER'
      );
    }

    if (!cid) {
      throw new AgentSDKError('IPFS upload returned no CID', 'NO_CID');
    }

    // Verify pin is reachable on public IPFS gateway (non-fatal)
    const verified = await this._verifyPin(cid);
    if (!verified) {
      console.warn(`[x1scroll] Warning: CID ${cid} could not be verified on public IPFS gateway. Content may take time to propagate.`);
    }

    // Store CID on-chain
    const result = await this.storeMemory(agentKeypair, agentRecordHuman, topic, cid, tags, encrypted);

    return { ...result, cid, verified };
  }

  /**
   * Update an agent's name and metadata URI.
   * Only the human owner can call this. Free (network tx fee only).
   *
   * @param {Keypair}        humanKeypair  The human wallet keypair (owner)
   * @param {PublicKey|string} agentPubkey  The agent's public key
   * @param {string}         name          New name (max 32 chars)
   * @param {string}         metadataUri   New metadata URI (max 128 chars)
   * @returns {Promise<{ txSig: string }>}
   */
  async updateAgent(agentKeypair, newManifestCid) {
    // v3: agent signs update_manifest
    assertIsSigner(agentKeypair, 'agentKeypair');
    validateString(newManifestCid, 'newManifestCid', 64);

    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(agentKeypair.publicKey);

    const data = Buffer.concat([
      DISCRIMINATORS.update_agent,  // sha256("global:update_manifest")[0..8]
      encodeString(newManifestCid),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: agentKeypair.publicKey,  isSigner: true,  isWritable: true  }, // agent
        { pubkey: agentRecordPDA,          isSigner: false, isWritable: true  }, // agent_record
        { pubkey: TREASURY,                isSigner: false, isWritable: true  }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [agentKeypair]);
    return { txSig: sig };
  }

  /**
   * Transfer agent ownership to a new human wallet.
   * Only the current human owner can call this.
   *
   * Fee: 0.01 XNT (automatic).
   *
   * @param {Keypair}        humanKeypair   Current human owner keypair
   * @param {PublicKey|string} agentPubkey  The agent's public key
   * @param {PublicKey|string} newHuman     New owner's public key
   * @returns {Promise<{ txSig: string }>}
   */
  async transferAgent(humanKeypair, agentRecordPDA, newHuman) {
    // v3: human (owner) signs transfer. Passes agent_record PDA directly.
    // agentRecordPDA = AgentClient.deriveAgentRecord(agentPubkey).pda.toBase58()
    assertIsSigner(humanKeypair, 'humanKeypair');

    const agentRecordKey = new PublicKey(agentRecordPDA);
    const newHumanKey    = new PublicKey(newHuman);

    const data = Buffer.concat([
      DISCRIMINATORS.transfer_agent,
      newHumanKey.toBuffer(),  // new_human pubkey (32 bytes)
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: humanKeypair.publicKey,  isSigner: true,  isWritable: true  }, // human (current owner)
        { pubkey: agentRecordKey,          isSigner: false, isWritable: true  }, // agent_record
        { pubkey: TREASURY,                isSigner: false, isWritable: true  }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [humanKeypair]);
    return { txSig: sig };
  }

  // ── Read Methods ────────────────────────────────────────────────────────────

  /**
   * Fetch and decode an AgentRecord from chain.
   *
   * @param {PublicKey|string} agentPubkey  The agent's public key
   * @returns {Promise<{
   *   pda: string,
   *   human: string,
   *   agentPubkey: string,
   *   name: string,
   *   metadataUri: string,
   *   createdAt: number,
   *   memoryCount: number,
   *   lastActive: number,
   *   bump: number
   * }>}
   */
  async getAgent(agentPubkey) {
    const agentKey           = new PublicKey(agentPubkey);
    const { pda }            = AgentClient.deriveAgentRecord(agentKey);
    const connection         = this._getConnection();
    const info               = await connection.getAccountInfo(pda);

    if (!info || !info.data) {
      throw new AgentSDKError(
        `No AgentRecord found for ${agentPubkey}. Has this agent been registered?`,
        'NOT_FOUND'
      );
    }

    const decoded = decodeAgentRecord(info.data);
    return { pda: pda.toBase58(), ...decoded };
  }

  /**
   * Fetch and decode a single MemoryEntry at a given index.
   *
   * @param {PublicKey|string} agentPubkey  The agent's public key
   * @param {number}           index        Memory index (0-based)
   * @returns {Promise<{
   *   pda: string,
   *   agent: string,
   *   topic: string,
   *   cid: string,
   *   tags: string[],
   *   encrypted: boolean,
   *   timestamp: number,
   *   slot: number,
   *   bump: number
   * }>}
   */
  async getMemory(agentPubkey, index) {
    if (typeof index !== 'number' || index < 0 || !Number.isInteger(index)) {
      throw new AgentSDKError('index must be a non-negative integer', 'INVALID_INPUT');
    }

    const agentKey   = new PublicKey(agentPubkey);
    const { pda }    = AgentClient.deriveMemoryEntry(agentKey, index);
    const connection = this._getConnection();
    const info       = await connection.getAccountInfo(pda);

    if (!info || !info.data) {
      throw new AgentSDKError(
        `No MemoryEntry found at index ${index} for agent ${agentPubkey}`,
        'NOT_FOUND'
      );
    }

    const decoded = decodeMemoryEntry(info.data);
    return { pda: pda.toBase58(), ...decoded };
  }

  /**
   * Fetch multiple memories for an agent (most recent first).
   *
   * Reads memories from index (memoryCount - 1) downward, up to `limit` entries.
   * Entries that don't exist on-chain (e.g. if memoryCount changed) are skipped.
   *
   * @param {PublicKey|string} agentPubkey  The agent's public key
   * @param {number}           [limit=10]   Max number of memories to return
   * @returns {Promise<Array>}  Array of decoded MemoryEntry objects
   */
  async listMemories(agentPubkey, limit = 10) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new AgentSDKError('limit must be a positive integer', 'INVALID_INPUT');
    }

    const agent       = await this.getAgent(agentPubkey);
    const memoryCount = agent.totalMemoryOps || agent.memoryCount || 0;

    if (memoryCount === 0) return [];

    const startIndex = Math.max(0, memoryCount - limit);
    const indices    = [];
    for (let i = startIndex; i < memoryCount; i++) {
      indices.push(i);
    }

    const agentKey   = new PublicKey(agentPubkey);
    const connection = this._getConnection();

    // Derive all PDAs, then batch-fetch
    const pdas = indices.map(i => AgentClient.deriveMemoryEntry(agentKey, i).pda);
    const infos = await connection.getMultipleAccountsInfo(pdas);

    const results = [];
    for (let j = 0; j < pdas.length; j++) {
      const info = infos[j];
      if (!info || !info.data) continue;
      try {
        const decoded = decodeMemoryEntry(info.data);
        results.push({ pda: pdas[j].toBase58(), ...decoded });
      } catch (_) {
        // skip malformed entries
      }
    }

    // Most recent first
    return results.reverse();
  }

  // ── v2 Methods ──────────────────────────────────────────────────────────────

  /**
   * Write a decision to the on-chain decision tree.
   *
   * @param {Keypair}       agentKeypair  The agent keypair (signer + fee payer)
   * @param {string}        branchLabel   Strategy branch this decision belongs to
   * @param {string}        cid           IPFS CID of the decision payload
   * @param {number}        outcome       0=pending, 1=executed, 2=rejected
   * @param {number}        confidence    0-10000 basis points (8200 = 82%)
   * @param {Buffer|null}   [parentHash]  32-byte parent decision hash; zeros for root
   * @returns {Promise<{ sig: string, decisionHash: string, pda: string }>}
   */
  async decisionWrite(agentKeypair, branchLabelOrMessage, cidOrOpts, outcome, confidence, parentHash = null) {
    assertIsSigner(agentKeypair, 'agentKeypair');

    // ── Simple overload: decisionWrite(keypair, type, message) ──
    // Allows: client.decisionWrite(kp, 'trade', 'bought XNT at 0.34')
    // Internally maps to branchLabel=type, cid=sha256(message), outcome=1, confidence=9000
    let branchLabel, cid;
    if (typeof cidOrOpts === 'string' && cidOrOpts.length < 64 && !cidOrOpts.startsWith('Qm') && outcome === undefined) {
      branchLabel = branchLabelOrMessage;
      // Hash the message string into a pseudo-CID for on-chain storage
      cid         = 'msg:' + crypto.createHash('sha256').update(cidOrOpts).digest('hex').slice(0, 44);
      outcome     = 1;    // executed
      confidence  = 9000; // 90%
    } else {
      branchLabel = branchLabelOrMessage;
      cid         = cidOrOpts;
    }

    validateString(branchLabel, 'branchLabel', 64);
    validateString(cid, 'cid', 64);

    // ── Pre-flight balance check (0.001 XNT decision write fee) ──
    await this._assertSufficientBalance(agentKeypair, 1_000_000, 'decision_write (0.001 XNT)');

    if (typeof outcome !== 'number' || ![0, 1, 2].includes(outcome)) {
      throw new AgentSDKError(
        `outcome must be 0 (pending), 1 (executed), or 2 (rejected) — got: ${JSON.stringify(outcome)}. ` +
        'Tip: use the simple form decisionWrite(keypair, type, message) to skip outcome/confidence.',
        'INVALID_INPUT'
      );
    }
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 10000) {
      throw new AgentSDKError(
        `confidence must be 0-10000 basis points — got: ${JSON.stringify(confidence)}`,
        'INVALID_INPUT'
      );
    }

    // Derive decision_hash: sha256(JSON.stringify({cid, branchLabel, timestamp}))
    const timestamp    = Date.now();
    const decisionHash = sha256Str(JSON.stringify({ cid, branchLabel, timestamp }));

    // parent_hash: provided Buffer(32) or zeros
    const parentHashBuf = (parentHash instanceof Buffer && parentHash.length === 32)
      ? parentHash
      : Buffer.alloc(32);

    // Derive AgentRecord PDA
    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(agentKeypair.publicKey);

    // Derive DecisionRecord PDA: [b"decision", agentRecord, decision_hash]
    const [decisionRecordPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('decision'), agentRecordPDA.toBuffer(), decisionHash],
      PROGRAM_ID
    );

    // Encode confidence as u32 LE
    const confidenceBuf = Buffer.alloc(4);
    confidenceBuf.writeUInt32LE(confidence, 0);

    const data = Buffer.concat([
      DISCRIMINATORS.decision_write,
      decisionHash,                  // [u8;32]
      parentHashBuf,                 // [u8;32]
      encodeString(branchLabel),     // string (4-byte LE len + utf8)
      encodeString(cid),             // string
      Buffer.from([outcome]),        // u8
      confidenceBuf,                 // u32 LE
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: agentKeypair.publicKey, isSigner: true,  isWritable: true  }, // agent_authority
        { pubkey: agentRecordPDA,         isSigner: false, isWritable: true  }, // agent_record
        { pubkey: decisionRecordPDA,      isSigner: false, isWritable: true  }, // decision_record (init)
        { pubkey: TREASURY,               isSigner: false, isWritable: true  }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [agentKeypair]);

    return {
      sig,
      decisionHash: decisionHash.toString('hex'),
      pda:          decisionRecordPDA.toBase58(),
    };
  }

  /**
   * Open a new strategy branch on-chain.
   *
   * @param {Keypair} agentKeypair   The agent keypair (signer + fee payer)
   * @param {string}  label          Branch label (max 32 chars — also used for PDA seed)
   * @param {string}  hypothesis     Branch hypothesis description (max 256 chars)
   * @param {string}  [parentBranch] Parent branch label, or '' for top-level
   * @returns {Promise<{ sig: string, branchPda: string }>}
   */
  async branchOpen(agentKeypair, label, hypothesis, parentBranch = '') {
    assertIsSigner(agentKeypair, 'agentKeypair');
    validateString(label, 'label', 32);
    validateString(hypothesis, 'hypothesis', 256);
    if (parentBranch !== '') {
      validateString(parentBranch, 'parentBranch', 32);
    }

    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(agentKeypair.publicKey);

    // Derive BranchRecord PDA: [b"branch", agentRecord, padLabel(label)]
    const [branchRecordPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('branch'), agentRecordPDA.toBuffer(), padLabel(label)],
      PROGRAM_ID
    );

    const data = Buffer.concat([
      DISCRIMINATORS.strategy_branch_open,
      encodeString(label),
      encodeString(parentBranch),
      encodeString(hypothesis),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: agentKeypair.publicKey, isSigner: true,  isWritable: true  }, // agent_authority
        { pubkey: agentRecordPDA,         isSigner: false, isWritable: true  }, // agent_record
        { pubkey: branchRecordPDA,        isSigner: false, isWritable: true  }, // branch_record (init)
        { pubkey: TREASURY,               isSigner: false, isWritable: true  }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [agentKeypair]);

    return {
      sig,
      branchPda: branchRecordPDA.toBase58(),
    };
  }

  /**
   * Close a strategy branch on-chain.
   *
   * @param {Keypair} agentKeypair  The agent keypair (signer + fee payer)
   * @param {string}  label         Branch label to close (must match opened label)
   * @param {number}  outcome       1=success, 2=failure, 3=abandoned
   * @param {string}  summaryCid    IPFS CID of the closing summary
   * @returns {Promise<{ sig: string }>}
   */
  async branchClose(agentKeypair, label, outcome, summaryCid) {
    assertIsSigner(agentKeypair, 'agentKeypair');
    validateString(label, 'label', 32);
    validateString(summaryCid, 'summaryCid', 64);

    if (typeof outcome !== 'number' || ![1, 2, 3].includes(outcome)) {
      throw new AgentSDKError('outcome must be 1 (success), 2 (failure), or 3 (abandoned)', 'INVALID_INPUT');
    }

    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(agentKeypair.publicKey);

    // Derive BranchRecord PDA: [b"branch", agentRecord, padLabel(label)]
    const [branchRecordPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('branch'), agentRecordPDA.toBuffer(), padLabel(label)],
      PROGRAM_ID
    );

    const data = Buffer.concat([
      DISCRIMINATORS.strategy_branch_close,
      encodeString(label),
      Buffer.from([outcome]),        // u8
      encodeString(summaryCid),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: agentKeypair.publicKey, isSigner: true,  isWritable: true  }, // agent_authority
        { pubkey: agentRecordPDA,         isSigner: false, isWritable: false }, // agent_record (NOT writable for close)
        { pubkey: branchRecordPDA,        isSigner: false, isWritable: true  }, // branch_record
        { pubkey: TREASURY,               isSigner: false, isWritable: true  }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [agentKeypair]);

    return { sig };
  }

  /**
   * Fetch last N decisions/memories from chain for an agent by reading transaction history.
   * Does NOT call serve_context on-chain (requires validator signature).
   * Reads transactions directly from RPC and filters for program instructions.
   *
   * @param {PublicKey|string} agentPda  The AgentRecord PDA address
   * @param {number}           [limit]   Max number of entries to return (default 10)
   * @returns {Promise<{ entries: Array<{slot: number, sig: string, instruction: string, blockTime: number|null}>, count: number }>}
   */
  async contextGet(agentPda, limit = 10) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new AgentSDKError('limit must be a positive integer', 'INVALID_INPUT');
    }

    let agentPdaPubkey;
    try {
      // Accept Keypair, PublicKey, or base58 string
      if (agentPda && agentPda.publicKey) {
        agentPdaPubkey = agentPda.publicKey; // Keypair passed — use its pubkey
      } else if (agentPda instanceof PublicKey) {
        agentPdaPubkey = agentPda;
      } else {
        agentPdaPubkey = new PublicKey(agentPda); // base58 string
      }
    } catch (err) {
      throw new AgentSDKError(
        `contextGet: invalid agentPda — expected a Keypair, PublicKey, or base58 string, got: ${typeof agentPda}`,
        'INVALID_INPUT', err
      );
    }

    const connection = this._getConnection();

    // Fetch recent signatures for this address
    const sigs = await connection.getSignaturesForAddress(agentPdaPubkey, { limit });

    const entries = [];

    // Fetch and parse each transaction
    await Promise.all(sigs.map(async (sigInfo) => {
      try {
        const tx = await connection.getParsedTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx || !tx.transaction) return;

        const instructions = tx.transaction.message.instructions || [];
        for (const ix of instructions) {
          const programId = ix.programId ? ix.programId.toBase58() : null;
          if (programId !== PROGRAM_ID.toBase58()) continue;

          // Classify instruction type from data discriminator if available
          let instructionType = 'Unknown';
          if (ix.data) {
            try {
              const rawData = Buffer.from(bs58decode(ix.data));
              const disc    = rawData.slice(0, 8);
              if (disc.equals(DISCRIMINATORS.store_memory))          instructionType = 'StoreMemory';
              else if (disc.equals(DISCRIMINATORS.decision_write))   instructionType = 'DecisionWrite';
              else if (disc.equals(DISCRIMINATORS.strategy_branch_open))  instructionType = 'BranchOpen';
              else if (disc.equals(DISCRIMINATORS.strategy_branch_close)) instructionType = 'BranchClose';
              else if (disc.equals(DISCRIMINATORS.register_agent))   instructionType = 'RegisterAgent';
            } catch (_) { /* unparseable — leave as Unknown */ }
          }

          entries.push({
            slot:        sigInfo.slot,
            sig:         sigInfo.signature,
            instruction: instructionType,
            blockTime:   sigInfo.blockTime || null,
          });
          break; // one entry per tx
        }
      } catch (err) {
        // Log parse failures but don't block — one bad tx shouldn't kill the whole query
        entries.push({
          slot:        sigInfo.slot,
          sig:         sigInfo.signature,
          instruction: 'ParseError',
          error:       err.message || String(err),
          blockTime:   sigInfo.blockTime || null,
        });
      }
    }));

    // Sort by slot descending (most recent first)
    entries.sort((a, b) => b.slot - a.slot);

    return { entries, count: entries.length };
  }

  /**
   * Utility: derive the AgentRecord PDA for any public key.
   *
   * @param {PublicKey|string} agentPublicKey
   * @returns {{ pda: PublicKey, bump: number }}
   */
  getAgentPda(agentPublicKey) {
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), new PublicKey(agentPublicKey).toBuffer()],
      PROGRAM_ID
    );
    return { pda, bump };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PinningRegistryClient
// ─────────────────────────────────────────────────────────────────────────────

const PINNING_REGISTRY_PROGRAM_ID = new PublicKey('4XiYhW1qiasbDyK1nNmPVViNvhLEqgZG7ufC1U9ixBK6');

// Standard fee for pin + recall operations: 0.001 XNT (1,000,000 lamports)
// 80% → validator, 20% → A1TRS treasury (enforced on-chain)
const DEFAULT_PIN_FEE_LAMPORTS = 1_000_000;

// Instruction discriminators (from IDL)
const PINNING_DISCRIMINATORS = {
  initialize:          Buffer.from([175, 175, 109,  31,  13, 152, 155, 237]),
  register_validator:  Buffer.from([118,  98, 251,  58,  81,  30,  13, 240]),
  deregister_validator:Buffer.from([141,  36, 209, 110, 154, 252, 220, 211]),
  confirm_pin:         Buffer.from([185,  11, 197, 147, 205, 218, 192,  22]),
  confirm_recall:      Buffer.from([ 39, 101,  77, 135,  63,  47, 166, 179]),
  record_miss:         Buffer.from([148, 189, 161,  48, 143,  99, 130,  31]),
  get_next_validator:  Buffer.from([248,  29, 205, 168,  56, 167, 176,  16]),
};

/**
 * PinningRegistryClient — interact with the x1scroll Pinning Registry on X1.
 *
 * Program ID: 4XiYhW1qiasbDyK1nNmPVViNvhLEqgZG7ufC1U9ixBK6  (immutable)
 * Treasury:   A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK  (20% of every pin + recall)
 *
 * Usage:
 *   const registry = new PinningRegistryClient();
 *   await registry.registerValidator(validatorKeypair, 'https://my-node.x1scroll.io');
 *   await registry.confirmPin(validatorKeypair, agentKeypair, cid, feeLamports);
 */
class PinningRegistryClient {
  /**
   * @param {string} [rpcUrl] - X1 RPC endpoint (default: GorillaServers)
   */
  /**
   * @param {string} [rpcUrl]      - X1 RPC endpoint (default: GorillaServers)
   * @param {number} [cacheTtlMs]  - Validator cache TTL in ms (default: 24h)
   */
  constructor(rpcUrl = DEFAULT_RPC_URL, cacheTtlMs = 24 * 60 * 60 * 1000) {
    this.connection  = new Connection(rpcUrl, 'confirmed');
    this.programId   = PINNING_REGISTRY_PROGRAM_ID;
    this.treasury    = TREASURY;
    this.cacheTtlMs  = cacheTtlMs;

    // Validator discovery cache
    this._validatorCache     = [];   // [{ authority, endpoint, status, totalPinsServed, totalFeesEarned }]
    this._cacheLastSyncedAt  = 0;    // unix ms
    this._rotationIndex      = 0;    // round-robin cursor
  }

  // ── PDA derivation ──────────────────────────────────────────────────────────

  getRegistryPda() {
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('registry')],
      this.programId
    );
    return { pda, bump };
  }

  getValidatorRecordPda(authorityPubkey) {
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('validator'), new PublicKey(authorityPubkey).toBuffer()],
      this.programId
    );
    return { pda, bump };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  async _sendTx(ix, signers) {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    const tx = new Transaction();
    tx.add(ix);
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = signers[0].publicKey;
    const { sendAndConfirmTransaction } = require('@solana/web3.js');
    return sendAndConfirmTransaction(this.connection, tx, signers, { commitment: 'confirmed' });
  }

  // ── Instructions ─────────────────────────────────────────────────────────────

  /**
   * One-time registry initialization. Sets the treasury address.
   * Only call once — program is immutable after deploy.
   *
   * @param {Keypair} authorityKeypair - Payer and authority
   * @returns {string} Transaction signature
   */
  async initialize(authorityKeypair) {
    const { pda: registryPda } = this.getRegistryPda();
    const data = Buffer.concat([
      PINNING_DISCRIMINATORS.initialize,
      this.treasury.toBuffer(),
    ]);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: registryPda,                     isSigner: false, isWritable: true  },
        { pubkey: authorityKeypair.publicKey,       isSigner: true,  isWritable: true  },
        { pubkey: SystemProgram.programId,          isSigner: false, isWritable: false },
      ],
      data,
    });
    return this._sendTx(ix, [authorityKeypair]);
  }

  /**
   * Register a validator with their IPFS pinning endpoint. Free.
   *
   * @param {Keypair} validatorKeypair - Validator authority keypair
   * @param {string}  endpoint         - IPFS pinning endpoint URL (max 256 chars)
   * @returns {string} Transaction signature
   */
  async registerValidator(validatorKeypair, endpoint) {
    if (endpoint.length > 256) throw new Error('Endpoint too long (max 256 chars)');
    const { pda: registryPda }      = this.getRegistryPda();
    const { pda: validatorRecordPda } = this.getValidatorRecordPda(validatorKeypair.publicKey);

    // Encode endpoint as borsh string: u32 LE length prefix + utf8 bytes
    const endpointBytes = Buffer.from(endpoint, 'utf8');
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32LE(endpointBytes.length, 0);
    const data = Buffer.concat([
      PINNING_DISCRIMINATORS.register_validator,
      lenBuf,
      endpointBytes,
    ]);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: registryPda,                     isSigner: false, isWritable: true  },
        { pubkey: validatorRecordPda,               isSigner: false, isWritable: true  },
        { pubkey: validatorKeypair.publicKey,       isSigner: true,  isWritable: true  },
        { pubkey: SystemProgram.programId,          isSigner: false, isWritable: false },
      ],
      data,
    });
    return this._sendTx(ix, [validatorKeypair]);
  }

  /**
   * Deregister a validator — closes PDA and returns rent.
   *
   * @param {Keypair} validatorKeypair
   * @returns {string} Transaction signature
   */
  async deregisterValidator(validatorKeypair) {
    const { pda: registryPda }        = this.getRegistryPda();
    const { pda: validatorRecordPda } = this.getValidatorRecordPda(validatorKeypair.publicKey);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: registryPda,               isSigner: false, isWritable: true  },
        { pubkey: validatorRecordPda,         isSigner: false, isWritable: true  },
        { pubkey: validatorKeypair.publicKey, isSigner: true,  isWritable: true  },
      ],
      data: PINNING_DISCRIMINATORS.deregister_validator,
    });
    return this._sendTx(ix, [validatorKeypair]);
  }

  /**
   * Validator confirms they pinned a CID. Splits fee 80% validator / 20% treasury.
   * Standard fee: 0.001 XNT (DEFAULT_PIN_FEE_LAMPORTS). Override with feeLamports if needed.
   *
   * @param {Keypair} validatorKeypair - Validator authority (signs + receives 80%)
   * @param {Keypair} agentKeypair     - Agent who pays the fee
   * @param {string}  cid              - IPFS CID (max 128 chars)
   * @param {number}  [feeLamports]    - Fee in lamports (default: 0.001 XNT = 1,000,000)
   * @returns {string} Transaction signature
   */
  async confirmPin(validatorKeypair, agentKeypair, cid, feeLamports = DEFAULT_PIN_FEE_LAMPORTS) {
    return this._confirmOp('confirm_pin', validatorKeypair, agentKeypair, cid, feeLamports);
  }

  /**
   * Validator confirms they served a memory recall. Same 80/20 split.
   * Standard fee: 0.001 XNT (DEFAULT_PIN_FEE_LAMPORTS). Override with feeLamports if needed.
   *
   * @param {Keypair} validatorKeypair
   * @param {Keypair} agentKeypair
   * @param {string}  cid
   * @param {number}  [feeLamports]    - Fee in lamports (default: 0.001 XNT = 1,000,000)
   * @returns {string} Transaction signature
   */
  async confirmRecall(validatorKeypair, agentKeypair, cid, feeLamports = DEFAULT_PIN_FEE_LAMPORTS) {
    return this._confirmOp('confirm_recall', validatorKeypair, agentKeypair, cid, feeLamports);
  }

  async _confirmOp(opName, validatorKeypair, agentKeypair, cid, feeLamports) {
    if (cid.length > 128) throw new Error('CID too long (max 128 chars)');
    const { pda: registryPda }        = this.getRegistryPda();
    const { pda: validatorRecordPda } = this.getValidatorRecordPda(validatorKeypair.publicKey);

    // Encode: cid (borsh string) + agent pubkey (32 bytes) + fee_lamports (u64 LE)
    const cidBytes = Buffer.from(cid, 'utf8');
    const cidLen   = Buffer.allocUnsafe(4);
    cidLen.writeUInt32LE(cidBytes.length, 0);
    const feeBuf = Buffer.allocUnsafe(8);
    feeBuf.writeBigUInt64LE(BigInt(feeLamports), 0);

    const data = Buffer.concat([
      PINNING_DISCRIMINATORS[opName],
      cidLen,
      cidBytes,
      new PublicKey(agentKeypair.publicKey).toBuffer(),
      feeBuf,
    ]);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: registryPda,                     isSigner: false, isWritable: false },
        { pubkey: validatorRecordPda,               isSigner: false, isWritable: true  },
        { pubkey: agentKeypair.publicKey,           isSigner: true,  isWritable: true  },
        { pubkey: validatorKeypair.publicKey,       isSigner: true,  isWritable: true  },
        { pubkey: this.treasury,                    isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId,          isSigner: false, isWritable: false },
      ],
      data,
    });
    return this._sendTx(ix, [agentKeypair, validatorKeypair]);
  }

  // ── Validator Discovery (v1.6.0) ─────────────────────────────────────────────

  /**
   * Scan all ValidatorRecord PDAs on-chain and refresh the local cache.
   * Called automatically by getNextActiveValidator() when cache is stale.
   * Safe to call manually to force a refresh.
   *
   * ValidatorRecord layout (Anchor):
   *   8  discriminator
   *   32 authority (pubkey)
   *   4  endpoint_len + N endpoint (borsh string)
   *   1  status (0=Active, 1=Suspended, 2=Ejected)
   *   1  consecutive_misses
   *   8  total_pins_served (u64 LE)
   *   8  total_fees_earned (u64 LE)
   *   1  bump
   *
   * @returns {Array<{authority:string, endpoint:string, status:string, totalPinsServed:number, totalFeesEarned:number}>}
   */
  async syncValidators() {
    // ValidatorRecord discriminator: [105, 248, 112, 34, 71, 224, 21, 71]
    const VALIDATOR_RECORD_DISCRIMINATOR = Buffer.from([105, 248, 112, 34, 71, 224, 21, 71]);

    const accounts = await this.connection.getProgramAccounts(this.programId, {
      commitment: 'confirmed',
      filters: [
        { memcmp: { offset: 0, bytes: bs58encode(VALIDATOR_RECORD_DISCRIMINATOR) } },
      ],
    });

    const STATUS_MAP = { 0: 'Active', 1: 'Suspended', 2: 'Ejected' };

    const parsed = [];
    for (const { account } of accounts) {
      try {
        const d = account.data;
        // authority: bytes 8..40
        const authority = new PublicKey(d.slice(8, 40)).toBase58();
        // endpoint: u32 length at 40, then string bytes
        const epLen     = d.readUInt32LE(40);
        const endpoint  = d.slice(44, 44 + epLen).toString('utf8');
        const off       = 44 + epLen;
        // status: 1 byte
        const statusByte = d[off];
        const status     = STATUS_MAP[statusByte] ?? 'Unknown';
        // consecutive_misses: 1 byte
        // total_pins_served: u64 LE at off+2
        const totalPinsServed  = Number(d.readBigUInt64LE(off + 2));
        // total_fees_earned: u64 LE at off+10
        const totalFeesEarned  = Number(d.readBigUInt64LE(off + 10));

        parsed.push({ authority, endpoint, status, totalPinsServed, totalFeesEarned });
      } catch (_) {
        // skip malformed accounts
      }
    }

    // Cache only Active validators
    this._validatorCache    = parsed.filter(v => v.status === 'Active');
    this._cacheLastSyncedAt = Date.now();

    return parsed; // return all (including suspended/ejected) for observability
  }

  /**
   * Returns the next active validator in round-robin order.
   * Auto-syncs from chain if cache is empty or older than cacheTtlMs (default 24h).
   *
   * @param {boolean} [forceSync=false] - Force on-chain sync even if cache is fresh
   * @returns {{ authority: string, endpoint: string, totalPinsServed: number, totalFeesEarned: number }}
   * @throws {Error} if no active validators are registered
   */
  async getNextActiveValidator(forceSync = false) {
    const cacheAge = Date.now() - this._cacheLastSyncedAt;
    const cacheStale = cacheAge > this.cacheTtlMs;

    if (forceSync || cacheStale || this._validatorCache.length === 0) {
      await this.syncValidators();
    }

    if (this._validatorCache.length === 0) {
      throw new Error('No active validators registered in the Pinning Registry');
    }

    // Round-robin — cursor wraps automatically
    const validator = this._validatorCache[this._rotationIndex % this._validatorCache.length];
    this._rotationIndex++;

    return validator;
  }

  /**
   * Returns a snapshot of the current local validator cache without hitting RPC.
   * Call syncValidators() first if you need fresh data.
   *
   * @returns {Array<{authority:string, endpoint:string, status:string, totalPinsServed:number, totalFeesEarned:number}>}
   */
  getCachedValidators() {
    return [...this._validatorCache];
  }

  /**
   * Returns cache metadata.
   *
   * @returns {{ count: number, lastSyncedAt: number, ageMs: number, stale: boolean }}
   */
  getCacheStatus() {
    const ageMs = Date.now() - this._cacheLastSyncedAt;
    return {
      count:        this._validatorCache.length,
      lastSyncedAt: this._cacheLastSyncedAt,
      ageMs,
      stale: ageMs > this.cacheTtlMs,
    };
  }

  /**
   * Read the current registry state on-chain.
   *
   * @returns {{ treasury: string, validatorCount: number, activeValidatorCount: number, rotationCounter: number }}
   */
  async getRegistryState() {
    const { pda } = this.getRegistryPda();
    const info = await this.connection.getAccountInfo(pda);
    if (!info) throw new Error('Registry not initialized on-chain');
    // Layout: 8 discriminator + 32 treasury + 8 validator_count + 8 active_validator_count + 8 rotation_counter + 1 bump
    const d = info.data;
    return {
      treasury:             new PublicKey(d.slice(8, 40)).toBase58(),
      validatorCount:       Number(d.readBigUInt64LE(40)),
      activeValidatorCount: Number(d.readBigUInt64LE(48)),
      rotationCounter:      Number(d.readBigUInt64LE(56)),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standalone utility: derive the AgentRecord PDA for any public key.
 * Mirrors AgentClient#getAgentPda but available without instantiating a client.
 *
 * @param {PublicKey|string} agentPublicKey
 * @returns {{ pda: PublicKey, bump: number }}
 */
function getAgentPda(agentPublicKey) {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent'), new PublicKey(agentPublicKey).toBuffer()],
    PROGRAM_ID
  );
  return { pda, bump };
}

const { DecisionBuffer, MAX_BATCH_SIZE } = require('./decision-buffer');

module.exports = {
  AgentClient,
  PinningRegistryClient,
  DecisionBuffer,
  AgentSDKError,
  getAgentPda,
  PROGRAM_ID,
  PINNING_REGISTRY_PROGRAM_ID,
  TREASURY,
  DEFAULT_RPC_URL,
  DEFAULT_PIN_FEE_LAMPORTS,
  MAX_BATCH_SIZE,
};
