#!/usr/bin/env ts-node
/**
 * AXON Protocol — Wallet & Mining CLI
 * Real BIP39 mnemonics, secp256k1 keys, HD derivation (m/44'/7777'/0'/0/0)
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
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

interface WalletFile {
  address:  string;
  mnemonic: string;
  path:     string;
}

function loadWallet(): WalletFile | null {
  if (!fs.existsSync(WALLET_FILE)) return null;
  return JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
}

function saveWallet(address: string, mnemonic: string) {
  ensureDir(WALLET_FILE);
  const data: WalletFile = {
    address,
    mnemonic,
    path: `m/44'/7777'/0'/0/0`,
  };
  fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
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
    saveWallet(keypair.address, mnemonic);
    console.log(`\n✅ Wallet saved (chmod 600): ${WALLET_FILE}`);
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
    saveWallet(keypair.address, mnemonic);
    console.log(`✅ Saved: ${WALLET_FILE}\n`);
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

async function cmdHelp() {
  banner();
  console.log('  Commands:');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log('  axon new                    Generate new BIP39 wallet');
  console.log('  axon restore                Restore from 24-word mnemonic');
  console.log('  axon address                Show your wallet address');
  console.log('  axon balance [address]      Show AXN balance');
  console.log('  axon mine [n]               Mine n blocks (default: 1)');
  console.log('  axon mine [n] --address X   Mine to specific address');
  console.log('  axon info                   Protocol info + issuance schedule');
  console.log('  axon test                   Run full test suite');
  console.log('  axon help                   Show this help\n');
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
