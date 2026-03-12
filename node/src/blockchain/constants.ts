// ─── AXON PROTOCOL CONSTANTS ──────────────────────────────────────────────────

export const COIN = 100_000_000n;               // 1 AXN = 100,000,000 satoshis
export const MAX_SUPPLY = 21_000_000n * COIN;   // 21 million AXN
export const INITIAL_REWARD = 50n * COIN;       // 50 AXN per block, era 1
export const HALVING_INTERVAL = 210_000;        // blocks per era
export const TARGET_BLOCK_TIME = 600;           // 10 minutes in seconds
export const DIFFICULTY_ADJUSTMENT_INTERVAL = 2_016; // blocks between adjustments
export const MAX_BLOCK_SIZE = 4_000_000;        // 4 MB
export const COINBASE_MATURITY = 100;           // blocks before coinbase spendable
export const AUDIT_WINDOW = 100;               // blocks subject to audit challenge

// Genesis block timestamp
export const GENESIS_TIMESTAMP = Math.floor(new Date('2026-03-12T00:00:00Z').getTime() / 1000);

// Canonical model pinned in genesis
// SHA256 verified: sha256sum ~/.axon/models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf
export const CANONICAL_MODEL = {
  name:       'TinyLlama-1.1B-Chat-v1.0-Q4_K_M',
  sha256:     '9fecc3b3cd76bba89d504f29b616eedf7da85b96540e490ca5824d3f7d2776a0',
  size_bytes: 638_957_696,  // 638MB actual on disk
  hf_repo:    'TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF',
};

// Initial difficulty targets (testnet — easy for simulation)
export const INITIAL_POW_TARGET = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
export const INITIAL_POAW_TARGET = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
export const TESTNET_POW_TARGET  = '00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
export const TESTNET_POAW_TARGET = '0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

export const NETWORK_MAGIC = Buffer.from('AXON', 'ascii');
export const DEFAULT_PORT = 8333;
export const RPC_PORT = 8332;
