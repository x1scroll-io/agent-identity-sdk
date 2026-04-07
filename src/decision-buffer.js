'use strict';

/**
 * DecisionBuffer — batch layer for AgentClient.decisionWrite()
 *
 * Packs multiple decision_write instructions into single transactions,
 * cutting per-decision RPC overhead by up to 10x and reducing fees.
 *
 * Usage:
 *   const buffer = new DecisionBuffer(client, agentKeypair, { maxBatch: 5 });
 *   buffer.add('trade', 'bought XNT at 0.34');
 *   buffer.add('trade', 'sold XNT at 0.41');
 *   const results = await buffer.flush();
 *
 * Auto-flush modes:
 *   - Manual: call flush() when ready
 *   - Size:   flush when buffer hits maxBatch (default: 5)
 *   - Time:   flush on interval via start() / stop()
 *
 * Limits (enforced by X1 transaction size):
 *   - Max ~5 decision_write instructions per transaction (safe default)
 *   - Each instruction: ~480 bytes (discriminator + 2x hash + label + cid + outcome + confidence)
 *   - X1 tx limit: 1232 bytes payload — 5 instructions leaves margin
 */

const {
  Transaction,
  TransactionInstruction,
  PublicKey,
  SystemProgram,
} = require('@solana/web3.js');
const crypto = require('crypto');

// Max instructions per batch transaction (safe for 1232-byte X1 tx limit)
const MAX_BATCH_SIZE = 5;

// Reuse discriminator + encoding from parent SDK (import helpers)
function sha256Str(s) {
  return crypto.createHash('sha256').update(s).digest();
}

