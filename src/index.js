'use strict';

/**
 * @x1scroll/agent-sdk
 * Human-Agent Protocol v2 — human wallet IS the agent identity.
 * One agent per human wallet. Human controls everything.
 *
 * Program ID:  AKrx1X75v7MrFcVTnjxoA7VFvDh8ZZmaEw7SDehweCXa
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
 * Human-Agent Protocol v2 on-chain program address.
 * PDA seeds: [b"agent", humanPubkey] — ONE agent per human wallet.
 * Human IS the agent identity. Cost-efficient, human-controlled.
 * Deployed 2026-04-07, slot 41701769.
 */
const PROGRAM_ID = new PublicKey('AKrx1X75v7MrFcVTnjxoA7VFvDh8ZZmaEw7SDehweCXa');

/**
 * Fee collector wallet. Built into every instruction on-chain.
 * Developers don't configure fees — the program handles it automatically.
 */
const TREASURY = new PublicKey('A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK');

const DEFAULT_RPC_URL = 'https://x1scroll.io/rpc';

// ── Anchor instruction discriminators (sha256("global:<name>")[0..8]) ─────────
const DISCRIMINATORS = {
  register_agent:  crypto.createHash('sha256').update('global:register_agent').digest().slice(0, 8),
  store_memory:    crypto.createHash('sha256').update('global:store_memory').digest().slice(0, 8),
  update_agent:    crypto.createHash('sha256').update('global:update_agent').digest().slice(0, 8),
  transfer_agent:  crypto.createHash('sha256').update('global:transfer_agent').digest().slice(0, 8),
  decision_write:  crypto.createHash('sha256').update('global:decision_write').digest().slice(0, 8),
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

  readBool() {
    return this.readU8() !== 0;
  }
}

/**
 * Decode an AgentRecord account (skip 8-byte discriminator).
 * Layout: authority(32) agent_id(str) memory_cid(str) manifest_cid(str)
 *         memory_count(u64) decision_count(u64) bump(u8)
 * @param {Buffer} data
 * @returns {object}
 */
function decodeAgentRecord(data) {
  const r = new BorshReader(data.slice(8));
  return {
    authority:     r.readPublicKey().toBase58(),
    agentId:       r.readString(),
    memoryCid:     r.readString(),
    manifestCid:   r.readString(),
    memoryCount:   r.readU64(),
    decisionCount: r.readU64(),
    bump:          r.readU8(),
  };
}

/**
 * Decode a MemoryEntry account (skip 8-byte discriminator).
 * Layout: topic(str) cid(str) index(u64) timestamp(u64) bump(u8)
 * @param {Buffer} data
 * @returns {object}
 */
