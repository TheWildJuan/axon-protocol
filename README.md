# 🔲 AXON Protocol

**Mine with intelligence, not just electricity.**

AXON is a decentralized, permissionless cryptocurrency where block production requires **Proof of Agent Work (PoAW)** — a hybrid consensus mechanism combining Bitcoin-style SHA-256d proof-of-work with verifiable AI inference proofs.

## Quick Start

```bash
# Install dependencies
cd node && npm install

# Run testnet simulation (mines 10 blocks, verifies chain)
npm test

# Start a node with RPC
npm run dev

# Mine a block via RPC
curl -X POST http://localhost:8332/mine

# Check status
curl http://localhost:8332/status

# View issuance schedule
curl http://localhost:8332/issuance
```

## Docker

```bash
docker-compose up
```

## How It Works

Every valid AXON block requires TWO proofs:

1. **SHA-256d PoW** — same as Bitcoin. Provides Sybil resistance.
2. **Proof of Agent Work (PoAW)** — miner must run a standardized open-source AI model (TinyLlama-1.1B) on a challenge derived from the previous block. The inference output hash must meet a difficulty target.

```
challenge = BLAKE3(prev_hash || block_height || miner_address)
inference_hash = SHA256(run_model(challenge))  ← must run the actual model
poaw_proof = BLAKE3(challenge || inference_hash || nonce) < poaw_target
```

Faking the `inference_hash` without running the model is computationally equivalent to SHA-256 brute force — more expensive than just running the model.

## Tokenomics

| Parameter | Value |
|-----------|-------|
| Max Supply | 21,000,000 AXN |
| Initial Block Reward | 50 AXN |
| Halving Interval | 210,000 blocks |
| Target Block Time | 10 minutes |
| Premine | None |
| Team Allocation | None |
| Admin Keys | None |

## Architecture

```
axon-protocol/
├── docs/SPEC.md          ← Full protocol specification
├── node/src/
│   ├── blockchain/
│   │   ├── constants.ts  ← Protocol parameters
│   │   ├── crypto.ts     ← SHA256d, BLAKE3, difficulty
│   │   ├── types.ts      ← Block, Transaction, UTXO types
│   │   ├── block.ts      ← Block building, validation, PoAW
│   │   └── chain.ts      ← Blockchain state, UTXO set
│   ├── mining/
│   │   └── miner.ts      ← Mining loop, inference integration
│   ├── wallet/
│   │   └── wallet.ts     ← Key generation, signing
│   ├── test/
│   │   └── simulation.ts ← Local testnet simulation
│   └── index.ts          ← Node + RPC server
└── docker-compose.yml
```

## Roadmap

- [x] v0.1 — Core blockchain, PoAW verification, mining simulation
- [ ] v0.2 — Real TinyLlama inference via llama.cpp
- [ ] v0.3 — P2P networking (libp2p)
- [ ] v0.4 — LevelDB persistence
- [ ] v0.5 — Audit challenge system
- [ ] v1.0 — Public testnet

## License

MIT — No rights reserved. Fork freely.
