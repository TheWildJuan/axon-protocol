// ─── AXON PROTOCOL TYPES ──────────────────────────────────────────────────────

export interface BlockHeader {
  version:        number;
  prevHash:       string;   // hex
  merkleRoot:     string;   // hex
  timestamp:      number;   // unix seconds
  powBits:        number;   // compact difficulty target for PoW
  powNonce:       number;   // 32-bit nonce for PoW
  poawBits:       number;   // compact difficulty target for PoAW
  poawNonce:      number;   // 32-bit nonce for PoAW
  minerAddress:   string;   // bech32 address — used in challenge derivation
  inferenceHash:  string;   // SHA-256 of model inference output (hex)
}

export interface PoAWProof {
  challengeSeed:  string;   // BLAKE3(prevHash || height || minerAddress) hex
  inferenceHash:  string;   // SHA256(model_output) hex
  poawNonce:      number;
  // Optional: full inference output (for audit responses)
  inferenceOutput?: string;
}

export interface Transaction {
  version:  number;
  inputs:   TxInput[];
  outputs:  TxOutput[];
  locktime: number;
  // Computed fields
  txid?:    string;
  size?:    number;
}

export interface TxInput {
  prevTxid:  string;   // '00...00' for coinbase
  prevIndex: number;   // 0xffffffff for coinbase
  scriptSig: string;   // hex
  sequence:  number;
}

export interface TxOutput {
  value:        bigint;  // satoshis
  scriptPubKey: string;  // hex — P2PKH or P2WPKH
}

export interface Block {
  header:       BlockHeader;
  transactions: Transaction[];
  // Computed
  hash?:        string;
  height?:      number;
  size?:        number;
}

export interface BlockchainState {
  height:           number;
  bestBlockHash:    string;
  totalWork:        bigint;
  powTarget:        string;    // hex
  poawTarget:       string;    // hex
  lastAdjustTime:   number;
}

export interface UTXO {
  txid:        string;
  index:       number;
  value:       bigint;
  scriptPubKey: string;
  blockHeight: number;
  coinbase:    boolean;
}

export interface MempoolEntry {
  tx:           Transaction;
  addedAt:      number;
  feePerByte:   number;
}

export interface PeerInfo {
  id:        string;
  address:   string;
  port:      number;
  version:   number;
  height:    number;
  connectedAt: number;
}
