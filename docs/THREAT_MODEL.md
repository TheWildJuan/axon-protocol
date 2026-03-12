# AXON Protocol — Threat Model & Honest Assessment

**Version:** 0.1.0  
**Classification:** Brutally Honest Analysis

---

## Preface: What This Document Does

This document does not sell you on AXON. It tells you where it works, where it doesn't, what can be gamed, and what can't. If you are evaluating this protocol for real deployment, read this first.

---

## 1. What Kind of System Is AXON?

**Honest classification:**

AXON is a **hybrid proof-of-work system** with an AI inference eligibility requirement. It is closest to:

- **Bitcoin PoW** — in its monetary policy, block structure, and Sybil resistance model
- **Proof of Useful Work** — in intent (AI inference is "useful" computation)
- **NOT proof-of-stake** — no capital staking required
- **NOT fully trustless** — the AI work proof has verification gaps (see below)

It is **not** a system where AI work is cryptographically proven to be useful. The model output is verified to be *consistent* (deterministic given fixed weights and input), but not *useful* in the real-world sense. The system verifies that you ran the model. It does not verify that the output was valuable.

---

## 2. Where Decentralization Succeeds

| Property | Status | Evidence |
|----------|--------|---------|
| No premine | ✅ True | Genesis block has zero reward; verified in code |
| No admin keys | ✅ True | No privileged key in protocol spec |
| Permissionless entry | ✅ True | Any node can mine with correct model + hash |
| Open source model | ✅ True | TinyLlama weights are public, run locally |
| No registration | ✅ True | No miner registry in consensus rules |
| No single AI provider | ✅ True | Model runs locally via llama.cpp |
| Bitcoin monetary policy | ✅ True | 21M cap, halvings, no inflation |
| Independent verification | ✅ True | Any node can re-run inference and check hash |

---

## 3. Where Centralization May Creep In

### 3.1 Model Governance Problem ⚠️ SERIOUS

**The issue:** The canonical model is pinned in the genesis block. When a better model replaces TinyLlama, *who decides what the new canonical model is?*

In Bitcoin, difficulty adjusts automatically. There is no equivalent for "model upgrades" — someone must propose a fork.

**Centralization risk:** Whoever controls the "model upgrade fork" proposal process gains disproportionate influence. If this becomes an informal process dominated by a few developers, AXON becomes developer-governed, not rule-governed.

**Mitigation options:**
- Require supermajority of hashpower to approve model upgrades (BIP-style)
- Pin model hash permanently and never upgrade (limits capability)
- Allow multiple canonical models with different difficulty targets

**Current MVP status:** Unresolved. This is a protocol-level governance gap.

---

### 3.2 GPU/ASIC Inference Concentration ⚠️ MODERATE

**The issue:** TinyLlama inference on a high-end GPU is 50-100x faster than on a CPU. As mining becomes profitable, GPU farms will dominate.

**Is this different from Bitcoin ASICs?** Partially. Bitcoin ASICs create near-total centralization. GPU inference has lower economies of scale and more commodity hardware competition. But the direction is the same — hardware concentration increases over time.

**Honest assessment:** AXON does NOT solve mining centralization. It *shifts* the hardware profile from SHA-256 ASICs toward GPU/NPU inference accelerators. Whether this is "better" depends on your values.

**Mitigation options:**
- Increase model size over time (makes memory bandwidth the bottleneck, favoring commodity hardware)
- Require multiple different model inference tasks (harder to build specialized hardware for)
- Enforce minimum inference time (prevents ultra-fast hardware from dominating)

---

### 3.3 Inference Verification Gap ⚠️ MODERATE-SERIOUS

**The issue:** Full nodes do NOT re-run inference on every block by default. They verify the `inference_hash` meets the difficulty target, but they trust that the hash came from the canonical model.

**The attack:** A sophisticated miner could:
1. Pre-compute all possible challenges for the next ~10 blocks (knowing prev_hash is predictable if you mine your own prior block)
2. Cache all inference outputs
3. Mine significantly faster by eliminating inference latency from the critical path

**Is this fatal?** No. The challenge includes `prev_block_hash`, which is unknowable before the block is produced. You cannot pre-compute the inference for a block you haven't mined yet. But you CAN run inference in parallel with hash grinding, which is actually the correct mining strategy.

**The deeper issue:** A miner could also build an "inference emulator" — a lookup table or cheap approximation of TinyLlama that produces plausible-looking output hashes. Without ZK proofs, this cannot be fully ruled out.

**Current mitigation:** Audit challenge system (Section 2.4 of SPEC.md). Miners must respond to random audit requests or face block invalidation. Statistically, a cheater will get caught within ~50 blocks.

**Honest rating:** 7/10 secure. Not cryptographically perfect. Economically deterred.

---

### 3.4 Sybil Attack on Audit System ⚠️ LOW

**The issue:** An attacker could flood the network with audit challenges to slow down honest miners.

**Mitigation:** Audit challenges require a small PoW stamp to submit (prevents cheap flooding). Already specced.

---

### 3.5 Model Emulation Attack 🔴 THEORETICAL BUT IMPORTANT

**The scenario:** An attacker trains a small neural network to *mimic* TinyLlama's output distribution for the specific challenge format. The mimic model is 10x faster.

**Why this matters:** If a mimic can produce outputs that hash to values meeting the PoAW target, the attacker mines without running the real model.

