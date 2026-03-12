/**
 * AXON Protocol — Miner
 * Supports real TinyLlama inference (via llama.cpp) with
 * automatic fallback to deterministic simulation for testnet.
 */

import * as crypto from 'crypto';
import { Block, BlockHeader, Transaction } from '../blockchain/types';
import { hashBlock, deriveChallenge, computePoawInput, createCoinbase, computeMerkleRoot, hashTx } from '../blockchain/block';
import { sha256d, meetsTarget, blake3 } from '../blockchain/crypto';
import { Blockchain } from '../blockchain/chain';
import { isInferenceReady, runRealInference } from './inference';

// ─── SIMULATED INFERENCE (testnet fallback) ───────────────────────────────────

export function simulateInference(challenge: string): string {
  const output = crypto
    .createHash('sha256')
    .update(Buffer.from('AXON_MODEL_v1:' + challenge, 'utf8'))
    .digest('hex');
  console.log(`  [PoAW] Simulated inference: challenge=${challenge.substring(0,16)}... → ${output.substring(0,16)}...`);
  return output;
}

// ─── MINING RESULT ────────────────────────────────────────────────────────────

export interface MineResult {
  block:          Block;
  duration:       number;
  hashrate:       number;
  usedRealInfer:  boolean;
  inferenceMs:    number;
}

// ─── MAIN MINING LOOP ─────────────────────────────────────────────────────────

export async function mineBlock(
  chain:            Blockchain,
  minerAddress:     string,
  extraTxs:         Transaction[] = [],
  forceSimulation = false,
): Promise<MineResult> {
  const startTime  = Date.now();
  const state      = chain.getState();
  const height     = state.height + 1;
  const prevHash   = state.bestBlockHash;
  const powTarget  = state.powTarget;
  const poawTarget = state.poawTarget;

  // Decide whether to use real inference
  const useReal = !forceSimulation && isInferenceReady();

  console.log(`\n[MINER] Mining block ${height} [${useReal ? '🤖 real inference' : '⚡ simulated'}]`);
  console.log(`  prevHash:   ${prevHash.substring(0,32)}...`);
  console.log(`  powTarget:  ${powTarget.substring(0,32)}...`);
  console.log(`  poawTarget: ${poawTarget.substring(0,32)}...`);

  // ── Step 1: Derive PoAW challenge ─────────────────────────────────────────
  const challenge = deriveChallenge(prevHash, height, minerAddress);
  console.log(`  [PoAW] Challenge: ${challenge.substring(0,32)}...`);

  // ── Step 2: AI Inference ──────────────────────────────────────────────────
  const inferStart = Date.now();
  let inferenceHash: string;

  if (useReal) {
    console.log(`  [PoAW] Running TinyLlama inference (${challenge.substring(0,16)}...)...`);
    try {
      inferenceHash = await runRealInference(challenge);
      console.log(`  [PoAW] Real inference: ${inferenceHash.substring(0,32)}... (${Date.now() - inferStart}ms)`);
    } catch (err: any) {
      console.warn(`  [PoAW] Real inference failed: ${err.message}`);
      console.warn(`  [PoAW] Falling back to simulation`);
      inferenceHash = simulateInference(challenge);
    }
  } else {
    inferenceHash = simulateInference(challenge);
  }

  const inferenceMs = Date.now() - inferStart;

  // ── Step 3: Build block ───────────────────────────────────────────────────
  const coinbase = createCoinbase(height, minerAddress, 0n);
  coinbase.txid  = hashTx(coinbase);
  const allTxs   = [coinbase, ...extraTxs];
  const merkle   = computeMerkleRoot(allTxs);

  // ── Step 4: Find PoAW nonce ───────────────────────────────────────────────
  console.log(`  [MINE] Searching for valid nonces...`);
  let poawNonce = 0;
  for (poawNonce = 0; poawNonce < 0x100000000; poawNonce++) {
    const poawInput = computePoawInput(challenge, inferenceHash, poawNonce);
    if (meetsTarget(poawInput, poawTarget)) {
      console.log(`  [PoAW] Found! nonce=${poawNonce}`);
      break;
    }
  }

  // ── Step 5: Find PoW nonce ────────────────────────────────────────────────
  let hashes = 0;
  for (let powNonce = 0; powNonce < 0x100000000; powNonce++) {
    hashes++;

    const header: BlockHeader = {
      version:       1,
      prevHash,
      merkleRoot:    merkle,
      timestamp:     Math.floor(Date.now() / 1000),
      powBits:       0x1d00ffff,
      powNonce,
      poawBits:      0x1d00ffff,
      poawNonce,
      minerAddress,
      inferenceHash,
    };

    const blockHash = hashBlock(header);
    if (meetsTarget(Buffer.from(blockHash, 'hex'), powTarget)) {
      const duration = (Date.now() - startTime) / 1000;
      const hashrate = Math.round(hashes / duration);

      console.log(`  [PoW] Found! nonce=${powNonce} | hash=${blockHash.substring(0,32)}...`);
      console.log(`  [MINE] Block mined in ${duration.toFixed(2)}s | ${hashrate} H/s`);

      return {
        block: { header, transactions: allTxs, hash: blockHash, height },
        duration,
        hashrate,
        usedRealInfer: useReal,
        inferenceMs,
      };
    }
  }

  throw new Error('PoW nonce space exhausted');
}
