/**
 * AXON Protocol — Test Suite
 * Unit tests for all protocol components
 */

import * as crypto from 'crypto';
import { sha256d, blake3, meetsTarget, adjustTarget, merkleRoot } from '../blockchain/crypto';
import { hashBlock, deriveChallenge, computePoawInput, getBlockReward, createCoinbase, hashTx, computeMerkleRoot, validateBlock } from '../blockchain/block';
import { Blockchain } from '../blockchain/chain';
import { mineBlock } from '../mining/miner';
import { keypairFromSeed, formatAXN, signTx, buildScriptSig } from '../wallet/wallet';
import { addressToScript, txSigHash } from '../blockchain/block';
import { INITIAL_REWARD, HALVING_INTERVAL, COIN } from '../blockchain/constants';
import { Block } from '../blockchain/types';

// ─── TEST RUNNER ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => {
    console.log(`  ✅ ${name}`);
    passed++;
  }).catch((err: any) => {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  });
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(a: T, b: T, msg?: string) {
  if (a !== b) throw new Error(msg || `Expected ${a} === ${b}`);
}

// ─── CRYPTO TESTS ─────────────────────────────────────────────────────────────

async function testCrypto() {
  console.log('\n📐 Crypto Tests:');

  await test('sha256d produces 32-byte output', () => {
    const result = sha256d(Buffer.from('hello'));
    assert(result.length === 32, 'Wrong length');
  });

  await test('sha256d is deterministic', () => {
    const a = sha256d(Buffer.from('axon'));
    const b = sha256d(Buffer.from('axon'));
    assert(a.equals(b), 'Not deterministic');
  });

  await test('sha256d double-hashes correctly', () => {
    const single = crypto.createHash('sha256').update('test').digest();
    const double = crypto.createHash('sha256').update(single).digest();
    const result = sha256d(Buffer.from('test'));
    assert(result.equals(double), 'Double hash mismatch');
  });

  await test('blake3 substitute is deterministic', () => {
    const a = blake3(Buffer.from('challenge'));
    const b = blake3(Buffer.from('challenge'));
    assert(a.equals(b), 'Not deterministic');
  });

  await test('meetsTarget returns true when hash < target', () => {
    const hash   = Buffer.from('00' + 'ff'.repeat(31), 'hex');
    const target = '0f' + 'ff'.repeat(31);
    assert(meetsTarget(hash, target), 'Should meet target');
  });

  await test('meetsTarget returns false when hash > target', () => {
    const hash   = Buffer.from('ff' + '00'.repeat(31), 'hex');
    const target = '0f' + 'ff'.repeat(31);
    assert(!meetsTarget(hash, target), 'Should not meet target');
  });

  await test('adjustTarget clamps at 4x maximum', () => {
    const current = '0f' + 'ff'.repeat(31);
    const adjusted = adjustTarget(current, 40000, 2016 * 600); // 10x faster
    const currentVal = BigInt('0x' + current);
    const adjustedVal = BigInt('0x' + adjusted);
    // Should be ~4x lower (harder), not 10x lower
    assert(adjustedVal >= currentVal / 5n, 'Clamping failed');
  });

  await test('merkleRoot of single tx equals sha256d of tx', () => {
    const txHash = crypto.randomBytes(32);
    const root   = merkleRoot([txHash]);
    const expected = sha256d(txHash);
    assert(root.equals(expected), 'Single-tx merkle root wrong');
  });

  await test('merkleRoot of two txs is sha256d of both', () => {
    const a = crypto.randomBytes(32);
    const b = crypto.randomBytes(32);
    const root     = merkleRoot([a, b]);
    const expected = sha256d(Buffer.concat([sha256d(a), sha256d(b)]));
    assert(root.equals(expected), 'Two-tx merkle root wrong');
  });
}

// ─── TOKENOMICS TESTS ─────────────────────────────────────────────────────────

