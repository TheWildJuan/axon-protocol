import { BlockHeader, Block, Transaction, PoAWProof } from './types';
import { sha256d, blake3, merkleRoot, meetsTarget, bitsToTarget } from './crypto';
import { INITIAL_REWARD, HALVING_INTERVAL, COIN, COINBASE_MATURITY } from './constants';

// ─── BLOCK HEADER SERIALIZATION ───────────────────────────────────────────────

export function serializeHeader(h: BlockHeader): Buffer {
  const buf = Buffer.alloc(160);
  let offset = 0;

  buf.writeUInt32LE(h.version, offset);        offset += 4;
  Buffer.from(h.prevHash, 'hex').copy(buf, offset);   offset += 32;
  Buffer.from(h.merkleRoot, 'hex').copy(buf, offset); offset += 32;
  buf.writeBigInt64LE(BigInt(h.timestamp), offset);   offset += 8;
  buf.writeUInt32LE(h.powBits, offset);        offset += 4;
  buf.writeUInt32LE(h.powNonce, offset);       offset += 4;
  buf.writeUInt32LE(h.poawBits, offset);       offset += 4;
  buf.writeUInt32LE(h.poawNonce, offset);      offset += 4;
  Buffer.from(h.minerAddress.padEnd(64, '0').substring(0, 64), 'hex').copy(buf, offset); offset += 32;
  Buffer.from(h.inferenceHash, 'hex').copy(buf, offset); offset += 32;

  return buf;
}

// ─── BLOCK HASH ───────────────────────────────────────────────────────────────

export function hashBlock(header: BlockHeader): string {
  return sha256d(serializeHeader(header)).toString('hex');
}

// ─── POAW CHALLENGE DERIVATION ────────────────────────────────────────────────

export function deriveChallenge(prevHash: string, height: number, minerAddress: string): string {
  const input = Buffer.concat([
    Buffer.from(prevHash, 'hex'),
    Buffer.alloc(4).fill(0), // height as 4 bytes LE
    Buffer.from(minerAddress.substring(0, 40).padEnd(40, '0'), 'utf8'),
  ]);
  // Write height properly
  input.writeUInt32LE(height, 32);
  return blake3(input).toString('hex');
}

// ─── POAW PROOF COMPUTATION ───────────────────────────────────────────────────

export function computePoawInput(challenge: string, inferenceHash: string, poawNonce: number): Buffer {
  const buf = Buffer.alloc(68);
  Buffer.from(challenge, 'hex').copy(buf, 0);
  Buffer.from(inferenceHash, 'hex').copy(buf, 32);
  buf.writeUInt32LE(poawNonce, 64);
  return blake3(buf);
}

export function verifyPoaw(
  prevHash: string,
  height: number,
  header: BlockHeader,
  poawTarget: string
): boolean {
  const challenge = deriveChallenge(prevHash, height, header.minerAddress);
  if (challenge !== deriveChallenge(prevHash, height, header.minerAddress)) return false;

  const poawInput = computePoawInput(challenge, header.inferenceHash, header.poawNonce);
  return meetsTarget(poawInput, poawTarget);
}

// ─── BLOCK REWARD ─────────────────────────────────────────────────────────────

export function getBlockReward(height: number): bigint {
  if (height === 0) return 0n; // genesis
  const era = Math.floor(height / HALVING_INTERVAL);
  if (era >= 64) return 0n;    // after 64 halvings, reward is 0
  return INITIAL_REWARD >> BigInt(era);
}

// ─── COINBASE TRANSACTION ─────────────────────────────────────────────────────

export function createCoinbase(height: number, minerAddress: string, fees: bigint): Transaction {
  const reward = getBlockReward(height) + fees;
  const heightBytes = Buffer.alloc(4);
  heightBytes.writeUInt32LE(height, 0);

  return {
    version: 1,
    inputs: [{
      prevTxid:  '0000000000000000000000000000000000000000000000000000000000000000',
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

// ─── ADDRESS TO SCRIPT ────────────────────────────────────────────────────────

export function addressToScript(address: string): string {
  // Simplified P2PKH-like script for testnet
  // Production would use proper bech32m decoding
  const hash = Buffer.from(address.substring(0, 40).padEnd(40, '0'), 'utf8')
                      .slice(0, 20);
  return '76a914' + hash.toString('hex') + '88ac';
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

// ─── BLOCK MERKLE ROOT ────────────────────────────────────────────────────────

export function computeMerkleRoot(txs: Transaction[]): string {
  const hashes = txs.map(tx => Buffer.from(hashTx(tx), 'hex'));
  return merkleRoot(hashes).toString('hex');
}

// ─── BLOCK VALIDATION ─────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateBlock(
  block: Block,
  prevHash: string,
  height: number,
  powTarget: string,
  poawTarget: string,
  utxoLookup: (txid: string, index: number) => bigint | null,
): ValidationResult {

  // 1. Check PoW
  const blockHash = hashBlock(block.header);
  if (!meetsTarget(Buffer.from(blockHash, 'hex'), powTarget)) {
    return { valid: false, error: `PoW target not met: ${blockHash} > ${powTarget}` };
  }

  // 2. Check PoAW
  if (!verifyPoaw(prevHash, height, block.header, poawTarget)) {
    return { valid: false, error: 'PoAW target not met' };
  }

  // 3. Check prev hash
  if (block.header.prevHash !== prevHash) {
    return { valid: false, error: `prevHash mismatch` };
  }

  // 4. Check timestamp (not more than 2 hours in future)
  const now = Math.floor(Date.now() / 1000);
  if (block.header.timestamp > now + 7200) {
    return { valid: false, error: 'Block timestamp too far in future' };
  }

  // 5. Check merkle root
  const expectedMerkle = computeMerkleRoot(block.transactions);
  if (block.header.merkleRoot !== expectedMerkle) {
    return { valid: false, error: 'Merkle root mismatch' };
  }

  // 6. Check coinbase
  if (block.transactions.length === 0) {
    return { valid: false, error: 'Block has no transactions' };
  }

  const coinbase = block.transactions[0];
  const expectedReward = getBlockReward(height);
  // TODO: sum fees from all non-coinbase txs
  if (coinbase.outputs[0].value > expectedReward + 1_000_000n) {
    return { valid: false, error: 'Coinbase reward exceeds allowed amount' };
  }

  return { valid: true };
}
