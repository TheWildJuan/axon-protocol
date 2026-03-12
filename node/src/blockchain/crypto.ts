import * as crypto from 'crypto';

// SHA-256 single pass
export function sha256(data: Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

// SHA-256d (double SHA-256, Bitcoin-style)
export function sha256d(data: Buffer): Buffer {
  return sha256(sha256(data));
}

// BLAKE3 — used for PoAW challenge derivation
// Using SHA-256 as BLAKE3 substitute until native bindings available in this env
export function blake3(data: Buffer): Buffer {
  // Production: use actual BLAKE3. Testnet: use SHA3-256 as substitute
  return crypto.createHash('sha3-256').update(data).digest();
}

// Merkle root of an array of transaction hashes
export function merkleRoot(hashes: Buffer[]): Buffer {
  if (hashes.length === 0) {
    return Buffer.alloc(32, 0);
  }
  if (hashes.length === 1) {
    return sha256d(hashes[0]);
  }

  let level = hashes.map(h => sha256d(h));

  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left  = level[i];
      const right = level[i + 1] || left; // duplicate last if odd
      next.push(sha256d(Buffer.concat([left, right])));
    }
    level = next;
  }

  return level[0];
}

// Check if a hash meets a difficulty target (both as hex strings)
export function meetsTarget(hash: Buffer, target: string): boolean {
  const hashHex   = hash.toString('hex');
  const targetHex = target.padStart(64, '0');
  return hashHex <= targetHex;
}

// Convert compact bits to target hex (Bitcoin-style)
export function bitsToTarget(bits: number): string {
  const exponent = bits >>> 24;
  const mantissa = bits & 0xffffff;
  const targetBytes = Buffer.alloc(32, 0);
  const start = 32 - exponent;
  if (start >= 0 && start < 32) {
    targetBytes[start]     = (mantissa >> 16) & 0xff;
    if (start + 1 < 32) targetBytes[start + 1] = (mantissa >> 8) & 0xff;
    if (start + 2 < 32) targetBytes[start + 2] =  mantissa       & 0xff;
  }
  return targetBytes.toString('hex');
}

// Convert target hex to compact bits
export function targetToBits(targetHex: string): number {
  const target = Buffer.from(targetHex.padStart(64, '0'), 'hex');
  let exponent = 32;
  while (exponent > 0 && target[32 - exponent] === 0) exponent--;
  const mantissa = (target[32 - exponent] << 16) |
                   (target[32 - exponent + 1] << 8) |
                    target[32 - exponent + 2];
  return (exponent << 24) | (mantissa & 0xffffff);
}

// Adjust difficulty target
export function adjustTarget(currentTarget: string, actualTime: number, expectedTime: number): string {
  let ratio = actualTime / expectedTime;
  ratio = Math.min(4, Math.max(0.25, ratio)); // clamp to 4x change max (Bitcoin rule)

  // Convert hex target to BigInt, multiply by ratio
  const current = BigInt('0x' + currentTarget.padStart(64, '0'));
  const MAX = BigInt('0x' + 'ff'.repeat(32));
  let newTarget = BigInt(Math.round(Number(current) * ratio));
  if (newTarget > MAX) newTarget = MAX;
  if (newTarget < 1n)  newTarget = 1n;

  return newTarget.toString(16).padStart(64, '0');
}