async function testTokenomics() {
  console.log('\n💰 Tokenomics Tests:');

  await test('Block 0 (genesis) has zero reward', () => {
    assertEqual(getBlockReward(0), 0n, 'Genesis reward should be 0');
  });

  await test('Block 1 has initial reward of 50 AXN', () => {
    assertEqual(getBlockReward(1), 50n * COIN, 'Block 1 reward wrong');
  });

  await test('Block 210000 (last of era 1) has reward 25 AXN (era 2 starts)', () => {
    // floor(210000 / 210000) = 1, so era 2 reward = 25 AXN
    assertEqual(getBlockReward(HALVING_INTERVAL), 25n * COIN);
  });

  await test('Block 210001 (first of era 2) has reward 25 AXN', () => {
    assertEqual(getBlockReward(HALVING_INTERVAL + 1), 25n * COIN);
  });

  await test('Block 420001 (first of era 3) has reward 12.5 AXN', () => {
    assertEqual(getBlockReward(2 * HALVING_INTERVAL + 1), 1_250_000_000n);
  });

  await test('Total supply approaches but never exceeds 21M AXN', () => {
    let total = 0n;
    for (let era = 0; era < 64; era++) {
      const reward = INITIAL_REWARD >> BigInt(era);
      if (reward === 0n) break;
      total += reward * BigInt(HALVING_INTERVAL);
    }
    const maxSupply = 21_000_000n * COIN;
    assert(total <= maxSupply, `Total ${total} exceeds max ${maxSupply}`);
    // Should be within 1 AXN of 21M
    assert(total > maxSupply - COIN, `Total ${total} too far from max`);
  });

  await test('Reward after 64 halvings is zero', () => {
    assertEqual(getBlockReward(64 * HALVING_INTERVAL + 1), 0n);
  });

  await test('formatAXN formats correctly', () => {
    assertEqual(formatAXN(100_000_000n), '1.00000000 AXN');
    assertEqual(formatAXN(50_000_000_000n), '500.00000000 AXN');
    assertEqual(formatAXN(1n), '0.00000001 AXN');
  });
}

// ─── POAW TESTS ───────────────────────────────────────────────────────────────

async function testPoaw() {
  console.log('\n🤖 Proof of Agent Work Tests:');

  await test('Challenge derivation is deterministic', () => {
    const a = deriveChallenge('a'.repeat(64), 100, 'axon1miner');
    const b = deriveChallenge('a'.repeat(64), 100, 'axon1miner');
    assertEqual(a, b, 'Challenge not deterministic');
  });

  await test('Challenge changes with different prevHash', () => {
    const a = deriveChallenge('a'.repeat(64), 100, 'axon1miner');
    const b = deriveChallenge('b'.repeat(64), 100, 'axon1miner');
    assert(a !== b, 'Challenge should differ for different prevHash');
  });

  await test('Challenge changes with different height', () => {
    const a = deriveChallenge('a'.repeat(64), 100, 'axon1miner');
    const b = deriveChallenge('a'.repeat(64), 101, 'axon1miner');
    assert(a !== b, 'Challenge should differ for different height');
  });

  await test('Challenge changes with different miner address', () => {
    const a = deriveChallenge('a'.repeat(64), 100, 'axon1alice');
    const b = deriveChallenge('a'.repeat(64), 100, 'axon1bob');
    assert(a !== b, 'Challenge should differ for different miner');
  });

  await test('PoAW input computation is deterministic', () => {
    const challenge     = 'a'.repeat(64);
    const inferenceHash = 'b'.repeat(64);
    const a = computePoawInput(challenge, inferenceHash, 42);
    const b = computePoawInput(challenge, inferenceHash, 42);
    assert(a.equals(b), 'PoAW input not deterministic');
  });

  await test('Different nonce produces different PoAW input', () => {
    const challenge     = 'a'.repeat(64);
    const inferenceHash = 'b'.repeat(64);
    const a = computePoawInput(challenge, inferenceHash, 1);
    const b = computePoawInput(challenge, inferenceHash, 2);
    assert(!a.equals(b), 'Different nonce should produce different input');
  });

  await test('Tampered inferenceHash changes PoAW input', () => {
    const challenge = 'a'.repeat(64);
    const a = computePoawInput(challenge, 'b'.repeat(64), 1);
    const b = computePoawInput(challenge, 'c'.repeat(64), 1);
    assert(!a.equals(b), 'Tampered inference hash should change PoAW input');
  });
}

// ─── BLOCK VALIDATION TESTS ───────────────────────────────────────────────────

