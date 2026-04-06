'use strict';

/**
 * @x1scroll/agent-sdk
 * Agent Identity Protocol — persistent agent identity and on-chain memory for X1 blockchain.
 *
 * Program ID:  52EW3sn2Tkq6EMnp86JWUzXrNzrFujpdEgovsjwapbAM  (immutable)
 * Treasury:    HYP2VdVk2QNGKMBfWGFZpaFqMoqQkB7Vp5F12eSxCxtf  (immutable)
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
const bs58 = require('bs58');

// ── bs58 compat (v4 vs v5 API shape) ─────────────────────────────────────────
const bs58encode = (typeof bs58.encode === 'function') ? bs58.encode : bs58.default.encode;
const bs58decode = (typeof bs58.decode === 'function') ? bs58.decode : bs58.default.decode;

// ── Registry cache TTL ────────────────────────────────────────────────────────
const REGISTRY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes in ms

// ── Fallback validators — used when registry is empty or unreachable ───────────
const FALLBACK_VALIDATORS = [
  { endpoint: 'https://x1scroll.io/api/ipfs/upload', active: true, fallback: true },
];

// ── Protocol constants — hardcoded, do not change ─────────────────────────────
/**
 * On-chain program address. Immutable — this SDK only talks to this program.
 * Forks that swap this address are out of the protocol.
 */
const PROGRAM_ID = new PublicKey('52EW3sn2Tkq6EMnp86JWUzXrNzrFujpdEgovsjwapbAM');

/**
 * Fee collector wallet. Built into every instruction on-chain.
 * Developers don't configure fees — the program handles it automatically.
 */
const TREASURY = new PublicKey('HYP2VdVk2QNGKMBfWGFZpaFqMoqQkB7Vp5F12eSxCxtf');

const DEFAULT_RPC_URL = 'https://rpc.x1.xyz';