function encodeString(s) {
  const bytes  = Buffer.from(s, 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([prefix, bytes]);
}

// Anchor discriminator for decision_write
const DECISION_WRITE_DISC = crypto
  .createHash('sha256')
  .update('global:decision_write')
  .digest()
  .slice(0, 8);

class DecisionBuffer {
  /**
   * @param {import('./index').AgentClient} client       - Configured AgentClient
   * @param {import('@solana/web3.js').Keypair} keypair  - Agent keypair (signer)
   * @param {object} [opts]
   * @param {string} [opts.agentId]           - Agent identifier (required for new PDA seeds)
   * @param {number} [opts.maxBatch=5]        - Max decisions per tx (1–5)
   * @param {number} [opts.flushIntervalMs]   - Auto-flush interval in ms (optional)
   * @param {function} [opts.onFlush]         - Callback: (results) => void on each flush
   * @param {function} [opts.onError]         - Callback: (err) => void on flush error
   */
  constructor(client, keypair, opts = {}) {
    this._client   = client;
    this._keypair  = keypair;
    this._agentId  = opts.agentId || null;
    this._maxBatch = Math.min(Math.max(opts.maxBatch || MAX_BATCH_SIZE, 1), MAX_BATCH_SIZE);
    this._onFlush  = opts.onFlush  || null;
    this._onError  = opts.onError  || null;
    this._queue    = [];      // pending DecisionItem[]
    this._timer    = null;    // setInterval handle
    this._flushing = false;   // prevent concurrent flushes

    if (opts.flushIntervalMs && opts.flushIntervalMs > 0) {
      this.start(opts.flushIntervalMs);
    }
  }

  /**
   * Add a decision to the buffer.
   *
   * Simple form:  add(branchLabel, message)
   * Full form:    add(branchLabel, cid, outcome, confidence, parentHash)
   *
   * @param {string}      branchLabel
   * @param {string}      cidOrMessage
   * @param {number}      [outcome=1]         0=pending, 1=executed, 2=rejected
   * @param {number}      [confidence=9000]   0–10000 basis points
   * @param {Buffer|null} [parentHash=null]   32-byte parent hash or null
   * @returns {DecisionBuffer} this (chainable)
   */
  add(branchLabel, cidOrMessage, outcome = 1, confidence = 9000, parentHash = null) {
    if (typeof branchLabel !== 'string' || branchLabel.length === 0) {
      throw new Error('branchLabel must be a non-empty string');
    }
    if (typeof cidOrMessage !== 'string' || cidOrMessage.length === 0) {
      throw new Error('cidOrMessage must be a non-empty string');
    }

    // Simple form detection: short string, not a CID, outcome is default
    let cid;
    const isSimpleMsg = !cidOrMessage.startsWith('Qm') &&
                        !cidOrMessage.startsWith('bafy') &&
                        !cidOrMessage.startsWith('msg:') &&
                        cidOrMessage.length < 64;

    if (isSimpleMsg) {
      cid        = 'msg:' + crypto.createHash('sha256').update(cidOrMessage).digest('hex').slice(0, 44);
      outcome    = 1;
      confidence = 9000;
    } else {
      cid = cidOrMessage;
    }

    // Truncate label/cid to on-chain limits
    if (branchLabel.length > 64) branchLabel = branchLabel.slice(0, 64);
    if (cid.length > 64)         cid         = cid.slice(0, 64);

    this._queue.push({ branchLabel, cid, outcome, confidence, parentHash });

    // Auto-flush if we hit max batch size
    if (this._queue.length >= this._maxBatch) {
      // Don't await — fire and notify via callback
      this.flush().catch(err => {
        if (this._onError) this._onError(err);
        else console.error('[DecisionBuffer] Auto-flush error:', err.message);
      });
    }

    return this;
  }

  /**
   * How many decisions are currently buffered.
   * @returns {number}
   */
  get size() {
    return this._queue.length;
  }

  /**
   * Start auto-flush on a fixed interval.
   * @param {number} intervalMs
   */
  start(intervalMs) {
    if (this._timer) this.stop();
    this._timer = setInterval(() => {
      if (this._queue.length === 0) return;
      this.flush().catch(err => {
        if (this._onError) this._onError(err);
        else console.error('[DecisionBuffer] Interval flush error:', err.message);
      });
    }, intervalMs);
  }

  /**
   * Stop auto-flush interval.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Flush all buffered decisions as one (or more) batch transactions.
   *
   * Each transaction packs up to maxBatch decisions.
   * Returns array of FlushResult: { decisions, txSig, error? }
   *
   * @param {object} [opts]
   * @param {boolean} [opts.all=true] - Flush entire queue (true) or only one batch (false)
   * @returns {Promise<FlushResult[]>}
   */
  async flush(opts = {}) {
    if (this._flushing) {
      // Queue a re-flush after current finishes
      return [];
    }
    if (this._queue.length === 0) return [];

    this._flushing = true;
    const results = [];

    try {
      const drainAll = opts.all !== false;

      while (this._queue.length > 0) {
        const batch = this._queue.splice(0, this._maxBatch);

        let result;
        try {
          const txSig = await this._sendBatch(batch);
          result = { decisions: batch, txSig, error: null };
        } catch (err) {
          result = { decisions: batch, txSig: null, error: err };
          // Re-queue failed batch at front for retry
          this._queue.unshift(...batch);
        }

        results.push(result);

        if (!drainAll || result.error) break;
      }
    } finally {
      this._flushing = false;
    }

    if (this._onFlush && results.length > 0) {
      this._onFlush(results);
    }

    return results;
  }

  /**
   * Flush and wait — returns flat array of tx signatures (throws on any error).
   * Convenience wrapper over flush() for one-liners.
   *
   * @returns {Promise<string[]>} Array of transaction signatures
   */
  async flushAndWait() {
    const results = await this.flush();
    const failed  = results.filter(r => r.error);
    if (failed.length > 0) {
      throw failed[0].error;
    }
    return results.map(r => r.txSig).filter(Boolean);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /**
   * Build and send a single transaction containing multiple decision_write instructions.
   *
   * @param {DecisionItem[]} batch
   * @returns {Promise<string>} transaction signature
   */
  async _sendBatch(batch) {
    const connection  = this._client._getConnection();
    const agentKey    = this._keypair.publicKey;
    const PROGRAM_ID  = this._client.constructor.deriveAgentRecord
      ? require('./index').PROGRAM_ID
      : (() => { throw new Error('Cannot resolve PROGRAM_ID from client'); })();

    const TREASURY = require('./index').TREASURY;

    // Derive AgentRecord PDA once — shared across all instructions in the batch
    // agentId is required with new seeds: [b"agent", authority, agent_id]
    if (!this._agentId) {
      throw new Error('DecisionBuffer: agentId is required. Pass it as opts.agentId in the constructor.');
    }
    const { pda: agentRecordPDA } = this._client.constructor.deriveAgentRecord
      ? this._client.constructor.deriveAgentRecord(agentKey, this._agentId)
      : (() => { throw new Error('Cannot derive AgentRecord PDA'); })();

    const tx = new Transaction();

    for (const item of batch) {
      const timestamp    = Date.now();
      const decisionHash = sha256Str(JSON.stringify({
        cid:        item.cid,
        branchLabel: item.branchLabel,
        timestamp,
      }));

      const parentHashBuf = (item.parentHash instanceof Buffer && item.parentHash.length === 32)
        ? item.parentHash
        : Buffer.alloc(32);

      const [decisionRecordPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('decision'), agentRecordPDA.toBuffer(), decisionHash],
        PROGRAM_ID
      );

      const confidenceBuf = Buffer.alloc(4);
      confidenceBuf.writeUInt32LE(item.confidence, 0);

      const data = Buffer.concat([
        DECISION_WRITE_DISC,
        decisionHash,
        parentHashBuf,
        encodeString(item.branchLabel),
        encodeString(item.cid),
        Buffer.from([item.outcome]),
        confidenceBuf,
      ]);

      tx.add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: agentKey,             isSigner: true,  isWritable: true  },
          { pubkey: agentRecordPDA,       isSigner: false, isWritable: true  },
          { pubkey: decisionRecordPDA,    isSigner: false, isWritable: true  },
          { pubkey: TREASURY,             isSigner: false, isWritable: true  },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      }));

      // Store computed hash back on item for caller reference
      item.decisionHash = decisionHash.toString('hex');
      item.pda          = decisionRecordPDA.toBase58();
    }

    // Send via client's _sendAndConfirm (handles blockhash + confirmation polling)
    return this._client._sendAndConfirm(tx, [this._keypair]);
  }
}

/**
 * @typedef {object} DecisionItem
 * @property {string}      branchLabel
 * @property {string}      cid
 * @property {number}      outcome        0=pending, 1=executed, 2=rejected
 * @property {number}      confidence     0–10000 basis points
 * @property {Buffer|null} parentHash     32-byte parent hash or null
 * @property {string}      [decisionHash] Set after flush — hex of computed hash
 * @property {string}      [pda]          Set after flush — DecisionRecord PDA address
 */

/**
 * @typedef {object} FlushResult
 * @property {DecisionItem[]} decisions   Decisions included in this tx
 * @property {string|null}    txSig       Transaction signature (null on error)
 * @property {Error|null}     error       Error (null on success)
 */

module.exports = { DecisionBuffer, MAX_BATCH_SIZE };