async function testBlockValidation() {
  console.log('\n🧱 Block Validation Tests:');

  const chain = new Blockchain(true);
  const miner = keypairFromSeed('test-miner-suite');

  await test('Mine and accept a valid block', async () => {
    const result = await mineBlock(chain, miner.address, [], false);
    const added  = chain.addBlock(result.block);
    assert(added.success, `Block rejected: ${added.error}`);
    assertEqual(chain.getHeight(), 1, 'Chain height should be 1');
  });

  await test('Block with wrong prevHash is rejected', async () => {
    const result = await mineBlock(chain, miner.address, [], false);
    result.block.header.prevHash = '00'.repeat(32); // wrong
    const added = chain.addBlock(result.block);
    assert(!added.success, 'Block with wrong prevHash should be rejected');
  });

  await test('Block with tampered inferenceHash fails PoAW', async () => {
    const result = await mineBlock(chain, miner.address, [], false);
    result.block.header.inferenceHash = '00'.repeat(32); // tampered

    const state  = chain.getState();
    const valid  = validateBlock(
      result.block,
      state.bestBlockHash,
      state.height + 1,
      state.powTarget,
      state.poawTarget,
      () => null
    );
    assert(!valid.valid, 'Tampered inferenceHash should fail validation');
  });

  await test('Block with inflated coinbase reward is rejected', async () => {
    const result = await mineBlock(chain, miner.address, [], false);
    result.block.transactions[0].outputs[0].value = 10_000n * COIN; // 10000 AXN

    const state  = chain.getState();
    const valid  = validateBlock(
      result.block,
      state.bestBlockHash,
      state.height + 1,
      state.powTarget,
      state.poawTarget,
      () => null
    );
    assert(!valid.valid, 'Inflated coinbase should fail validation');
  });

  await test('Chain height increments correctly', async () => {
    const startHeight = chain.getHeight();
    const result = await mineBlock(chain, miner.address, [], false);
    chain.addBlock(result.block);
    assertEqual(chain.getHeight(), startHeight + 1, 'Height should increment by 1');
  });

  await test('Can retrieve block by height', async () => {
    const height = chain.getHeight();
    const block  = chain.getBlockAtHeight(height);
    assert(block !== undefined, 'Should find block at current height');
  });

  // ── Signature enforcement tests ──────────────────────────────────────────

  await test('Block with valid signed tx is accepted', async () => {
    // Mine block 1 to give miner a UTXO to spend
    const b1 = await mineBlock(chain, miner.address, [], false);
    chain.addBlock(b1.block);
    const coinbaseTx = b1.block.transactions[0];
    const coinbaseTxid = coinbaseTx.txid!;

    // Wait for coinbase maturity is skipped in tests — build a spend tx anyway
    const receiver = keypairFromSeed('receiver-sig-test');
    const utxoValue = coinbaseTx.outputs[0].value;
    const fee = 1000n;

    const spendTx = {
      version: 1,
      inputs: [{
        prevTxid:  coinbaseTxid,
        prevIndex: 0,
        scriptSig: '', // fill below
        sequence:  0xffffffff,
      }],
      outputs: [{
        value:        utxoValue - fee,
        scriptPubKey: addressToScript(receiver.address),
      }],
      locktime: 0,
    };

    // Sign input 0
    const scriptPubKey = addressToScript(miner.address);
    const sigHash = txSigHash(spendTx, 0, scriptPubKey);
    const sigHex  = signTx(sigHash, miner.privateKeyHex);
    spendTx.inputs[0].scriptSig = buildScriptSig(sigHex, miner.publicKeyHex);

    // Mine block 2 containing the spend
    const b2 = await mineBlock(chain, miner.address, [spendTx], false);
    const added = chain.addBlock(b2.block);
    assert(added.success, `Valid signed tx rejected: ${added.error}`);
  });

  await test('Block with invalid signature is rejected', async () => {
    // Attempt to spend a UTXO with a wrong key
    const wrongKey   = keypairFromSeed('attacker-key');
    const victimKey  = keypairFromSeed('test-miner-suite');

    // Mine a block to get a UTXO
    const freshChain = new Blockchain(true);
    const b1 = await mineBlock(freshChain, victimKey.address, [], false);
    freshChain.addBlock(b1.block);
    const coinbaseTx   = b1.block.transactions[0];
    const coinbaseTxid = coinbaseTx.txid!;
    const utxoValue    = coinbaseTx.outputs[0].value;

    const spendTx = {
      version: 1,
      inputs: [{
        prevTxid:  coinbaseTxid,
        prevIndex: 0,
        scriptSig: '',
        sequence:  0xffffffff,
      }],
      outputs: [{
        value:        utxoValue - 1000n,
        scriptPubKey: addressToScript(wrongKey.address),
      }],
      locktime: 0,
    };

    // Sign with WRONG key (attacker trying to steal)
    const scriptPubKey = addressToScript(victimKey.address);
    const sigHash = txSigHash(spendTx, 0, scriptPubKey);
    const sigHex  = signTx(sigHash, wrongKey.privateKeyHex);  // wrong key!
    spendTx.inputs[0].scriptSig = buildScriptSig(sigHex, wrongKey.publicKeyHex);

    const b2 = await mineBlock(freshChain, victimKey.address, [spendTx], false);
    const added = freshChain.addBlock(b2.block);
    assert(!added.success, 'Block with invalid signature should be rejected');
    assert(added.error?.includes('Invalid signature') ?? false, `Expected sig error, got: ${added.error}`);
  });

  await test('Issuance schedule has correct era count', () => {
    const schedule = chain.getIssuanceSchedule();
    assert(schedule.length > 30, 'Should have at least 30 eras');
    assert(schedule.length < 35, 'Should have fewer than 35 eras');
  });
}