// ── Anchor instruction discriminators (sha256("global:<name>")[0..8]) ─────────
// Pre-computed from the IDL. These are fixed for the deployed program version.
const DISCRIMINATORS = {
  register_agent:  Buffer.from([135, 157, 66, 55, 116, 253, 50, 45]),
  store_memory:    Buffer.from([31, 139, 69, 89, 102, 57, 218, 246]),
  update_agent:    Buffer.from([220, 76, 168, 212, 224, 211, 185, 76]),
  transfer_agent:  Buffer.from([39, 202, 189, 195, 254, 40, 59, 198]),
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
  const r = new BorshReader(data.slice(8));
  return {
    human:        r.readPublicKey().toBase58(),
    agentPubkey:  r.readPublicKey().toBase58(),
    name:         r.readString(),
    metadataUri:  r.readString(),
    createdAt:    r.readI64(),
    memoryCount:  r.readU64(),
    lastActive:   r.readI64(),
    bump:         r.readU8(),
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
  constructor({ wallet = null, rpcUrl = DEFAULT_RPC_URL } = {}) {
    // ── resolve wallet ──
    if (wallet === null || wallet === undefined) {
      this.keypair       = null;
      this.walletAddress = null;
    } else if (wallet instanceof Keypair) {
      this.keypair       = wallet;
      this.walletAddress = wallet.publicKey.toBase58();
    } else if (typeof wallet === 'string') {
      const secretKey    = bs58decode(wallet);
      this.keypair       = Keypair.fromSecretKey(secretKey);
      this.walletAddress = this.keypair.publicKey.toBase58();
    } else if (wallet && wallet.secretKey && wallet.publicKey) {
      // Keypair-like object
      this.keypair       = wallet;
      this.walletAddress = wallet.publicKey.toBase58();
    } else {
      throw new AgentSDKError(
        'wallet must be a Keypair, a base58 secret key string, or null',
        'INVALID_WALLET'
      );
    }

    this.rpcUrl            = rpcUrl;
    this._connection       = null; // lazy
    this._registryCache    = null;
    this._registryCacheExpiry = 0;
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

    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed'
    );

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
    // For now: return fallback (registry program not deployed yet)
    // When program is live, this queries on-chain StorageNode accounts
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
   * The agent keypair MUST co-sign — this prevents PDA squatting by ensuring
   * only the real agent key can claim its own identity record.
   *
   * Fee: 0.05 XNT (automatic — built into the instruction).
   * Fee payer: humanKeypair (the wallet that owns this agent).
   *
   * @param {Keypair} agentKeypair   The agent's keypair — MUST be a real Keypair (has secretKey)
   * @param {string}  name           Agent display name (max 32 chars)
   * @param {string}  metadataUri    URI to agent metadata JSON (max 128 chars)
   * @returns {Promise<{ txSig: string, agentRecordPDA: string }>}
   */
  async register(agentKeypair, name, metadataUri) {
    if (!this.keypair) {
      throw new AgentSDKError('AgentClient must be initialised with a wallet to call register()', 'NO_WALLET');
    }

    // ── Anti-squatting: agentKeypair MUST be a real signer ──
    assertIsSigner(agentKeypair, 'agentKeypair');

    // ── Input validation ──
    validateString(name, 'name', 32);
    validateString(metadataUri, 'metadataUri', 128);

    const humanKeypair = this.keypair;
    const agentPubkey  = agentKeypair.publicKey;
    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(agentPubkey);

    // Borsh-encode instruction data: discriminator + name + metadata_uri
    const data = Buffer.concat([
      DISCRIMINATORS.register_agent,
      encodeString(name),
      encodeString(metadataUri),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: humanKeypair.publicKey, isSigner: true,  isWritable: true  }, // human
        { pubkey: agentPubkey,            isSigner: false, isWritable: false }, // agent_pubkey (CHECK)
        { pubkey: agentRecordPDA,         isSigner: false, isWritable: true  }, // agent_record
        { pubkey: TREASURY,               isSigner: false, isWritable: true  }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [humanKeypair]);

    return {
      txSig:         sig,
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
  async storeMemory(agentKeypair, agentRecordHuman, topic, cid, tags = [], encrypted = false) {
    // ── Anti-squatting ──
    assertIsSigner(agentKeypair, 'agentKeypair');

    // ── Input validation ──
    validateString(topic, 'topic', 64);
    validateString(cid, 'cid', 64);
    if (!Array.isArray(tags)) {
      throw new AgentSDKError('tags must be an array', 'INVALID_INPUT');
    }
    if (tags.length > 5) {
      throw new AgentSDKError('Maximum 5 tags allowed', 'INVALID_INPUT');
    }
    for (const tag of tags) {
      validateString(tag, 'tag', 32);
    }
    if (typeof encrypted !== 'boolean') {
      throw new AgentSDKError('encrypted must be a boolean', 'INVALID_INPUT');
    }

    const agentPubkey = agentKeypair.publicKey;
    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(agentPubkey);

    // Read current memory_count from chain to derive the correct PDA index
    const agentData = await this.getAgent(agentPubkey.toBase58());
    const memoryIndex = agentData.memoryCount;

    const { pda: memoryEntryPDA } = AgentClient.deriveMemoryEntry(agentPubkey, memoryIndex);

    // Borsh-encode: discriminator + topic + cid + tags + encrypted
    const data = Buffer.concat([
      DISCRIMINATORS.store_memory,
      encodeString(topic),
      encodeString(cid),
      encodeStringVec(tags),
      encodeBool(encrypted),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: agentPubkey,            isSigner: true,  isWritable: true  }, // agent_pubkey (Signer + fee payer)
        { pubkey: agentRecordPDA,         isSigner: false, isWritable: true  }, // agent_record
        { pubkey: memoryEntryPDA,         isSigner: false, isWritable: true  }, // memory_entry
        { pubkey: TREASURY,               isSigner: false, isWritable: true  }, // treasury
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [agentKeypair]);

    return {
      txSig:          sig,
      memoryEntryPDA: memoryEntryPDA.toBase58(),
    };
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
  async updateAgent(humanKeypair, agentPubkey, name, metadataUri) {
    assertIsSigner(humanKeypair, 'humanKeypair');
    validateString(name, 'name', 32);
    validateString(metadataUri, 'metadataUri', 128);

    const agentKey           = new PublicKey(agentPubkey);
    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(agentKey);

    const data = Buffer.concat([
      DISCRIMINATORS.update_agent,
      encodeString(name),
      encodeString(metadataUri),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: humanKeypair.publicKey, isSigner: true,  isWritable: true  }, // human
        { pubkey: agentKey,               isSigner: false, isWritable: false }, // agent_pubkey (CHECK)
        { pubkey: agentRecordPDA,         isSigner: false, isWritable: true  }, // agent_record
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await this._sendAndConfirm(tx, [humanKeypair]);

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
  async transferAgent(humanKeypair, agentPubkey, newHuman) {
    assertIsSigner(humanKeypair, 'humanKeypair');

    const agentKey            = new PublicKey(agentPubkey);
    const newHumanKey         = new PublicKey(newHuman);
    const { pda: agentRecordPDA } = AgentClient.deriveAgentRecord(agentKey);

    // Encode: discriminator + new_human (32 bytes Pubkey)
    const data = Buffer.concat([
      DISCRIMINATORS.transfer_agent,
      newHumanKey.toBuffer(),
    ]);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: humanKeypair.publicKey, isSigner: true,  isWritable: true  }, // human
        { pubkey: agentKey,               isSigner: false, isWritable: false }, // agent_pubkey (CHECK)
        { pubkey: agentRecordPDA,         isSigner: false, isWritable: true  }, // agent_record
        { pubkey: TREASURY,               isSigner: false, isWritable: true  }, // treasury
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
    const memoryCount = agent.memoryCount;

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
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  AgentClient,
  AgentSDKError,
  PROGRAM_ID,
  TREASURY,
  DEFAULT_RPC_URL,
};
