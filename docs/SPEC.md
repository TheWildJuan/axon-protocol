# AXON Protocol — Full Specification
**Version:** 0.1.0 — Testnet Draft  
**Ticker:** AXN  
**Tagline:** *Mine with intelligence, not just electricity.*

---

## Executive Summary

AXON is a decentralized, permissionless cryptocurrency whose monetary policy mirrors Bitcoin's precisely — 21 million coin cap, halving every 210,000 blocks, 10-minute target block time, no premine, no team allocation, no admin keys.

The core innovation: block production requires **Proof of Agent Work (PoAW)** — a hybrid consensus mechanism where miners must satisfy both a conventional SHA-256d difficulty target AND a verifiable AI inference challenge derived deterministically from the previous block. This design preserves Bitcoin's Sybil resistance and decentralization guarantees while economically rewarding AI computation rather than pure hash grinding.

Any AI agent — running on any hardware, any framework, any provider — can mine AXON, provided it can run a standardized open-source model and produce verifiable outputs. No registration. No whitelist. No trust.

---

## 1. Tokenomics

### 1.1 Supply Schedule

```
Max Supply:           21,000,000 AXN
Initial Block Reward: 50 AXN
Halving Interval:     210,000 blocks
Target Block Time:    10 minutes
Genesis Block:        Block 0, reward = 0 (no premine)
First Mined Block:    Block 1, reward = 50 AXN
```

### 1.2 Issuance Schedule by Era

| Era | Blocks         | Block Reward | AXN Minted    | Cumulative Supply | % of Max |
|-----|----------------|--------------|---------------|-------------------|----------|
| 1   | 1–210,000      | 50.000 AXN   | 10,500,000    | 10,500,000        | 50.00%   |
| 2   | 210,001–420,000| 25.000 AXN   | 5,250,000     | 15,750,000        | 75.00%   |
| 3   | 420,001–630,000| 12.500 AXN   | 2,625,000     | 18,375,000        | 87.50%   |
| 4   | 630,001–840,000| 6.250 AXN    | 1,312,500     | 19,687,500        | 93.75%   |
| 5   | 840,001–1,050,000| 3.125 AXN  | 656,250       | 20,343,750        | 96.88%   |
| 6   | 1,050,001–...  | 1.5625 AXN   | 328,125       | 20,671,875        | 98.44%   |
| ...  | ...           | ...          | ...           | ...               | ...      |
| ∞   | ~6,930,000+    | ~0 AXN       | —             | ~21,000,000       | ~100%    |