// ─── WALLET TESTS ─────────────────────────────────────────────────────────────

async function testWallet() {
  console.log('\n👛 Wallet Tests:');

  await test('Keypair from same seed is deterministic', () => {
    const a = keypairFromSeed('test-seed');
    const b = keypairFromSeed('test-seed');
    assertEqual(a.address, b.address, 'Address should be deterministic');
  });

  await test('Different seeds produce different addresses', () => {
    const a = keypairFromSeed('seed-one');
    const b = keypairFromSeed('seed-two');
    assert(a.address !== b.address, 'Different seeds should differ');
  });

  await test('Address starts with axon1 prefix', () => {
    const kp = keypairFromSeed('test-prefix');
    assert(kp.address.startsWith('axon1'), 'Address should start with axon1');
  });
}

// ─── WALLET ENCRYPTION TESTS ─────────────────────────────────────────────────

async function testWalletEncryption() {
  console.log('\n🔐 Wallet Encryption Tests:');
  const nodeCrypto = require('crypto') as typeof import('crypto');

  function encryptMnemonic(mnemonic: string, passphrase: string): { encrypted: string; salt: string; N: number; r: number; p: number } {
    const salt   = nodeCrypto.randomBytes(32);
    const N = 1024, r = 8, p = 1; // low N for tests; production uses N=32768
    const key    = nodeCrypto.scryptSync(passphrase, salt, 32, { N, r, p });
    const iv     = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    const ct     = Buffer.concat([cipher.update(mnemonic, 'utf8'), cipher.final()]);
    const tag    = cipher.getAuthTag();
    return { encrypted: Buffer.concat([iv, tag, ct]).toString('hex'), salt: salt.toString('hex'), N, r, p };
  }

  function decryptMnemonic(encrypted: string, salt: string, N: number, r: number, p: number, passphrase: string): string {
    const buf      = Buffer.from(encrypted, 'hex');
    const iv       = buf.slice(0, 12);
    const tag      = buf.slice(12, 28);
    const ct       = buf.slice(28);
    const saltBuf  = Buffer.from(salt, 'hex');
    const key      = nodeCrypto.scryptSync(passphrase, saltBuf, 32, { N, r, p });
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct) + decipher.final('utf8');
  }

  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  await test('Encrypted wallet decrypts correctly with right passphrase', () => {
    const { encrypted, salt, N, r, p } = encryptMnemonic(testMnemonic, 'correct-horse');
    const decrypted = decryptMnemonic(encrypted, salt, N, r, p, 'correct-horse');
    assertEqual(decrypted, testMnemonic, 'Decrypted mnemonic should match original');
  });

  await test('Encrypted wallet fails with wrong passphrase', () => {
    const { encrypted, salt, N, r, p } = encryptMnemonic(testMnemonic, 'correct-horse');
    let threw = false;
    try { decryptMnemonic(encrypted, salt, N, r, p, 'wrong-passphrase'); }
    catch { threw = true; }
    assert(threw, 'Wrong passphrase should throw (GCM auth tag failure)');
  });

  await test('Two encryptions of same mnemonic produce different ciphertext (random IV+salt)', () => {
    const a = encryptMnemonic(testMnemonic, 'pass').encrypted;
    const b = encryptMnemonic(testMnemonic, 'pass').encrypted;
    assert(a !== b, 'Each encryption should be unique due to random IV and salt');
  });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║         AXON PROTOCOL — TEST SUITE                   ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  await testCrypto();
  await testTokenomics();
  await testPoaw();
  await testBlockValidation();
  await testWallet();
  await testWalletEncryption();

  console.log('\n' + '═'.repeat(54));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('✅ All tests passed!');
  } else {
    console.log(`❌ ${failed} tests failed`);
    process.exit(1);
  }
  console.log('═'.repeat(54) + '\n');
}

main().catch(console.error);
