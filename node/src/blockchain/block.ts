/**
 * AXON Protocol — Block construction and validation
 * Uses real secp256k1 signature verification
 */

import * as crypto from 'crypto';
import { BlockHeader, Block, Transaction, PoAWProof } from './types';
import { sha256d, blake3, merkleRoot, meetsTarget, bitsToTarget } from './crypto';
import { INITIAL_REWARD, HALVING_INTERVAL, COIN, COINBASE_MATURITY } from './constants';
import { verifyTxSig, buildScriptSig } from '../wallet/wallet';

// ─── BLOCK HEADER SERIALIZATION ───────────────────────────────────────────────

export function serializeHeader(h: BlockHeader): Buffer {
  const buf = Buffer.alloc(160);
  let offset = 0;

  buf.writeUInt32LE(h.version, offset);                                         offset += 4;
  Buffer.from(h.prevHash, 'hex').copy(buf, offset);                             offset += 32;
  Buffer.from(h.merkleRoot, 'hex').copy(buf, offset);                           offset += 32;
  buf.writeBigInt64LE(BigInt(h.timestamp), offset);                             offset += 8;
  buf.writeUInt32LE(h.powBits, offset);                                         offset += 4;
  buf.writeUInt32LE(h.powNonce, offset);                                        offset += 4;
  buf.writeUInt32LE(h.poawBits, offset);                                        offset += 4;
  buf.writeUInt32LE(h.poawNonce, offset);                                       offset += 4;
  Buffer.from(h.minerAddress.padEnd(64, '0').substring(0, 64), 'hex').copy(buf, offset); offset += 32;
  Buffer.from(h.inferenceHash, 'hex').copy(buf, offset);                        offset += 32;

  return buf;
}

// ─── BLOCK HASH ───────────────────────────────────────────────────────────────

export function hashBlock(header: BlockHeader): string {
  return sha256d(serializeHeader(header)).toString('hex');
}

// ─── POAW CHALLENGE ───────────────────────────────────────────────────────────

export function deriveChallenge(prevHash: string, height: number, minerAddress: string): string {
  const input = Buffer.concat([
    Buffer.from(prevHash.padEnd(64, '0').substring(0, 64), 'hex'),
    Buffer.alloc(4),
    Buffer.from(minerAddress.substring(0, 40).padEnd(40, '0'), 'utf8'),
  ]);
  input.writeUInt32LE(height, 32);
  return blake3(input).toString('hex');
}

export function computePoawInput(challenge: string, inferenceHash: string, poawNonce: number): Buffer {
  const buf = Buffer.alloc(68);
  Buffer.from(challenge.padEnd(64, '0').substring(0, 64), 'hex').copy(buf, 0);
  Buffer.from(inferenceHash.padEnd(64, '0').substring(0, 64), 'hex').copy(buf, 32);
  buf.writeUInt32LE(poawNonce, 64);
  return blake3(buf);
}

export function verifyPoaw(prevHash: string, height: number, header: BlockHeader, poawTarget: string): boolean {
  const challenge = deriveChallenge(prevHash, height, header.minerAddress);
  const poawInput = computePoawInput(challenge, header.inferenceHash, header.poawNonce);
  return meetsTarget(poawInput, poawTarget);
}

// ─── BLOCK REWARD ─────────────────────────────────────────────────────────────

export function getBlockReward(height: number): bigint {
  if (height === 0) return 0n;
  const era = Math.floor(height / HALVING_INTERVAL);
  if (era >= 64) return 0n;
  return INITIAL_REWARD >> BigInt(era);
}

// ─── COINBASE TRANSACTION ─────────────────────────────────────────────────────

export function createCoinbase(height: number, minerAddress: string, fees: bigint): Transaction {
  const reward      = getBlockReward(height) + fees;
  const heightBytes = Buffer.alloc(4);
  heightBytes.writeUInt32LE(height, 0);

  return {
    version: 1,
    inputs: [{
      prevTxid:  '00'.repeat(32),
      prevIndex: 0xffffffff,
      scriptSig: heightBytes.toString('hex') + Buffer.from(`AXON block ${height}`).toString('hex'),
      sequence:  0xffffffff,
    }],
    outputs: [{
      value:        reward,
      scriptPubKey: addressToScript(minerAddress),
    }],
    locktime: 0,
  };
}

// ─── ADDRESS ↔ SCRIPT ─────────────────────────────────────────────────────────

/**
 * Build P2PKH scriptPubKey from an AXON address.
 * Address format: "axon1" + hex(RIPEMD160(SHA256(pubkey)))
 * Script: OP_DUP OP_HASH160 <20-byte pubKeyHash> OP_EQUALVERIFY OP_CHECKSIG
 */
