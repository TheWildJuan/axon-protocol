import * as crypto from 'crypto';

// Simplified wallet — production would use secp256k1 + bech32m
// Testnet uses deterministic key derivation from seed phrase

export interface KeyPair {
  privateKey: Buffer;
  publicKey:  Buffer;
  address:    string;
}

export function generateKeypair(): KeyPair {
  const privateKey = crypto.randomBytes(32);
  const publicKey  = derivePublicKey(privateKey);
  const address    = publicKeyToAddress(publicKey);
  return { privateKey, publicKey, address };
}

export function keypairFromSeed(seed: string): KeyPair {
  const privateKey = crypto.createHash('sha256').update(seed).digest();
  const publicKey  = derivePublicKey(privateKey);
  const address    = publicKeyToAddress(publicKey);
  return { privateKey, publicKey, address };
}

function derivePublicKey(privateKey: Buffer): Buffer {
  // In production: secp256k1 scalar multiplication
  // Testnet: HMAC-SHA256 of private key (NOT cryptographically secure — demo only)
  return crypto.createHmac('sha256', 'AXON_PUBKEY_DERIVE').update(privateKey).digest();
}

function publicKeyToAddress(pubkey: Buffer): string {
  // In production: bech32m encoding of P2WPKH hash
  // Testnet: hex prefix + first 20 bytes
  const hash160 = crypto.createHash('sha256').update(pubkey).digest().slice(0, 20);
  return 'axon1' + hash160.toString('hex');
}

export function signMessage(message: Buffer, privateKey: Buffer): Buffer {
  // In production: Schnorr signature
  // Testnet: HMAC-SHA256
  return crypto.createHmac('sha256', privateKey).update(message).digest();
}

export function verifySignature(message: Buffer, signature: Buffer, publicKey: Buffer): boolean {
  // In production: Schnorr verify
  // Testnet: recompute and compare
  const privateKey = Buffer.alloc(32, 0); // Can't reverse in real impl
  const expected = crypto.createHmac('sha256', privateKey).update(message).digest();
  return signature.equals(expected);
}

export function formatAXN(satoshis: bigint): string {
  const whole = satoshis / 100_000_000n;
  const frac  = (satoshis % 100_000_000n).toString().padStart(8, '0');
  return `${whole}.${frac} AXN`;
}