**Why it's hard:** The inference hash must equal `SHA256(exact_output_of_TinyLlama)`. Even a 99.9% accurate mimic produces different tokens on 0.1% of outputs, which changes the SHA256 completely. Matching exact token sequences is essentially equivalent to running the model.

**Honest rating:** Low risk in practice. High risk if quantum-adjacent ML techniques (exact model distillation) improve dramatically.

---

### 3.6 51% Attack ⚠️ SAME AS BITCOIN EARLY DAYS

AXON uses combined PoW + PoAW hashrate for chain selection. A 51% attacker needs to dominate BOTH proof systems simultaneously. This actually makes 51% attacks *harder* than pure PoW in the early network, but as mining pools form, the same centralization dynamics as Bitcoin apply.

---

## 4. Can the AI-Work Proof Be Gamed?

| Attack | Feasibility | Mitigation | Confidence |
|--------|-------------|------------|------------|
| Skip inference entirely, guess hash | Near-zero | SHA-256 brute force harder than inference | High |
| Build inference emulator | Low-medium | Exact output matching required | Medium |
| Cache outputs across similar challenges | None | Challenge is unique per block | High |
| Use different (faster) model | Produces wrong hash | Model hash pinned in genesis | High |
| Pre-compute future challenges | Partial only | Requires knowing prev_hash in advance | Medium |
| Audit evasion | Hard | Penalty system + economic cost | Medium |
| Pool collusion on inference | Possible | Same as Bitcoin pool risk | Low mitigation |

**Bottom line:** The proof can be partially gamed by sophisticated actors. It cannot be fully bypassed. The system is best described as *economically rational* rather than *cryptographically perfect*.

---

## 5. Hardware Concentration Analysis

| Scenario | Winner | Concentration Level |
|----------|--------|-------------------|
| Early testnet | CPU miners (anyone) | Low — commodity hardware |
| 6 months post-launch | GPU miners (RTX 4090, H100) | Medium |
| 1 year post-launch | GPU data centers, AI cloud providers | High |
| 2+ years | Potential custom NPU ASICs | Very High |

**Honest projection:** AXON will eventually face hardware concentration. The timeline is slower than Bitcoin (GPUs are more general-purpose than SHA-256 ASICs), but the endpoint is similar. This is not a solvable problem with current cryptography — it is a fundamental property of any PoW-adjacent system.

---

## 6. Comparison: How Close Is AXON to Its Inspirations?

| Property | Bitcoin | AXON | PoS Systems | Proof-of-Useful-Work (Filecoin) |
|----------|---------|------|-------------|--------------------------------|
| No premine | ✅ | ✅ | Sometimes | Sometimes |
| Permissionless | ✅ | ✅ | Sometimes | ✅ |
| Sybil resistance | SHA-256 | SHA-256d + PoAW | Capital stake | Storage proofs |
| Verification | Perfect | Good (auditable) | Perfect | Perfect |
| Energy use | Very high | High (inference) | Very low | Medium |
| Hardware centralization | Very high (ASICs) | Medium-high (GPUs) | Low | Medium |
| Monetary policy | Fixed | Bitcoin-identical | Variable | Variable |
| "Useful" work | No | Partially | No | Yes (storage) |

**Classification:** AXON is closest to **Bitcoin** with a **proof-of-useful-work eligibility layer**. It is NOT fully trustless (audit system requires honest network majority). It IS permissionless. It IS more energy-efficient than Bitcoin (inference uses less power per hash-equivalent than SHA-256 grinding).

---

## 7. Limitations That Cannot Be Fixed Without Protocol Changes

1. **Model governance** — no decentralized model upgrade mechanism exists yet
2. **ZK inference proofs** — perfect verifiability requires ZK-ML (3-5 years from production-ready)
3. **Hardware centralization** — inevitable under any PoW-adjacent design
4. **Inference emulation** — theoretically possible with sufficiently advanced ML
5. **Audit system trust assumption** — requires honest majority for audit challenges to work

---

## 8. Upgrade Paths

### Near-term (v0.2-v0.5)
- Larger model (Phi-3 Mini 3.8B) — better outputs, harder to emulate
- Multiple model tasks per block — harder to specialize hardware for
- Minimum inference time enforcement — prevents ultra-fast emulators

### Medium-term (v1.0-v2.0)
- EZKL ZK proofs of inference — once proof generation time drops below 30 seconds
- Decentralized model governance via on-chain voting
- Merged mining with existing GPU chains

### Long-term
- Full ZK-ML — cryptographic proof of exact model execution
- Layer 2 for AI task results with Layer 1 AXON as settlement
- Cross-chain AI oracle integration

---

## 9. Honest Final Assessment

**What AXON gets right:**
- Bitcoin monetary policy, exactly replicated
- Permissionless participation
- No central party controls mining
- Energy use shifted toward useful computation (vs pure hash grinding)
- Economically deters inference fraud without requiring perfect cryptographic proofs

**What AXON gets wrong or leaves unsolved:**
- Model governance is centralized by default (developer fork control)
- AI work is "verified as consistent" not "verified as useful"
- Hardware centralization will occur, just slower than Bitcoin
- Audit system relies on honest network majority, not pure cryptography

**Recommendation:** AXON is a sound foundation for a next-generation cryptocurrency. It should NOT be marketed as "trustless AI mining" — it is more accurately described as "economically-incentivized honest AI inference with audit-based fraud deterrence." That's genuinely innovative and genuinely useful. It just isn't perfect.

*Honesty is the foundation of trust. Build on it.*