export function addressToScript(address: string): string {
  // Strip "axon1" prefix to get the hex pubKeyHash
  const prefix  = 'axon1';
  const hexHash = address.startsWith(prefix) ? address.slice(prefix.length) : address;
  // Ensure exactly 40 hex chars (20 bytes)
  const hash20  = hexHash.substring(0, 40).padEnd(40, '0');
  return '76a914' + hash20 + '88ac';
}

/**
 * Extract pubKeyHash from P2PKH scriptPubKey.
 */
export function scriptToHash(script: string): string | null {
  // OP_DUP(76) OP_HASH160(a9) 14 <20 bytes> OP_EQUALVERIFY(88) OP_CHECKSIG(ac)
  if (script.startsWith('76a914') && script.endsWith('88ac') && script.length === 50) {
    return script.slice(6, 46);
  }
  return null;
}

// ─── TRANSACTION SIGHASH ─────────────────────────────────────────────────────

/**
 * Compute the sighash for a transaction input (SIGHASH_ALL).
 * This is what the private key signs.
 */
export function txSigHash(tx: Transaction, inputIndex: number, scriptPubKey: string): Buffer {
  // Serialize tx with scriptPubKey in the signing input, blank elsewhere
  const parts: Buffer[] = [];

  const version = Buffer.alloc(4);
  version.writeUInt32LE(tx.version, 0);
  parts.push(version);

  for (let i = 0; i < tx.inputs.length; i++) {
    const inp = tx.inputs[i];
    parts.push(Buffer.from(inp.prevTxid, 'hex'));
    const idx = Buffer.alloc(4);
    idx.writeUInt32LE(inp.prevIndex >>> 0, 0);
    parts.push(idx);
    // Use scriptPubKey for the input being signed, empty for others
    parts.push(Buffer.from(i === inputIndex ? scriptPubKey : '', 'hex'));
    const seq = Buffer.alloc(4);
    seq.writeUInt32LE(inp.sequence >>> 0, 0);
    parts.push(seq);
  }

  for (const out of tx.outputs) {
    const val = Buffer.alloc(8);
    val.writeBigInt64LE(out.value, 0);
    parts.push(val);
    parts.push(Buffer.from(out.scriptPubKey, 'hex'));
  }

  const lock = Buffer.alloc(4);
  lock.writeUInt32LE(tx.locktime >>> 0, 0);
  parts.push(lock);

  // SIGHASH_ALL = 1
  const hashType = Buffer.alloc(4);
  hashType.writeUInt32LE(1, 0);
  parts.push(hashType);

  return sha256d(Buffer.concat(parts));
}

// ─── TRANSACTION HASH ─────────────────────────────────────────────────────────

export function hashTx(tx: Transaction): string {
  const parts: Buffer[] = [];
  const version = Buffer.alloc(4);
  version.writeUInt32LE(tx.version, 0);
  parts.push(version);

  for (const inp of tx.inputs) {
    parts.push(Buffer.from(inp.prevTxid, 'hex'));
    const idx = Buffer.alloc(4);
    idx.writeUInt32LE(inp.prevIndex >>> 0, 0);
    parts.push(idx);
    parts.push(Buffer.from(inp.scriptSig, 'hex'));
    const seq = Buffer.alloc(4);
    seq.writeUInt32LE(inp.sequence >>> 0, 0);
    parts.push(seq);
  }

  for (const out of tx.outputs) {
    const val = Buffer.alloc(8);
    val.writeBigInt64LE(out.value, 0);
    parts.push(val);
    parts.push(Buffer.from(out.scriptPubKey, 'hex'));
  }

  const lock = Buffer.alloc(4);
  lock.writeUInt32LE(tx.locktime >>> 0, 0);
  parts.push(lock);

  return sha256d(Buffer.concat(parts)).toString('hex');
}

// ─── SIGNATURE VERIFICATION ──────────────────────────────────────────────────

/**
 * Verify a P2PKH scriptSig against a scriptPubKey.
 * scriptSig format: <sigLen><DER sig><pubKeyLen><33-byte compressed pubkey>
 * scriptPubKey: OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG
 */