> Supply approaches but never exceeds 21,000,000 AXN due to integer rounding (same as Bitcoin's ~20,999,999.97 BTC).

### 1.3 Hard Guarantees

- **No premine** — Block 0 is the genesis block with zero reward
- **No team allocation** — No addresses receive coins outside of mining
- **No admin mint** — No privileged key can create coins
- **No hidden inflation** — Block reward formula: `floor(50 * 10^8 / 2^era)` satoshis, where era = `floor(block_height / 210000)`
- **Transaction fees** — All unspent inputs flow to the miner; no fee burning
- **Smallest unit:** 1 Axon-satoshi = 0.00000001 AXN (10^-8)

---

## 2. Proof of Agent Work (PoAW)

### 2.1 Overview

Every valid AXON block must satisfy **two independent proofs** simultaneously:

```
valid_block = valid_pow(header) AND valid_poaw(header, poaw_proof)
```

Neither proof alone is sufficient. This means:

1. A pure GPU hash farm with no AI capability **cannot mine AXON**
2. An AI agent with no hash capability **cannot mine AXON**  
3. Only participants with both can produce valid blocks

This creates a natural market for combined AI+compute resources.

---

### 2.2 Proof A — SHA-256d (Classic PoW)

Identical to Bitcoin's PoW. The block header is hashed twice with SHA-256. The result must be numerically less than the difficulty target.

```
sha256d(header_bytes) < difficulty_target
```

**Purpose:** Sybil resistance. Prevents an attacker from flooding the network with cheap blocks.

**Difficulty:** Set independently of PoAW difficulty. Approximately **60% lower** than equivalent Bitcoin-style-only PoW, since miners also bear AI compute cost.

---

### 2.3 Proof B — Proof of Agent Work (PoAW)

#### 2.3.1 Challenge Generation

Every block includes an **AI challenge** derived deterministically from the previous block hash:

```
challenge = BLAKE3(prev_block_hash || block_height || miner_address)
```

This challenge is:
- **Unique per block attempt** — cannot be pre-computed before the previous block is known
- **Deterministic** — any verifier can re-derive it
- **Unpredictable** — depends on previous PoW solution

#### 2.3.2 The Inference Task

The challenge is used to construct an **inference task** for a standardized open-source model. The current canonical model is:

```
Model:   TinyLlama-1.1B-Chat-v1.0 (Q4_K_M quantization)
Size:    ~669 MB
Source:  Hugging Face (huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF)
Hash:    [sha256 of canonical weights file, pinned in genesis block]
```

The task format:
```json
{
  "system": "You are a precise computation assistant.",
  "user": "Challenge: {hex(challenge[:32])}. Respond with exactly: AXON:{sha256(your_reasoning_here)[:16]}"
}
```

The miner runs this prompt through the canonical model at temperature=0 (deterministic), captures the raw token output, and produces:

```
inference_output  = run_model(task, seed=0, max_tokens=64)
inference_hash    = SHA256(inference_output)
poaw_nonce        = 32-bit integer the miner varies to find a valid PoAW target
poaw_target_input = BLAKE3(challenge || inference_hash || poaw_nonce)
```

The PoAW proof is valid when:
```
poaw_target_input < poaw_difficulty_target
```

#### 2.3.3 Why This Works

- The inference output is **deterministic** given the model, weights, and input (temperature=0)
- Any verifier can re-run the same inference and get the same `inference_hash`
- The verifier recomputes `poaw_target_input` and checks it meets target
- **Faking the inference** requires producing the correct `inference_hash` without running the model — equivalent to inverting SHA-256
- **Using a different model** produces a different `inference_hash`, which will fail verification
- **Skipping inference entirely** and guessing `inference_hash` is computationally equivalent to SHA-256 brute force — more expensive than just running the model

#### 2.3.4 Verification by Nodes

Full nodes verify PoAW as follows:

```
1. Extract poaw_proof from block: { challenge_seed, inference_hash, poaw_nonce }
2. Recompute challenge = BLAKE3(prev_hash || height || miner_addr)
3. Assert challenge == poaw_proof.challenge_seed
4. Recompute poaw_target_input = BLAKE3(challenge || inference_hash || poaw_nonce)
5. Assert poaw_target_input < poaw_difficulty_target
6. OPTIONAL: Re-run model inference and assert SHA256(output) == inference_hash
```

Step 6 is **optional for light verification** but mandatory for **challenge audits** (see Section 2.4).

#### 2.3.5 PoAW Difficulty Adjustment

PoAW has its own independent difficulty target, adjusted every 2,016 blocks:

```
new_poaw_target = old_poaw_target * (actual_time / expected_time)
```

This ensures both proofs remain non-trivial as model inference speed improves.

---

### 2.4 Fraud Proof / Challenge Audit System

Since most nodes won't re-run inference on every block (too slow), AXON uses a **challenge audit** mechanism:

- Any full node may issue an **audit challenge** for any block within the last 100 blocks
- The miner of that block must respond within 20 minutes with the full inference output
- If the response's SHA256 doesn't match the `inference_hash` in the block, a **fraud proof** can be submitted
- Fraud proof results in the block being orphaned and the miner's recent coinbase becoming unspendable for 6 blocks

This creates an **economic deterrent** against fake inference proofs — the cost of getting caught outweighs the reward of skipping inference.

---

## 3. Mining Approaches — Comparison

### A. Proof of Useful AI Inference (Our Approach)

| Factor | Assessment |
|--------|------------|
| How it works | Miners run standardized model on derived challenge |
| Validation | Deterministic re-execution by any node |
| Permissionless | ✅ Yes — any hardware running the model |
| Attack vectors | Model emulator, cached outputs, hardware acceleration |
| Centralization risk | Medium — GPU farms with fast inference have advantage |
| Hardware concentration | Lower than Bitcoin PoW — CPU inference is viable |
| MVP feasibility | ✅ High |

### B. Proof of Agentic Task Completion

| Factor | Assessment |
|--------|------------|
| How it works | Miners complete real-world tasks (web searches, code writing) |
| Validation | ❌ Requires trusted oracle or subjective judgment |
| Permissionless | ❌ Needs task issuer, creates centralization |
| MVP feasibility | ❌ Low — oracle problem unsolved |

### C. Proof of Verifiable Model Execution (ZK)

| Factor | Assessment |
|--------|------------|
| How it works | ZK proof that specific model was run (EZKL, zkML) |
| Validation | ✅ Cryptographically perfect |
| Permissionless | ✅ Yes |
| Hardware concentration | High — ZK proof generation requires powerful hardware |
| MVP feasibility | ❌ Low — proof generation takes minutes per inference |

### D. Hybrid PoW + PoAI (Our Architecture) ✅ CHOSEN

| Factor | Assessment |
|--------|------------|
| How it works | Both proofs required; PoW prevents Sybil, PoAI proves AI work |
| Validation | ✅ Deterministic |
| Permissionless | ✅ Yes |
| Attack vectors | Model emulation (mitigated by canonical weights hash in genesis) |
| MVP feasibility | ✅ High |

### E. Market-Based Task Solving

| Factor | Assessment |
|--------|------------|
| How it works | Open market for AI tasks; miners compete on quality |
| Validation | ❌ Subjective quality is not objectively verifiable |
| MVP feasibility | ❌ Low |

### F. ZK Proofs of AI Computation

| Factor | Assessment |
|--------|------------|
| How it works | EZKL or Risc0 proves forward pass of transformer |
| Validation | ✅ Perfect |
| Hardware concentration | Very high |
| MVP feasibility | ❌ Currently too slow (10+ min per block) |

**Conclusion:** Hybrid PoW + Proof of Inference (Option D) is the best balance of decentralization, verifiability, and MVP feasibility.

---

## 4. Block Structure

```
Block Header (160 bytes):
  version         : 4 bytes
  prev_hash       : 32 bytes
  merkle_root     : 32 bytes
  timestamp       : 8 bytes
  pow_bits        : 4 bytes  (PoW difficulty target)
  pow_nonce       : 4 bytes
  poaw_bits       : 4 bytes  (PoAW difficulty target)
  poaw_nonce      : 4 bytes
  miner_address   : 32 bytes (for challenge derivation)
  inference_hash  : 32 bytes (SHA256 of model output)

Block Body:
  tx_count        : varint
  transactions[]  : variable
```

---

## 5. Consensus Rules

A block is valid if and only if:

1. `sha256d(header) < pow_target`
2. `BLAKE3(challenge || inference_hash || poaw_nonce) < poaw_target`
3. `challenge == BLAKE3(prev_hash || height || miner_address)`
4. `timestamp` is within 2 hours of network median time
5. Block reward ≤ `floor(50_0000_0000 / 2^era)` satoshis + sum of tx fees
6. All transaction inputs are unspent (no double-spend)
7. All transaction signatures are valid (Schnorr/secp256k1)
8. Block size ≤ 4MB
9. Merkle root matches transaction set
10. `inference_hash` uses canonical model (model hash pinned in genesis)

---

## 6. Genesis Block

```json
{
  "height": 0,
  "version": 1,
  "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "merkle_root": "0000000000000000000000000000000000000000000000000000000000000000",
  "timestamp": "2026-03-12T00:00:00Z",
  "pow_bits": "1d00ffff",
  "pow_nonce": 0,
  "poaw_bits": "1d00ffff",
  "poaw_nonce": 0,
  "miner_address": "0000000000000000000000000000000000000000000000000000000000000000",
  "inference_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "canonical_model_hash": "TINYLLAMA_Q4_KM_SHA256_PLACEHOLDER",
  "message": "AXON Genesis — Mine with intelligence, not just electricity. 2026-03-12",
  "transactions": [],
  "reward": 0
}
```

---

## 7. Network

- **P2P:** TCP, port 8333 (same as Bitcoin for familiarity)
- **Message types:** `version`, `verack`, `inv`, `getdata`, `block`, `tx`, `ping`, `pong`, `getblocks`, `getheaders`
- **Bootstrap nodes:** DNS seeds + hardcoded genesis peers
- **Max peers:** 125 (same as Bitcoin)

---

## 8. Wallet

- **Key format:** secp256k1 keypairs
- **Signature scheme:** Schnorr (simpler than ECDSA, same security)
- **Address format:** Bech32m (`axon1...`)
- **HD wallet:** BIP-32 compatible derivation paths

---

## 9. Attack Vectors & Mitigations

| Attack | Mitigation |
|--------|-----------|
| Model emulation (fake inference hash) | Audit challenge system; economic penalty |
| Pre-cached inference outputs | Challenge derived from previous PoW solution — unknowable in advance |
| Centralized model hosting | Model weights are public, run locally — no API dependency |
| 51% attack | Same as Bitcoin — requires majority of combined PoW+PoAW hashrate |
| Inference acceleration (GPU) | Expected and acceptable — same as ASIC acceptance in Bitcoin |
| Empty audit response | Coinbase unspendable for 6 blocks — economic deterrent |
| Model substitution | Canonical model hash enforced in consensus rules |

---

## 10. Roadmap

| Phase | Milestone |
|-------|-----------|
| v0.1 | Local testnet — single node, mining simulation |
| v0.2 | P2P networking — multi-node testnet |
| v0.3 | Real model integration — TinyLlama inference |
| v0.4 | Wallet CLI — send/receive AXN |
| v0.5 | Audit challenge system live |
| v1.0 | Public testnet launch |
| v1.1 | Mainnet genesis |
