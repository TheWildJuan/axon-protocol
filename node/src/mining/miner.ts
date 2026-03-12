import * as crypto from 'crypto';
import { Block, BlockHeader, Transaction } from '../blockchain/types';
import { hashBlock, deriveChallenge, computePoawInput, createCoinbase, computeMerkleRoot, hashTx } from '../blockchain/block';
import { sha256d, meetsTarget, blake3 } from '../blockchain/crypto';
import { Blockchain } from '../blockchain/chain';
import { TESTNET_POW_TARGET, TESTNET_POAW_TARGET } from '../blockchain/constants';

// ─── SIMULATED AI INFERENCE ───────────────────────────────────────────────────
// In production: replaced with actual llama.cpp TinyLlama inference
// In testnet simulation: deterministic SHA-256 of challenge (mimics fixed-output model)

export function simulateInference(challenge: string): string {
  // Simulate: feed challenge to "model" → get deterministic output
  // Real version: run TinyLlama with temperature=0 and return SHA256 of output tokens
  const simulatedOutput = crypto
    .createHash('sha256')
    .update(Buffer.from('AXON_MODEL_v1:' + challenge, 'utf8'))
    .digest('hex');

  console.log(`  [PoAW] Simulated inference: challenge=${challenge.substring(0,16)}... → ${simulatedOutput.substring(0,16)}...`);
  return simulatedOutput; // This is the inference_hash
}

export async function runRealInference(challenge: string): Promise<string> {
  // Production implementation:
  // 1. Construct prompt from challenge
  // 2. Run llama.cpp with TinyLlama-1.1B-Chat-v1.0-Q4_K_M, temperature=0
  // 3. Capture raw output tokens
  // 4. Return SHA256(output)
  //
  // const { execSync } = require('child_process');
  // const prompt = `Challenge: ${challenge.substring(0,32)}. Respond: AXON:${challenge.substring(32,48)}`;
  // const output = execSync(`./llama-cli -m tinyllama.gguf -p "${prompt}" --temp 0 -n 64 2>/dev/null`);
  // return crypto.createHash('sha256').update(output).digest('hex');

  return simulateInference(challenge); // Fallback for testnet
}

// ─── MINING LOOP ──────────────────────────────────────────────────────────────

export interface MineResult {
  block:     Block;
  duration:  number;
  hashrate:  number; // hashes per second
}

export async function mineBlock(
  chain: Blockchain,
  minerAddress: string,
  extraTxs: Transaction[] = [],
  useRealInference = false,
): Promise<MineResult> {
  const startTime = Date.now();
  const state     = chain.getState();
  const height    = state.height + 1;
  const prevHash  = state.bestBlockHash;
  const powTarget = state.powTarget;
  const poawTarget = state.poawTarget;

  console.log(`\n[MINER] Mining block ${height}`);
  console.log(`  prevHash:   ${prevHash.substring(0,32)}...`);
  console.log(`  powTarget:  ${powTarget.substring(0,32)}...`);
  console.log(`  poawTarget: ${poawTarget.substring(0,32)}...`);

  // Step 1: Derive PoAW challenge
  const challenge = deriveChallenge(prevHash, height, minerAddress);
  console.log(`  [PoAW] Challenge: ${challenge.substring(0,32)}...`);

  // Step 2: Run AI inference to get inference_hash
  const inferenceHash = useRealInference
    ? await runRealInference(challenge)
    : simulateInference(challenge);

  console.log(`  [PoAW] inferenceHash: ${inferenceHash.substring(0,32)}...`);

  // Step 3: Build transactions
  const coinbase = createCoinbase(height, minerAddress, 0n);
  coinbase.txid  = hashTx(coinbase);
  const allTxs   = [coinbase, ...extraTxs];

  const merkle   = computeMerkleRoot(allTxs);

  // Step 4: Mine — find nonces satisfying both PoW AND PoAW targets
  let powNonce  = 0;
  let poawNonce = 0;
  let hashes    = 0;
  let powFound  = false;
  let poawFound = false;

  console.log(`  [MINE] Searching for valid nonces...`);

  // First find PoAW nonce (AI proof)
  for (poawNonce = 0; poawNonce < 0x100000000; poawNonce++) {
    const poawInput = computePoawInput(challenge, inferenceHash, poawNonce);
    if (meetsTarget(poawInput, poawTarget)) {
      poawFound = true;
      console.log(`  [PoAW] Found! nonce=${poawNonce} in ${poawNonce} iterations`);
      break;
    }
  }

  if (!poawFound) throw new Error('PoAW search exhausted');

  // Then find PoW nonce (hash grinding)
  for (powNonce = 0; powNonce < 0x100000000; powNonce++) {
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
      powFound = true;
      const duration  = (Date.now() - startTime) / 1000;
      const hashrate  = Math.round(hashes / duration);

      console.log(`  [PoW] Found! nonce=${powNonce} | hash=${blockHash.substring(0,32)}...`);
      console.log(`  [MINE] Block mined in ${duration.toFixed(2)}s | ${hashrate} H/s`);

      const block: Block = {
        header,
        transactions: allTxs,
        hash:   blockHash,
        height,
      };

      return { block, duration, hashrate };
    }
  }

  throw new Error('PoW nonce space exhausted');
}