export function verifyScriptSig(
  scriptSig:    string,
  scriptPubKey: string,
  sigHash:      Buffer
): boolean {
  try {
    const buf      = Buffer.from(scriptSig, 'hex');
    let   offset   = 0;

    // Read signature
    const sigLen   = buf[offset++];
    const sigBytes = buf.slice(offset, offset + sigLen);
    offset += sigLen;

    // Read public key
    const pkLen    = buf[offset++];
    const pkBytes  = buf.slice(offset, offset + pkLen);
    offset += pkLen;

    // Verify 1: pubkey hashes to the expected hash in scriptPubKey
    const sha256Bytes = crypto.createHash('sha256').update(pkBytes).digest();
    const pubKeyHash  = crypto.createHash('ripemd160').update(sha256Bytes).digest('hex');
    const expectedHash = scriptToHash(scriptPubKey);
    if (pubKeyHash !== expectedHash) return false;

    // Verify 2: signature is valid over the sighash
    return verifyTxSig(sigHash, sigBytes.toString('hex'), pkBytes.toString('hex'));
  } catch {
    return false;
  }
}

// ─── MERKLE ROOT ─────────────────────────────────────────────────────────────

export function computeMerkleRoot(txs: Transaction[]): string {
  const hashes = txs.map(tx => Buffer.from(hashTx(tx), 'hex'));
  return merkleRoot(hashes).toString('hex');
}

// ─── BLOCK VALIDATION ─────────────────────────────────────────────────────────

export interface ValidationResult {
  valid:  boolean;
  error?: string;
}

export function validateBlock(
  block:       Block,
  prevHash:    string,
  height:      number,
  powTarget:   string,
  poawTarget:  string,
  utxoLookup:  (txid: string, index: number) => { value: bigint; scriptPubKey: string; coinbase: boolean; blockHeight: number } | null,
): ValidationResult {

  // 1. PoW check
  const blockHash = hashBlock(block.header);
  if (!meetsTarget(Buffer.from(blockHash, 'hex'), powTarget)) {
    return { valid: false, error: `PoW target not met` };
  }

  // 2. PoAW check
  if (!verifyPoaw(prevHash, height, block.header, poawTarget)) {
    return { valid: false, error: 'PoAW target not met' };
  }

  // 3. prevHash check
  if (block.header.prevHash !== prevHash) {
    return { valid: false, error: 'prevHash mismatch' };
  }

  // 4. Timestamp check (not more than 2 hours in future)
  const now = Math.floor(Date.now() / 1000);
  if (block.header.timestamp > now + 7200) {
    return { valid: false, error: 'Block timestamp too far in future' };
  }

  // 5. Merkle root check
  const expectedMerkle = computeMerkleRoot(block.transactions);
  if (block.header.merkleRoot !== expectedMerkle) {
    return { valid: false, error: 'Merkle root mismatch' };
  }

  // 6. Must have at least coinbase
  if (block.transactions.length === 0) {
    return { valid: false, error: 'Block has no transactions' };
  }

  // 7. Coinbase reward check
  const coinbase       = block.transactions[0];
  const isCoinbase     = coinbase.inputs[0].prevIndex === 0xffffffff;
  if (!isCoinbase) {
    return { valid: false, error: 'First transaction must be coinbase' };
  }

  // Sum fees and enforce signatures for non-coinbase transactions
  let totalFees = 0n;
  for (let t = 1; t < block.transactions.length; t++) {
    const tx = block.transactions[t];
    let inputSum  = 0n;
    let outputSum = 0n;

    for (let i = 0; i < tx.inputs.length; i++) {
      const inp  = tx.inputs[i];
      const utxo = utxoLookup(inp.prevTxid, inp.prevIndex);
      if (utxo === null) return { valid: false, error: `Unknown UTXO: ${inp.prevTxid}:${inp.prevIndex}` };

      // 8a. Coinbase maturity check
      if (utxo.coinbase) {
        const age = height - utxo.blockHeight;
        if (age < COINBASE_MATURITY) {
          return { valid: false, error: `Coinbase UTXO immature: age ${age} < required ${COINBASE_MATURITY}` };
        }
      }

      inputSum += utxo.value;

      // 8b. Signature verification (P2PKH)
      const sigHash = txSigHash(tx, i, utxo.scriptPubKey);
      if (!verifyScriptSig(inp.scriptSig, utxo.scriptPubKey, sigHash)) {
        return { valid: false, error: `Invalid signature on tx ${tx.txid ?? t} input ${i}` };
      }
    }

    for (const out of tx.outputs) outputSum += out.value;
    if (inputSum < outputSum) return { valid: false, error: 'Transaction outputs exceed inputs' };
    totalFees += inputSum - outputSum;
  }

  const maxReward  = getBlockReward(height) + totalFees;
  const coinbaseOut = coinbase.outputs.reduce((s, o) => s + o.value, 0n);
  if (coinbaseOut > maxReward) {
    return { valid: false, error: `Coinbase ${coinbaseOut} exceeds allowed ${maxReward}` };
  }

  return { valid: true };
}
