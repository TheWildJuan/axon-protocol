/**
 * AXON Protocol — Wallet
 * Real secp256k1 (elliptic), BIP39 mnemonics, BIP32 HD derivation
 * Derivation path: m/44'/7777'/0'/0/<index>  (coin type 7777 = AXON)
 */

import * as crypto from 'crypto';
import * as bip39  from 'bip39';
import { HDKey }   from '@scure/bip32';
import { ec as EC } from 'elliptic';

const ec = new EC('secp256k1');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const AXON_COIN_TYPE   = 7777;
const ADDRESS_PREFIX   = 'axon1';

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface Keypair {
  privateKeyHex: string;
  publicKeyHex:  string;   // 33-byte compressed
  address:       string;   // axon1<hash160 hex>
  pubKeyHash:    string;   // hex RIPEMD160(SHA256(pubkey))
}

// ─── HASH160 ─────────────────────────────────────────────────────────────────

function hash160(buf: Buffer): Buffer {
  const sha = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('ripemd160').update(sha).digest();
}

function pubkeyToAddress(compressedPubKey: Buffer): { address: string; pubKeyHash: string } {
  const h160       = hash160(compressedPubKey);
  const pubKeyHash = h160.toString('hex');
  return { address: ADDRESS_PREFIX + pubKeyHash, pubKeyHash };
}

// ─── WALLET GENERATION ───────────────────────────────────────────────────────

/**
 * Generate a new wallet with a random BIP39 mnemonic.
 * strength=256 → 24 words (recommended)
 * strength=128 → 12 words
 */
export function generateWallet(strength: 128 | 256 = 256): {
  mnemonic: string;
  keypair:  Keypair;
} {
  const mnemonic = bip39.generateMnemonic(strength);
  const keypair  = keypairFromMnemonic(mnemonic);
  return { mnemonic, keypair };
}

/**
 * Derive keypair from BIP39 mnemonic via BIP32 HD path.
 */
export function keypairFromMnemonic(mnemonic: string, index = 0): Keypair {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid BIP39 mnemonic');
  }
  const seed  = bip39.mnemonicToSeedSync(mnemonic);
  const hd    = HDKey.fromMasterSeed(seed);
  const path  = `m/44'/${AXON_COIN_TYPE}'/0'/0/${index}`;
  const child = hd.derive(path);

  if (!child.privateKey || !child.publicKey) {
    throw new Error('HD derivation failed');
  }

  const privHex = Buffer.from(child.privateKey).toString('hex');
  const pubHex  = Buffer.from(child.publicKey).toString('hex');
  const { address, pubKeyHash } = pubkeyToAddress(Buffer.from(child.publicKey));

  return { privateKeyHex: privHex, publicKeyHex: pubHex, address, pubKeyHash };
}

/**
 * Derive keypair from a raw hex seed string (testnet/simulation only).
 * Uses SHA-256 of seed as private key. NOT for real funds.
 */
export function keypairFromSeed(seed: string): Keypair {
  const privBytes = crypto.createHash('sha256').update(seed).digest();
  const keyPair   = ec.keyFromPrivate(privBytes);
  const pubBytes  = Buffer.from(keyPair.getPublic(true, 'array'));
  const privHex   = privBytes.toString('hex');
  const pubHex    = pubBytes.toString('hex');
  const { address, pubKeyHash } = pubkeyToAddress(pubBytes);

  return { privateKeyHex: privHex, publicKeyHex: pubHex, address, pubKeyHash };
}

// ─── SIGNING ─────────────────────────────────────────────────────────────────

/**
 * Sign a 32-byte hash with a private key (secp256k1 ECDSA).
 * Returns DER-encoded signature as hex string.
 */
export function signTx(txHash: Buffer, privateKeyHex: string): string {
  const keyPair = ec.keyFromPrivate(Buffer.from(privateKeyHex, 'hex'));
  const sig     = keyPair.sign(txHash, { canonical: true }); // low-S
  return Buffer.from(sig.toDER()).toString('hex');
}

/**
 * Verify a secp256k1 DER signature.
 */
export function verifyTxSig(
  txHash:       Buffer,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  try {
    const keyPair = ec.keyFromPublic(Buffer.from(publicKeyHex, 'hex'));
    const sigBytes = Buffer.from(signatureHex, 'hex');
    return keyPair.verify(txHash, sigBytes);
  } catch {
    return false;
  }
}

// ─── SCRIPT BUILDING ─────────────────────────────────────────────────────────

/**
 * Build a P2PKH scriptSig: <sig_len><DER_sig><pubkey_len><compressed_pubkey>
 */
export function buildScriptSig(signatureHex: string, publicKeyHex: string): string {
  const sigBuf = Buffer.from(signatureHex, 'hex');
  const pkBuf  = Buffer.from(publicKeyHex, 'hex');
  const sigLen = sigBuf.length.toString(16).padStart(2, '0');
  const pkLen  = pkBuf.length.toString(16).padStart(2, '0');
  return sigLen + signatureHex + pkLen + publicKeyHex;
}

// ─── MNEMONIC UTILS ──────────────────────────────────────────────────────────

export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic);
}

// ─── FORMATTING ──────────────────────────────────────────────────────────────

export function formatAXN(satoshis: bigint): string {
  const abs   = satoshis < 0n ? -satoshis : satoshis;
  const whole = abs / 100_000_000n;
  const frac  = abs % 100_000_000n;
  const sign  = satoshis < 0n ? '-' : '';
  return `${sign}${whole}.${frac.toString().padStart(8, '0')} AXN`;
}
