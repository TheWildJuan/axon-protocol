#!/usr/bin/env ts-node
/**
 * AXON Protocol — Wallet & Mining CLI
 * Real BIP39 mnemonics, secp256k1 keys, HD derivation (m/44'/7777'/0'/0/0)
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { generateWallet, keypairFromMnemonic, validateMnemonic, formatAXN } from './wallet/wallet';
import { Blockchain, openChain } from './blockchain/chain';
import { mineBlock } from './mining/miner';
import { getBlockReward } from './blockchain/block';

const WALLET_FILE = path.join(process.env.HOME || '.', '.axon', 'wallet.json');
const CHAIN_DIR   = path.join(process.env.HOME || '.', '.axon', 'chain');

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function ensureDir(p: string) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

interface WalletFilePlain {
  version:  1;
  address:  string;
  mnemonic: string;
  path:     string;
}

interface WalletFileEncrypted {
  version:   2;
  address:   string;           // plaintext — so you can see your address without decrypting
  path:      string;
  encrypted: string;           // hex: iv(12) + tag(16) + ciphertext
  kdf:       'scrypt';
  kdfParams: { N: number; r: number; p: number; salt: string };
}

type WalletFile = WalletFilePlain | WalletFileEncrypted;

// ─── ENCRYPTION HELPERS ─────────────────────────────────────────────────────

function encryptWallet(mnemonic: string, passphrase: string): {
  encrypted: string;
  kdfParams: WalletFileEncrypted['kdfParams'];
} {
  const salt    = crypto.randomBytes(32);
  const N = 32768, r = 8, p = 1;
  const key     = crypto.scryptSync(passphrase, salt, 32, { N, r, p });
  const iv      = crypto.randomBytes(12);
  const cipher  = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct      = Buffer.concat([cipher.update(mnemonic, 'utf8'), cipher.final()]);
  const tag     = cipher.getAuthTag();
  // packed: iv(12) + tag(16) + ciphertext
  const packed  = Buffer.concat([iv, tag, ct]).toString('hex');
  return {
    encrypted: packed,
    kdfParams: { N, r, p, salt: salt.toString('hex') },
  };
}

function decryptWallet(encrypted: string, kdfParams: WalletFileEncrypted['kdfParams'], passphrase: string): string {
  const buf    = Buffer.from(encrypted, 'hex');
  const iv     = buf.slice(0, 12);
  const tag    = buf.slice(12, 28);
  const ct     = buf.slice(28);
  const salt   = Buffer.from(kdfParams.salt, 'hex');
  const key    = crypto.scryptSync(passphrase, salt, 32, { N: kdfParams.N, r: kdfParams.r, p: kdfParams.p });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct) + decipher.final('utf8');
}

function loadWallet(): WalletFile | null {
  if (!fs.existsSync(WALLET_FILE)) return null;
  return JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
}

function saveWallet(address: string, mnemonic: string, passphrase?: string) {
  ensureDir(WALLET_FILE);
  let data: WalletFile;
  if (passphrase) {
    const { encrypted, kdfParams } = encryptWallet(mnemonic, passphrase);
    data = { version: 2, address, path: `m/44'/7777'/0'/0/0`, encrypted, kdf: 'scrypt', kdfParams };
  } else {
    data = { version: 1, address, mnemonic, path: `m/44'/7777'/0'/0/0` };
  }
  fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function loadDecryptedMnemonic(wallet: WalletFile): Promise<string> {
  if (wallet.version === 1) return (wallet as WalletFilePlain).mnemonic;
  const enc = wallet as WalletFileEncrypted;
  const passphrase = await ask('Wallet passphrase: ');
  try {
    return decryptWallet(enc.encrypted, enc.kdfParams, passphrase);
  } catch {
    throw new Error('Wrong passphrase or corrupted wallet file.');
  }
}

function banner() {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║        ⚡ AXON PROTOCOL (AXN)          ║');
  console.log('║   Mine with intelligence, not just     ║');
  console.log('║         electricity.                   ║');
  console.log('╚═══════════════════════════════════════╝\n');
}

function ask(prompt: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (hidden) (rl as any).stdoutMuted = true;
  return new Promise(resolve => {
    rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); });
  });
}

function printWords(mnemonic: string) {
  const words = mnemonic.split(' ');
  console.log('\n  Your 24-word recovery phrase:\n');
  for (let i = 0; i < words.length; i += 6) {
    const row = words.slice(i, i + 6)
      .map((w, j) => `${String(i + j + 1).padStart(2)}. ${w.padEnd(12)}`).join('  ');
    console.log('  ' + row);
  }
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

async function cmdNew() {
  banner();
  console.log('Generating new AXON wallet...\n');

  const { mnemonic, keypair } = generateWallet(256); // 24 words

  printWords(mnemonic);

  console.log('\n┌─────────────────────────────────────────────────────────┐');
  console.log(`│  Address:  ${keypair.address}`);
  console.log(`│  PubKey:   ${keypair.publicKeyHex.substring(0, 32)}...`);
  console.log(`│  Path:     m/44'/7777'/0'/0/0`);
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log('│  🔐 WRITE DOWN YOUR 24 WORDS. They cannot be recovered. │');
  console.log('│  Anyone with your phrase can access your AXN.           │');
  console.log('│  Never share them. Never store them online.             │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  const save = await ask('Save wallet to ~/.axon/wallet.json? (y/n): ');
  if (save.toLowerCase() === 'y') {
    const usePass = await ask('Encrypt with passphrase? (recommended) (y/n): ');
    let passphrase: string | undefined;
    if (usePass.toLowerCase() === 'y') {
      passphrase = await ask('Enter passphrase: ');
      const confirm = await ask('Confirm passphrase: ');
      if (passphrase !== confirm) {
        console.log('\n❌ Passphrases do not match. Wallet NOT saved.\n');
        process.exit(1);
      }
    }
    saveWallet(keypair.address, mnemonic, passphrase);
    const encTag = passphrase ? ' (AES-256-GCM encrypted)' : ' (unencrypted — consider using a passphrase)';
    console.log(`\n✅ Wallet saved (chmod 600): ${WALLET_FILE}${encTag}`);
    console.log(`   Address: ${keypair.address}\n`);
  } else {
    console.log('\n⚠️  Wallet NOT saved. Write down your mnemonic before closing.\n');
  }
}

async function cmdRestore() {
  banner();
  console.log('Restore wallet from 12 or 24-word mnemonic.\n');
  const mnemonic = await ask('Enter mnemonic phrase: ');

  if (!validateMnemonic(mnemonic)) {
    console.log('\n❌ Invalid mnemonic. Check your words and try again.\n');
    process.exit(1);
  }

  const keypair = keypairFromMnemonic(mnemonic);
  console.log('\n✅ Wallet verified');
  console.log(`   Address: ${keypair.address}`);
  console.log(`   Path:    m/44'/7777'/0'/0/0`);

  const save = await ask('\nSave to ~/.axon/wallet.json? (y/n): ');
  if (save.toLowerCase() === 'y') {
    const usePass = await ask('Encrypt with passphrase? (recommended) (y/n): ');
    let passphrase: string | undefined;
    if (usePass.toLowerCase() === 'y') {
      passphrase = await ask('Enter passphrase: ');
      const confirm = await ask('Confirm passphrase: ');
      if (passphrase !== confirm) {
        console.log('\n❌ Passphrases do not match. Wallet NOT saved.\n');
        process.exit(1);
      }
    }
    saveWallet(keypair.address, mnemonic, passphrase);
    const encTag = passphrase ? ' (encrypted)' : '';
    console.log(`✅ Saved${encTag}: ${WALLET_FILE}\n`);
  }
}

async function cmdAddress() {
  const wallet = loadWallet();
  if (!wallet) {
    console.log('\n❌ No wallet found. Run: axon new\n');
    process.exit(1);
  }
  console.log(`\nYour AXON address:\n  ${wallet.address}\n`);
  console.log(`Derivation path: ${wallet.path}\n`);
}

async function cmdMine(blocks: number, address?: string) {
  banner();

  let minerAddress = address;
  if (!minerAddress) {
    const wallet = loadWallet();
    if (!wallet) {
      console.log('❌ No wallet found. Run: axon new  (or pass --address <addr>)');
      process.exit(1);
    }
    minerAddress = wallet.address;
  }

  console.log(`Mining ${blocks} block(s) → ${minerAddress}`);
  console.log('─'.repeat(66));

  const chain = await openChain(true);
  if (chain.getHeight() > 0) {
    console.log(`  Resuming from block ${chain.getHeight()} (loaded from disk)`);
  }
  let totalEarned = 0n;

  for (let i = 0; i < blocks; i++) {
    const height = chain.getHeight() + 1;
    const reward = getBlockReward(height);
    process.stdout.write(`  Block ${String(height).padStart(4)}: mining... `);

    const start  = Date.now();
    const result = await mineBlock(chain, minerAddress, [], false);
    const added  = await (chain as any).addBlockAsync(result.block);
    const ms     = Date.now() - start;

    if (added.success) {
      totalEarned += reward;
      console.log(`✅ ${formatAXN(reward)}  ${ms}ms  ${result.block.hash?.substring(0, 16)}...`);
    } else {
      console.log(`❌ ${added.error}`);
    }
  }

  const bal = chain.getBalance(minerAddress);

  console.log('─'.repeat(66));
  console.log(`\n  Address:       ${minerAddress}`);
  console.log(`  Blocks mined:  ${blocks}`);
  console.log(`  Total earned:  ${formatAXN(totalEarned)}`);
  console.log(`  Balance:       ${formatAXN(bal.confirmed)}  (${bal.utxos.length} UTXOs)`);
  console.log(`  Chain height:  ${chain.getHeight()}`);
  await chain.close();
  console.log('\n  ✅ Chain saved to disk (~/.axon/chain)');
  console.log('  ⚠️  Real network mining requires P2P (v0.2)\n');
}

async function cmdBalance(address?: string) {
  banner();
  const addr = address || loadWallet()?.address;
  if (!addr) {
    console.log('❌ No wallet. Run: axon new  or pass an address.\n');
    process.exit(1);
  }
  const chain   = await openChain(true);
  const balance = chain.getBalance(addr);
  await chain.close();
  console.log(`  Address: ${addr}`);
  console.log(`  Balance: ${formatAXN(balance.confirmed)}  (${balance.utxos.length} UTXOs)`);
  console.log(`  Chain:   height ${chain.getHeight()}\n`);
}

async function cmdInfo() {
  banner();
  const chain    = new Blockchain(true);
  const schedule = chain.getIssuanceSchedule();

  console.log('  Protocol Parameters:');
  console.log('  ─────────────────────────────────────────────');
  console.log('  Max supply:      21,000,000 AXN');
  console.log('  Initial reward:  50 AXN/block');
  console.log('  Halving:         every 210,000 blocks (~4 years)');
  console.log('  Block time:      ~10 minutes');
  console.log('  Consensus:       SHA-256d PoW + PoAW (AI inference)');
  console.log('  AI model:        TinyLlama-1.1B-Q4_K_M (pinned)');
  console.log('  Wallet:          BIP39/BIP32, path m/44\'/7777\'/0\'/0/0');
  console.log('  Signing:         secp256k1 ECDSA (real)');
  console.log('  No premine:      ✅');
  console.log('  No admin keys:   ✅');
  console.log('\n  Issuance Schedule:');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  Era  | Reward/block      | Start block | Era Supply');
  console.log('  ─────────────────────────────────────────────────────────────');
  schedule.slice(0, 10).forEach(e => {
    console.log(
      `  ${String(e.era).padStart(3)}  | ` +
      `${String(e.reward).padStart(18)} | ` +
      `${String(e.startBlock).padStart(11)} | ` +
      `${e.eraSupply}`
    );
  });
  console.log('  ... approaches 21,000,000 AXN asymptotically\n');
}

async function cmdSetupInference() {
  banner();
  const { getInferenceStatus, benchmarkInference, computeModelHash } = await import('./mining/inference');

  console.log('  Checking inference setup...\n');
  const status = getInferenceStatus();

  console.log(`  llama-cli:  ${status.llamaCli}`);
  console.log(`  Status:     ${status.llamaExists ? '✅ found' : '❌ MISSING'}`);
  console.log(`  Model path: ${status.modelPath}`);
  console.log(`  Status:     ${status.modelExists ? '✅ found' : '❌ MISSING'}\n`);

  if (!status.llamaExists) {
    console.log('  Build llama.cpp:');
    console.log('    git clone --depth 1 https://github.com/ggml-org/llama.cpp /tmp/llama.cpp');
    console.log('    cd /tmp/llama.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF');
    console.log('    cmake --build build -j$(nproc)');
    console.log('  Then set: export LLAMA_CLI=/tmp/llama.cpp/build/bin/llama-cli\n');
  }

  if (!status.modelExists) {
    const nodePath   = require('path');
    const nodeFs     = require('fs');
    const nodeChild  = require('child_process');
    const modelDir   = nodePath.dirname(status.modelPath);
    nodeFs.mkdirSync(modelDir, { recursive: true });

    const MODEL_URL = 'https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf';
    const { CANONICAL_MODEL } = require('./blockchain/constants');

    console.log(`  Model not found. Download now? (~639MB)\n  URL: ${MODEL_URL}\n`);
    const doDownload = await ask('  Download automatically? (y/n): ');
    if (doDownload.toLowerCase() === 'y') {
      console.log('\n  Downloading... (this may take several minutes)\n');
      try {
        // Use wget or curl, whichever is available
        const downloader = (() => {
          try { nodeChild.execSync('which wget', { stdio: 'pipe' }); return 'wget'; }
          catch { return 'curl'; }
        })();
        const cmd = downloader === 'wget'
          ? `wget --progress=dot:mega -O "${status.modelPath}" "${MODEL_URL}"`
          : `curl -L --progress-bar -o "${status.modelPath}" "${MODEL_URL}"`;
        nodeChild.execSync(cmd, { stdio: 'inherit' });
        console.log('\n  Download complete. Verifying SHA256...\n');
        const actualHash = await computeModelHash();
        if (actualHash === CANONICAL_MODEL.sha256) {
          console.log(`  ✅ Model verified: ${actualHash.substring(0, 32)}...\n`);
        } else {
          console.log(`  ❌ Hash mismatch! Expected: ${CANONICAL_MODEL.sha256}`);
          console.log(`                   Got:      ${actualHash}`);
          console.log('  Deleting corrupt download.\n');
          nodeFs.unlinkSync(status.modelPath);
        }
      } catch (e: any) {
        console.log(`  ❌ Download failed: ${e.message}\n`);
      }
    } else {
      console.log('\n  Manual download:');
      console.log(`    wget -O "${status.modelPath}" "${MODEL_URL}"\n`);
    }
  }

  if (status.ready) {
    console.log('  ✅ All systems ready. Running benchmark...\n');
    try {
      const bench = await benchmarkInference();
      console.log(`  Inference speed:  ${bench.tokensPerSecond} tokens/sec`);
      console.log(`  Time per block:   ${(bench.inferenceMs / 1000).toFixed(1)}s`);
      console.log(`  Output hash:      ${bench.hash.substring(0, 32)}...`);
      const { CANONICAL_MODEL } = require('./blockchain/constants');
      const modelHash = await computeModelHash();
      const hashOK    = modelHash === CANONICAL_MODEL.sha256;
      console.log(`  Model SHA256:     ${modelHash}`);
      console.log(`  Hash verified:    ${hashOK ? '✅ matches canonical' : '❌ MISMATCH — not canonical model!'}`);
      console.log('\n  ✅ Real inference working. Mining will use TinyLlama automatically.\n');
    } catch (e: any) {
      console.log(`  ❌ Benchmark failed: ${e.message}\n`);
    }
  } else {
    console.log('  ⚠️  Setup incomplete. Mining will use simulation until inference is ready.\n');
  }
}

async function cmdSend(toAddress: string, amountAXN: string, feeAXN?: string) {
  banner();

  // ── 1. Load wallet & decrypt ──────────────────────────────────────────────
  const walletFile = loadWallet();
  if (!walletFile) {
    console.log('\n❌ No wallet found. Run: axon new\n');
    process.exit(1);
  }
  let mnemonic: string;
  try {
    mnemonic = await loadDecryptedMnemonic(walletFile);
  } catch (e: any) {
    console.log(`\n❌ ${e.message}\n`);
    process.exit(1);
  }
  const { keypairFromMnemonic: kfm } = require('./wallet/wallet');
  const keypair = kfm(mnemonic);

  // ── 2. Parse amounts ──────────────────────────────────────────────────────
  const COIN_UNIT = 100_000_000n;
  const parseSat = (s: string) => BigInt(Math.round(parseFloat(s) * 1e8));
  const sendSats = parseSat(amountAXN);
  const feeSats  = feeAXN ? parseSat(feeAXN) : 10_000n; // default 0.0001 AXN fee
  const needed   = sendSats + feeSats;

  if (sendSats <= 0n) { console.log('\n❌ Amount must be positive\n'); process.exit(1); }

  const { formatAXN: fmt } = require('./wallet/wallet');
  console.log(`\nSending ${fmt(sendSats)} AXN → ${toAddress}`);
  console.log(`Fee:    ${fmt(feeSats)} AXN`);
  console.log(`Total:  ${fmt(needed)} AXN\n`);

  // ── 3. Fetch UTXOs from RPC ───────────────────────────────────────────────
  const RPC = process.env.RPC_URL || `http://127.0.0.1:${RPC_PORT_DEFAULT}`;
  let utxos: Array<{ txid: string; index: number; value: string; scriptPubKey: string }>;
  try {
    const res = await fetch(`${RPC}/utxos/${walletFile.address}`);
    if (!res.ok) throw new Error(`RPC error: ${res.status}`);
    const data: any = await res.json();
    utxos = data.utxos ?? [];
  } catch (e: any) {
    console.log(`❌ Could not reach RPC at ${RPC}: ${e.message}`);
    console.log('   Start a node with: axon mine 0 (or run index.ts)\n');
    process.exit(1);
  }

  // ── 4. Coin selection (largest-first greedy) ──────────────────────────────
  const available = utxos.map(u => ({ ...u, valueSat: BigInt(u.value) }))
    .sort((a, b) => (b.valueSat > a.valueSat ? 1 : -1));

  const selected: typeof available = [];
  let   collected = 0n;
  for (const u of available) {
    selected.push(u);
    collected += u.valueSat;
    if (collected >= needed) break;
  }

  if (collected < needed) {
    const bal = available.reduce((s, u) => s + u.valueSat, 0n);
    console.log(`❌ Insufficient balance. Have ${fmt(bal)} AXN, need ${fmt(needed)} AXN\n`);
    process.exit(1);
  }

  const change = collected - needed;

  // ── 5. Build transaction ──────────────────────────────────────────────────
  const { addressToScript } = require('./blockchain/block');
  const outputs: Array<{ value: bigint; scriptPubKey: string }> = [
    { value: sendSats, scriptPubKey: addressToScript(toAddress) },
  ];
  if (change > 546n) { // dust threshold
    outputs.push({ value: change, scriptPubKey: addressToScript(walletFile.address) });
  }

  const tx: any = {
    version:  1,
    inputs:   selected.map(u => ({ prevTxid: u.txid, prevIndex: u.index, scriptSig: '', sequence: 0xffffffff })),
    outputs,
    locktime: 0,
  };

  // ── 6. Sign all inputs ────────────────────────────────────────────────────
  const { txSigHash, verifyScriptSig } = require('./blockchain/block');
  const { signTx: sign, buildScriptSig: bss } = require('./wallet/wallet');
  for (let i = 0; i < tx.inputs.length; i++) {
    const utxo   = selected[i];
    const sighash = txSigHash(tx, i, utxo.scriptPubKey);
    const sigHex  = sign(sighash, keypair.privateKeyHex);
    tx.inputs[i].scriptSig = bss(sigHex, keypair.publicKeyHex);
  }

  // ── 7. Compute txid & broadcast ───────────────────────────────────────────
  const { hashTx } = require('./blockchain/block');
  tx.txid = hashTx(tx);

  console.log(`TxID: ${tx.txid}`);
  console.log(`Inputs: ${selected.length}  Outputs: ${outputs.length}  Change: ${fmt(change)} AXN\n`);

  const confirm = await ask('Broadcast transaction? (y/n): ');
  if (confirm.toLowerCase() !== 'y') {
    console.log('\n⚠️  Cancelled. Transaction not sent.\n');
    process.exit(0);
  }

  try {
    const res = await fetch(`${RPC}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx }),
    });
    const data: any = await res.json();
    if (res.ok && data.txid) {
      console.log(`\n✅ Transaction broadcast!`);
      console.log(`   TxID: ${data.txid}`);
      console.log(`   It will confirm in the next mined block.\n`);
    } else {
      console.log(`\n❌ Broadcast failed: ${data.error ?? JSON.stringify(data)}\n`);
      process.exit(1);
    }
  } catch (e: any) {
    console.log(`\n❌ Broadcast error: ${e.message}\n`);
    process.exit(1);
  }
}

const RPC_PORT_DEFAULT = 8332;

async function cmdHelp() {
  banner();
  console.log('  Commands:');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log('  axon new                        Generate new BIP39 wallet');
  console.log('  axon restore                    Restore from 24-word mnemonic');
  console.log('  axon address                    Show your wallet address');
  console.log('  axon balance [address]          Show AXN balance');
  console.log('  axon send <address> <amount>    Send AXN to an address');
  console.log('  axon send <addr> <amt> --fee X  Send with custom fee (default 0.0001)');
  console.log('  axon mine [n]                   Mine n blocks (default: 1)');
  console.log('  axon mine [n] --address X       Mine to specific address');
  console.log('  axon info                       Protocol info + issuance schedule');
  console.log('  axon setup-inference            Check/setup real TinyLlama inference');
  console.log('  axon test                       Run full test suite');
  console.log('  axon help                       Show this help\n');
  console.log('  Security:');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log('  ✅ Real secp256k1 ECDSA signatures');
  console.log('  ✅ BIP39 24-word mnemonic (256-bit entropy)');
  console.log('  ✅ BIP32 HD derivation (m/44\'/7777\'/0\'/0/0)');
  console.log('  ✅ Wallet file saved chmod 600\n');
}

// ─── DISPATCH ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd  = args[0] || 'help';

  switch (cmd) {
    case 'new':     return cmdNew();
    case 'restore': return cmdRestore();
    case 'address': return cmdAddress();
    case 'balance': return cmdBalance(args[1]);
    case 'info':    return cmdInfo();
    case 'help':    return cmdHelp();
    case 'mine': {
      const n       = parseInt(args[1]) || 1;
      const addrIdx = args.indexOf('--address');
      const addr    = addrIdx !== -1 ? args[addrIdx + 1] : undefined;
      return cmdMine(n, addr);
    }
    case 'send': {
      const toAddr  = args[1];
      const amount  = args[2];
      if (!toAddr || !amount) {
        console.log('\nUsage: axon send <address> <amount> [--fee <axn>]\n');
        process.exit(1);
      }
      const feeIdx = args.indexOf('--fee');
      const fee    = feeIdx !== -1 ? args[feeIdx + 1] : undefined;
      return cmdSend(toAddr, amount, fee);
    }
    case 'setup-inference': return cmdSetupInference();
    case 'test': {
      const { execSync } = require('child_process');
      execSync('npx ts-node src/test/suite.ts', { stdio: 'inherit', cwd: __dirname + '/..' });
      return;
    }
    default:
      console.log(`\nUnknown command: ${cmd}`);
      return cmdHelp();
  }
}

main().catch(console.error);
