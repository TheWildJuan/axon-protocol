#!/usr/bin/env ts-node
/**
 * AXON Protocol — Wallet & Mining CLI
 * Usage: npx ts-node src/cli.ts <command> [options]
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { keypairFromSeed, formatAXN } from './wallet/wallet';
import { Blockchain } from './blockchain/chain';
import { mineBlock } from './mining/miner';
import { getBlockReward } from './blockchain/block';

const WALLET_FILE = path.join(process.env.HOME || '.', '.axon', 'wallet.json');

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function ensureDir(p: string) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadWallet(): { address: string; seed: string } | null {
  if (!fs.existsSync(WALLET_FILE)) return null;
  return JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
}

function saveWallet(address: string, seed: string) {
  ensureDir(WALLET_FILE);
  fs.writeFileSync(WALLET_FILE, JSON.stringify({ address, seed }, null, 2), { mode: 0o600 });
}

function banner() {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║        ⚡ AXON PROTOCOL (AXN)          ║');
  console.log('║   Mine with intelligence, not just     ║');
  console.log('║         electricity.                   ║');
  console.log('╚═══════════════════════════════════════╝\n');
}

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); }));
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

async function cmdNew() {
  banner();
  console.log('Generating new AXON wallet...\n');

  // Generate random seed
  const seed = crypto.randomBytes(32).toString('hex');
  const kp   = keypairFromSeed(seed);

  console.log('┌─ NEW WALLET ────────────────────────────────────────────┐');
  console.log(`│  Address:  ${kp.address}`);
  console.log(`│  Seed:     ${seed}`);
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log('│  ⚠️  WRITE DOWN YOUR SEED. It cannot be recovered.       │');
  console.log('│  Anyone with your seed can access your AXN.             │');
  console.log('└─────────────────────────────────────────────────────────┘\n');

  const save = await ask('Save wallet to ~/.axon/wallet.json? (y/n): ');
  if (save.toLowerCase() === 'y') {
    saveWallet(kp.address, seed);
    console.log(`\n✅ Wallet saved to ${WALLET_FILE} (chmod 600)`);
  }

  console.log('\nYour address:', kp.address);
}

async function cmdRestore() {
  banner();
  const seed = await ask('Enter your seed phrase or hex seed: ');
  const kp   = keypairFromSeed(seed);
  console.log('\n✅ Wallet restored');
  console.log(`   Address: ${kp.address}`);

  const save = await ask('Save to ~/.axon/wallet.json? (y/n): ');
  if (save.toLowerCase() === 'y') {
    saveWallet(kp.address, seed);
    console.log(`✅ Saved to ${WALLET_FILE}`);
  }
}

async function cmdAddress() {
  const wallet = loadWallet();
  if (!wallet) {
    console.log('❌ No wallet found. Run: axon new');
    process.exit(1);
  }
  console.log('\nYour AXON address:');
  console.log(`  ${wallet.address}\n`);
}

async function cmdMine(blocks: number, address?: string) {
  banner();

  // Resolve miner address
  let minerAddress = address;
  if (!minerAddress) {
    const wallet = loadWallet();
    if (!wallet) {
      console.log('❌ No wallet found. Run: axon new  (or pass --address <addr>)');
      process.exit(1);
    }
    minerAddress = wallet.address;
  }

  console.log(`Mining ${blocks} block(s) to: ${minerAddress}`);
  console.log('─'.repeat(60));

  const chain = new Blockchain(true);
  let totalEarned = 0n;

  for (let i = 0; i < blocks; i++) {
    const height  = chain.getHeight() + 1;
    const reward  = getBlockReward(height);
    process.stdout.write(`Block ${height}: mining... `);

    const start  = Date.now();
    const result = await mineBlock(chain, minerAddress, [], false);
    const added  = chain.addBlock(result.block);
    const ms     = Date.now() - start;

    if (added.success) {
      totalEarned += reward;
      console.log(`✅ ${formatAXN(reward)} earned | ${ms}ms | hash: ${result.block.hash?.substring(0,20)}...`);
    } else {
      console.log(`❌ rejected: ${added.error}`);
    }
  }

  console.log('─'.repeat(60));
  console.log(`\nTotal earned: ${formatAXN(totalEarned)}`);
  console.log(`Chain height: ${chain.getHeight()}`);
  console.log('\n⚠️  Note: This is a local testnet. AXN mined here has no real value yet.');
  console.log('    Real network mining requires P2P (coming in v0.2)\n');
}

async function cmdInfo() {
  banner();
  const chain    = new Blockchain(true);
  const schedule = chain.getIssuanceSchedule();

  console.log('Protocol Parameters:');
  console.log('  Max supply:      21,000,000 AXN');
  console.log('  Initial reward:  50 AXN/block');
  console.log('  Halving:         every 210,000 blocks');
  console.log('  Block time:      ~10 minutes (target)');
  console.log('  Consensus:       SHA-256d PoW + PoAW (AI inference)');
  console.log('  AI model:        TinyLlama-1.1B-Q4_K_M (pinned)');
  console.log('  No premine:      ✅');
  console.log('  No admin keys:   ✅');

  console.log('\nIssuance Schedule (first 10 eras):');
  console.log('  Era | Reward       | Blocks      | Era Supply');
  console.log('  ' + '─'.repeat(52));
  schedule.slice(0, 10).forEach(e => {
    console.log(
      `  ${String(e.era).padStart(3)} | ` +
      `${String(e.reward).padStart(18)} | ` +
      `${String(e.startBlock).padStart(11)} | ` +
      `${e.eraSupply}`
    );
  });
  console.log('\n  ... approaches 21,000,000 AXN asymptotically\n');
}

async function cmdHelp() {
  banner();
  console.log('Commands:');
  console.log('  axon new                    Generate new wallet');
  console.log('  axon restore                Restore wallet from seed');
  console.log('  axon address                Show your wallet address');
  console.log('  axon mine [n]               Mine n blocks (default: 1)');
  console.log('  axon mine [n] --address X   Mine to specific address');
  console.log('  axon info                   Protocol info + issuance schedule');
  console.log('  axon test                   Run test suite');
  console.log('  axon help                   Show this help\n');
}

// ─── DISPATCH ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd  = args[0] || 'help';

  switch (cmd) {
    case 'new':      return cmdNew();
    case 'restore':  return cmdRestore();
    case 'address':  return cmdAddress();
    case 'info':     return cmdInfo();
    case 'help':     return cmdHelp();
    case 'mine': {
      const n       = parseInt(args[1]) || 1;
      const addrIdx = args.indexOf('--address');
      const addr    = addrIdx !== -1 ? args[addrIdx + 1] : undefined;
      return cmdMine(n, addr);
    }
    case 'test': {
      const { execSync } = require('child_process');
      execSync('npx ts-node src/test/suite.ts', { stdio: 'inherit' });
      return;
    }
    default:
      console.log(`Unknown command: ${cmd}`);
      return cmdHelp();
  }
}

main().catch(console.error);