function decodeMemoryEntry(data) {
  const r = new BorshReader(data.slice(8));
  return {
    topic:     r.readString(),
    cid:       r.readString(),
    index:     r.readU64(),
    timestamp: r.readU64(),
    bump:      r.readU8(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

function rejectNullBytes(s, field) {
  if (s.includes('\0')) {
    throw new AgentSDKError(`${field} must not contain null bytes`, 'INVALID_INPUT');
  }
}

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
 * @param {any} keypair
 * @param {string} paramName
 */
function assertIsSigner(keypair, paramName) {
  if (!keypair || !keypair.secretKey) {
    throw new AgentSDKError(
      `${paramName} must be a Keypair with a secretKey — a PublicKey alone cannot sign transactions.`,
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
   *   The human wallet — a @solana/web3.js Keypair OR a base58 secret key string.
   *   Pass null for read-only use.
   * @param {string} [opts.rpcUrl]
   *   X1 RPC endpoint (default: https://x1scroll.io/rpc).
   */
  constructor({ wallet = null, keypair = null, rpcUrl = DEFAULT_RPC_URL } = {}) {
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
      this.keypair       = resolvedWallet;
      this.walletAddress = resolvedWallet.publicKey.toBase58();
    } else {
      throw new AgentSDKError(
        'wallet (or keypair) must be a Keypair, a base58 secret key string, or null',
        'INVALID_WALLET'
      );
    }

    this.rpcUrl            = rpcUrl;
    this._connection       = null;
    this._registryCache    = null;
    this._registryCacheExpiry = 0;
  }

  /**
   * Check RPC connectivity.
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
      console.warn(`[agent-sdk] Balance check failed for ${operationName} (${err.message}). Proceeding.`);
      return null;
    }
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

    // HTTP polling confirmation
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
    return sig;
  }

  /**
   * Get active validators from registry.
   * @returns {Promise<Array>}
   */
  async _getActiveValidators() {
    const now = Date.now();
    if (this._registryCache && now < this._registryCacheExpiry) {
      return this._registryCache;
    }
    this._registryCache = FALLBACK_VALIDATORS;
    this._registryCacheExpiry = now + REGISTRY_CACHE_TTL;
    return this._registryCache;
  }

  // ── Static PDA Helpers ──────────────────────────────────────────────────────

  /**
   * Derive the AgentRecord PDA for a given human wallet.
   * Seeds: [b"agent", humanPubkey]
   * ONE agent per human wallet — this is by design.
   *
   * @param {PublicKey|string} humanPubkey   The human authority wallet
   * @param {PublicKey|string} [programId]
   * @returns {{ pda: PublicKey, bump: number }}
   */
  static deriveAgentRecord(humanPubkey, programId = PROGRAM_ID) {
    const humanKey = new PublicKey(humanPubkey);
    const progKey  = new PublicKey(programId);
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), humanKey.toBuffer()],
      progKey
    );
    return { pda, bump };
  }

  /**
   * Derive the MemoryEntry PDA.
   * Seeds: [b"memory", agentRecordPubkey, memoryCount (u64 LE)]
   *
   * @param {PublicKey|string} agentRecordPubkey  The AgentRecord PDA address
   * @param {number}           memoryCount        Memory index (0-based)
   * @param {PublicKey|string} [programId]
   * @returns {{ pda: PublicKey, bump: number }}
   */
  static deriveMemoryEntry(agentRecordPubkey, memoryCount, programId = PROGRAM_ID) {
    const agentKey   = new PublicKey(agentRecordPubkey);
    const progKey    = new PublicKey(programId);
    const indexBytes = encodeU64(memoryCount);
    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('memory'), agentKey.toBuffer(), indexBytes],
      progKey
    );
    return { pda, bump };
  }

  /**
   * Derive the DecisionRecord PDA.
   * Seeds: [b"decision", agentRecordPubkey, decisionHash]
   *
   * @param {PublicKey|string} agentRecordPubkey  The AgentRecord PDA address
   * @param {Buffer}           decisionHash       32-byte hash
   * @param {PublicKey|string} [programId]
   * @returns {PublicKey}
   */
  static deriveDecisionRecord(agentRecordPubkey, decisionHash, programId = PROGRAM_ID) {
    const agentKey = new PublicKey(agentRecordPubkey);
    const progKey  = new PublicKey(programId);
    const [pda]    = PublicKey.findProgramAddressSync(
      [Buffer.from('decision'), agentKey.toBuffer(), decisionHash],
      progKey
    );
    return pda;
  }

  // ── Write Methods ───────────────────────────────────────────────────────────

  /**
   * Register an agent identity on-chain.
   *
   * The human wallet IS the authority. PDA seeds: [b"agent", humanPubkey].
   * One registration per human wallet — this is intentional design.
   *
   * Fee: 0.05 XNT (automatic — built into the instruction).
   *
   * @param {Keypair} humanKeypair   The human wallet keypair
   * @param {string}  agentId        Agent identifier string (max 32 chars)
   * @param {string}  memoryCid      IPFS CID for initial memory (max 64 chars)
   * @param {string}  manifestCid    IPFS CID for agent manifest (max 64 chars)
   * @returns {Promise<{ txSig: string, agentRecordPDA: string }>}
   */
  async register(humanKeypair, agentId, memoryCid, manifestCid) {
    assertIsSigner(humanKeypair, 'humanKeypair');
    validateString(agentId,     'agentId',     32);
    validateString(memoryCid,   'memoryCid',   64);
    validateString(manifestCid, 'manifestCid', 64);

    // Human pays: 0.05 XNT fee + rent (~0.002 XNT)
    await this._assertSufficientBalance(humanKeypair, 55_000_000, 'register_agent (0.05 XNT fee + rent)');

    // PDA: [b"agent", humanPubkey]
    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(humanKeypair.publicKey);

    const data = Buffer.concat([
      DISCRIMINATORS.register_agent,
      encodeString(agentId),
      encodeString(memoryCid),
      encodeString(manifestCid),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: humanKeypair.publicKey,  isSigner: true,  isWritable: true  }, // agent_authority
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
   * Fee: 0.001 XNT per call (THE DRIP).
   *
   * @param {Keypair} humanKeypair   The human wallet keypair (authority)
   * @param {string}  topic          Memory topic label (max 64 chars)
   * @param {string}  cid            IPFS CID of the memory content (max 64 chars)
   * @returns {Promise<{ txSig: string }>}
   */
  async storeMemory(humanKeypair, topic, cid) {
    assertIsSigner(humanKeypair, 'humanKeypair');
    validateString(topic, 'topic', 64);
    validateString(cid,   'cid',   64);

    await this._assertSufficientBalance(humanKeypair, 1_000_000, 'store_memory (0.001 XNT)');

    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(humanKeypair.publicKey);

    // Fetch current memory count to derive the memory entry PDA
    const connection = this._getConnection();
    const agentInfo  = await connection.getAccountInfo(agentRecordPDA);
    if (!agentInfo) throw new AgentSDKError('AgentRecord not found — register first', 'NOT_FOUND');
    const decoded     = decodeAgentRecord(agentInfo.data);
    const memoryCount = decoded.memoryCount;

    const { pda: memoryEntryPDA } = AgentClient.deriveMemoryEntry(agentRecordPDA, memoryCount);

    const data = Buffer.concat([
      DISCRIMINATORS.store_memory,
      encodeString(topic),
      encodeString(cid),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: humanKeypair.publicKey,  isSigner: true,  isWritable: true  }, // agent_authority
        { pubkey: agentRecordPDA,          isSigner: false, isWritable: true  }, // agent_record
        { pubkey: memoryEntryPDA,          isSigner: false, isWritable: true  }, // memory_entry (init)
        { pubkey: TREASURY,                isSigner: false, isWritable: true  }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [humanKeypair]);
    return { txSig: sig, memoryEntryPDA: memoryEntryPDA.toBase58() };
  }

  /**
   * Update an agent's memory and manifest CIDs.
   *
   * Fee: 0.001 XNT.
   *
   * @param {Keypair} humanKeypair   The human wallet keypair (authority)
   * @param {string}  memoryCid      New memory CID (max 64 chars)
   * @param {string}  manifestCid    New manifest CID (max 64 chars)
   * @returns {Promise<{ txSig: string }>}
   */
  async updateAgent(humanKeypair, memoryCid, manifestCid) {
    assertIsSigner(humanKeypair, 'humanKeypair');
    validateString(memoryCid,   'memoryCid',   64);
    validateString(manifestCid, 'manifestCid', 64);

    await this._assertSufficientBalance(humanKeypair, 1_000_000, 'update_agent (0.001 XNT)');

    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(humanKeypair.publicKey);

    const data = Buffer.concat([
      DISCRIMINATORS.update_agent,
      encodeString(memoryCid),
      encodeString(manifestCid),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: humanKeypair.publicKey,  isSigner: true,  isWritable: true  }, // agent_authority
        { pubkey: agentRecordPDA,          isSigner: false, isWritable: true  }, // agent_record
        { pubkey: TREASURY,                isSigner: false, isWritable: true  }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [humanKeypair]);
    return { txSig: sig };
  }

  /**
   * Transfer agent control to a new human wallet.
   *
   * Fee: 0.01 XNT.
   *
   * @param {Keypair}          humanKeypair   Current human owner keypair
   * @param {PublicKey|string} newAuthority   New owner's public key
   * @returns {Promise<{ txSig: string }>}
   */
  async transferAgent(humanKeypair, newAuthority) {
    assertIsSigner(humanKeypair, 'humanKeypair');

    await this._assertSufficientBalance(humanKeypair, 10_000_000, 'transfer_agent (0.01 XNT)');

    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(humanKeypair.publicKey);
    const newAuthorityKey         = new PublicKey(newAuthority);

    const data = Buffer.concat([
      DISCRIMINATORS.transfer_agent,
      newAuthorityKey.toBuffer(),  // new_authority pubkey (32 bytes)
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: humanKeypair.publicKey,  isSigner: true,  isWritable: true  }, // agent_authority
        { pubkey: agentRecordPDA,          isSigner: false, isWritable: true  }, // agent_record
        { pubkey: TREASURY,                isSigner: false, isWritable: true  }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [humanKeypair]);
    return { txSig: sig };
  }

  /**
   * Write a decision record to the on-chain decision tree.
   *
   * Human wallet signs — no separate agent keypair.
   * PDA: [b"decision", agentRecordPDA, decisionHash]
   *
   * Fee: 0.001 XNT.
   *
   * @param {Keypair}        humanKeypair   The human wallet keypair
   * @param {string}         branchLabel    Strategy branch label (max 64 chars)
   * @param {string}         cid            IPFS CID of the decision payload (max 64 chars)
   * @param {number}         outcome        0=pending, 1=executed, 2=rejected
   * @param {number}         confidence     0-10000 basis points (8200 = 82%)
   * @param {Buffer|null}    [parentHash]   32-byte parent decision hash; zeros for root
   * @returns {Promise<{ sig: string, decisionHash: string, pda: string }>}
   */
  async decisionWrite(humanKeypair, branchLabel, cid, outcome = 1, confidence = 8200, parentHash = null) {
    assertIsSigner(humanKeypair, 'humanKeypair');

    validateString(branchLabel, 'branchLabel', 64);
    validateString(cid,         'cid',         64);

    await this._assertSufficientBalance(humanKeypair, 1_000_000, 'decision_write (0.001 XNT)');

    if (typeof outcome !== 'number' || ![0, 1, 2].includes(outcome)) {
      throw new AgentSDKError(
        `outcome must be 0 (pending), 1 (executed), or 2 (rejected) — got: ${JSON.stringify(outcome)}`,
        'INVALID_INPUT'
      );
    }
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 10000) {
      throw new AgentSDKError(
        `confidence must be 0-10000 basis points — got: ${JSON.stringify(confidence)}`,
        'INVALID_INPUT'
      );
    }

    // Derive AgentRecord PDA from human wallet
    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(humanKeypair.publicKey);

    // Compute decision_hash
    const timestamp    = Date.now();
    const decisionHash = sha256Str(JSON.stringify({ cid, branchLabel, timestamp }));

    // parent_hash: provided Buffer(32) or zeros
    const parentHashBuf = (parentHash instanceof Buffer && parentHash.length === 32)
      ? parentHash
      : Buffer.alloc(32);

    // Derive DecisionRecord PDA
    const decisionRecordPDA = AgentClient.deriveDecisionRecord(agentRecordPDA, decisionHash);

    // Encode confidence as u32 LE
    const confidenceBuf = Buffer.alloc(4);
    confidenceBuf.writeUInt32LE(confidence, 0);

    // Instruction data: discriminator + branch_label + cid + decision_hash + parent_hash + outcome + confidence
    const data = Buffer.concat([
      DISCRIMINATORS.decision_write,
      encodeString(branchLabel),     // branch_label: String
      encodeString(cid),             // cid: String
      decisionHash,                  // decision_hash: [u8;32]
      parentHashBuf,                 // parent_hash: [u8;32]
      Buffer.from([outcome]),        // outcome: u8
      confidenceBuf,                 // confidence: u32 LE
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: humanKeypair.publicKey,  isSigner: true,  isWritable: true  }, // agent_authority
        { pubkey: agentRecordPDA,          isSigner: false, isWritable: true  }, // agent_record
        { pubkey: decisionRecordPDA,       isSigner: false, isWritable: true  }, // decision_record (init)
        { pubkey: TREASURY,                isSigner: false, isWritable: true  }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [humanKeypair]);

    return {
      sig,
      decisionHash: decisionHash.toString('hex'),
      pda:          decisionRecordPDA.toBase58(),
    };
  }

  // ── Read Methods ────────────────────────────────────────────────────────────

  /**
   * Fetch and decode the AgentRecord for a human wallet.
   *
   * @param {PublicKey|string} humanPubkey  The human wallet address
   * @returns {Promise<object>}  Decoded AgentRecord
   */
  async getAgent(humanPubkey) {
    const humanKey    = new PublicKey(humanPubkey);
    const { pda }     = AgentClient.deriveAgentRecord(humanKey);
    const connection  = this._getConnection();
    const info        = await connection.getAccountInfo(pda);

    if (!info || !info.data) {
      throw new AgentSDKError(
        `No AgentRecord found for human=${humanPubkey}. Has this agent been registered?`,
        'NOT_FOUND'
      );
    }

    const decoded = decodeAgentRecord(info.data);
    return { pda: pda.toBase58(), ...decoded };
  }

  /**
   * Fetch and decode a single MemoryEntry at a given index.
   *
   * @param {PublicKey|string} humanPubkey  The human wallet address
   * @param {number}           index        Memory index (0-based)
   * @returns {Promise<object>}  Decoded MemoryEntry
   */
  async getMemory(humanPubkey, index) {
    if (typeof index !== 'number' || index < 0 || !Number.isInteger(index)) {
      throw new AgentSDKError('index must be a non-negative integer', 'INVALID_INPUT');
    }

    const humanKey        = new PublicKey(humanPubkey);
    const { pda: agentPDA } = AgentClient.deriveAgentRecord(humanKey);
    const { pda }         = AgentClient.deriveMemoryEntry(agentPDA, index);
    const connection      = this._getConnection();
    const info            = await connection.getAccountInfo(pda);

    if (!info || !info.data) {
      throw new AgentSDKError(
        `No MemoryEntry found at index ${index} for human ${humanPubkey}`,
        'NOT_FOUND'
      );
    }

    const decoded = decodeMemoryEntry(info.data);
    return { pda: pda.toBase58(), ...decoded };
  }

  /**
   * Fetch multiple memories for a human's agent (most recent first).
   *
   * @param {PublicKey|string} humanPubkey  The human wallet address
   * @param {number}           [limit=10]   Max number of memories to return
   * @returns {Promise<Array>}
   */
  async listMemories(humanPubkey, limit = 10) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new AgentSDKError('limit must be a positive integer', 'INVALID_INPUT');
    }

    const agent       = await this.getAgent(humanPubkey);
    const memoryCount = agent.memoryCount || 0;

    if (memoryCount === 0) return [];

    const humanKey        = new PublicKey(humanPubkey);
    const { pda: agentPDA } = AgentClient.deriveAgentRecord(humanKey);

    const startIndex = Math.max(0, memoryCount - limit);
    const indices    = [];
    for (let i = startIndex; i < memoryCount; i++) {
      indices.push(i);
    }

    const connection = this._getConnection();
    const pdas = indices.map(i => AgentClient.deriveMemoryEntry(agentPDA, i).pda);
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

    return results.reverse(); // most recent first
  }

  /**
   * Fetch recent transactions for this agent's record.
   *
   * @param {PublicKey|string} humanPubkey  The human wallet address
   * @param {number}           [limit=10]   Max entries to return
   * @returns {Promise<{ entries: Array, count: number }>}
   */
  async contextGet(humanPubkey, limit = 10) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new AgentSDKError('limit must be a positive integer', 'INVALID_INPUT');
    }

    const humanKey        = new PublicKey(humanPubkey);
    const { pda: agentPDA } = AgentClient.deriveAgentRecord(humanKey);
    const connection      = this._getConnection();

    const sigs = await connection.getSignaturesForAddress(agentPDA, { limit });

    const entries = [];
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

          let instructionType = 'Unknown';
          if (ix.data) {
            try {
              const rawData = Buffer.from(bs58decode(ix.data));
              const disc    = rawData.slice(0, 8);
              if (disc.equals(DISCRIMINATORS.store_memory))   instructionType = 'StoreMemory';
              else if (disc.equals(DISCRIMINATORS.decision_write))  instructionType = 'DecisionWrite';
              else if (disc.equals(DISCRIMINATORS.register_agent))  instructionType = 'RegisterAgent';
              else if (disc.equals(DISCRIMINATORS.update_agent))    instructionType = 'UpdateAgent';
              else if (disc.equals(DISCRIMINATORS.transfer_agent))  instructionType = 'TransferAgent';
            } catch (_) {}
          }

          entries.push({
            slot:        sigInfo.slot,
            sig:         sigInfo.signature,
            instruction: instructionType,
            blockTime:   sigInfo.blockTime || null,
          });
          break;
        }
      } catch (err) {
        entries.push({
          slot:        sigInfo.slot,
          sig:         sigInfo.signature,
          instruction: 'ParseError',
          error:       err.message || String(err),
          blockTime:   sigInfo.blockTime || null,
        });
      }
    }));

    entries.sort((a, b) => b.slot - a.slot);
    return { entries, count: entries.length };
  }

  /**
   * Utility: derive the AgentRecord PDA for a human wallet.
   *
   * @param {PublicKey|string} humanPublicKey
   * @returns {{ pda: PublicKey, bump: number }}
   */
  getAgentPda(humanPublicKey) {
    return AgentClient.deriveAgentRecord(humanPublicKey);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PinningRegistryClient
// ─────────────────────────────────────────────────────────────────────────────

const PINNING_REGISTRY_PROGRAM_ID = new PublicKey('4XiYhW1qiasbDyK1nNmPVViNvhLEqgZG7ufC1U9ixBK6');
const DEFAULT_PIN_FEE_LAMPORTS = 1_000_000;

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
 * Treasury:   A1TRS3i2g62Zf6K4vybsW4JLx8wifqSoThyTQqXNaLDK
 */
class PinningRegistryClient {
  constructor(rpcUrl = DEFAULT_RPC_URL, cacheTtlMs = 24 * 60 * 60 * 1000) {
    this.connection  = new Connection(rpcUrl, 'confirmed');
    this.programId   = PINNING_REGISTRY_PROGRAM_ID;
    this.treasury    = TREASURY;
    this.cacheTtlMs  = cacheTtlMs;

    this._validatorCache     = [];
    this._cacheLastSyncedAt  = 0;
    this._rotationIndex      = 0;
  }

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

  async registerValidator(validatorKeypair, endpoint) {
    if (endpoint.length > 256) throw new Error('Endpoint too long (max 256 chars)');
    const { pda: registryPda }        = this.getRegistryPda();
    const { pda: validatorRecordPda } = this.getValidatorRecordPda(validatorKeypair.publicKey);

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
        { pubkey: registryPda,               isSigner: false, isWritable: true  },
        { pubkey: validatorRecordPda,         isSigner: false, isWritable: true  },
        { pubkey: validatorKeypair.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
      ],
      data,
    });
    return this._sendTx(ix, [validatorKeypair]);
  }

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

  async confirmPin(validatorKeypair, agentKeypair, cid, feeLamports = DEFAULT_PIN_FEE_LAMPORTS) {
    return this._confirmOp('confirm_pin', validatorKeypair, agentKeypair, cid, feeLamports);
  }

  async confirmRecall(validatorKeypair, agentKeypair, cid, feeLamports = DEFAULT_PIN_FEE_LAMPORTS) {
    return this._confirmOp('confirm_recall', validatorKeypair, agentKeypair, cid, feeLamports);
  }

  async _confirmOp(opName, validatorKeypair, agentKeypair, cid, feeLamports) {
    if (cid.length > 128) throw new Error('CID too long (max 128 chars)');
    const { pda: registryPda }        = this.getRegistryPda();
    const { pda: validatorRecordPda } = this.getValidatorRecordPda(validatorKeypair.publicKey);

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
        { pubkey: registryPda,               isSigner: false, isWritable: false },
        { pubkey: validatorRecordPda,         isSigner: false, isWritable: true  },
        { pubkey: agentKeypair.publicKey,     isSigner: true,  isWritable: true  },
        { pubkey: validatorKeypair.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: this.treasury,              isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
      ],
      data,
    });
    return this._sendTx(ix, [agentKeypair, validatorKeypair]);
  }

  async syncValidators() {
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
        const authority = new PublicKey(d.slice(8, 40)).toBase58();
        const epLen     = d.readUInt32LE(40);
        const endpoint  = d.slice(44, 44 + epLen).toString('utf8');
        const off       = 44 + epLen;
        const statusByte = d[off];
        const status     = STATUS_MAP[statusByte] ?? 'Unknown';
        const totalPinsServed  = Number(d.readBigUInt64LE(off + 2));
        const totalFeesEarned  = Number(d.readBigUInt64LE(off + 10));
        parsed.push({ authority, endpoint, status, totalPinsServed, totalFeesEarned });
      } catch (_) {}
    }

    this._validatorCache    = parsed.filter(v => v.status === 'Active');
    this._cacheLastSyncedAt = Date.now();
    return parsed;
  }

  async getNextActiveValidator(forceSync = false) {
    const cacheAge = Date.now() - this._cacheLastSyncedAt;
    const cacheStale = cacheAge > this.cacheTtlMs;

    if (forceSync || cacheStale || this._validatorCache.length === 0) {
      await this.syncValidators();
    }

    if (this._validatorCache.length === 0) {
      throw new Error('No active validators registered in the Pinning Registry');
    }

    const validator = this._validatorCache[this._rotationIndex % this._validatorCache.length];
    this._rotationIndex++;
    return validator;
  }

  getCachedValidators() {
    return [...this._validatorCache];
  }

  getCacheStatus() {
    const ageMs = Date.now() - this._cacheLastSyncedAt;
    return {
      count:        this._validatorCache.length,
      lastSyncedAt: this._cacheLastSyncedAt,
      ageMs,
      stale: ageMs > this.cacheTtlMs,
    };
  }

  async getRegistryState() {
    const { pda } = this.getRegistryPda();
    const info = await this.connection.getAccountInfo(pda);
    if (!info) throw new Error('Registry not initialized on-chain');
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
 * Standalone utility: derive the AgentRecord PDA for a human wallet.
 *
 * @param {PublicKey|string} humanPublicKey
 * @returns {{ pda: PublicKey, bump: number }}
 */
function getAgentPda(humanPublicKey) {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('agent'), new PublicKey(humanPublicKey).toBuffer()],
    PROGRAM_ID
  );
  return { pda, bump };
}

module.exports = {
  AgentClient,
  PinningRegistryClient,
  AgentSDKError,
  getAgentPda,
  PROGRAM_ID,
  PINNING_REGISTRY_PROGRAM_ID,
  TREASURY,
  DEFAULT_RPC_URL,
  DEFAULT_PIN_FEE_LAMPORTS,
};
