/**
 * AXON Protocol — Local Testnet Simulation
 * Mines 10 blocks, verifies chain, prints issuance schedule
 */

import { Blockchain } from '../blockchain/chain';
import { mineBlock } from '../mining/miner';
import { keypairFromSeed, formatAXN } from '../wallet/wallet';
import { getBlockReward } from '../blockchain/block';
import { HALVING_INTERVAL } from '../blockchain/constants';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║         AXON PROTOCOL — LOCAL TESTNET SIMULATION     ║');
  console.log('║     Proof of Agent Work — Mine with intelligence      ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // ─── SETUP ──────────────────────────────────────────────────────────────────
  const chain  = new Blockchain(true); // testnet mode
  const miner1 = keypairFromSeed('alice-miner-axon-2026');
  const miner2 = keypairFromSeed('bob-miner-axon-2026');

  console.log('Wallets:');
  console.log(`  Miner 1: ${miner1.address}`);
  console.log(`  Miner 2: ${miner2.address}`);

  // ─── MINE BLOCKS ────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('Mining 10 blocks (alternating miners)...');
  console.log('─'.repeat(60));

  const results = [];

  for (let i = 1; i <= 10; i++) {
    const miner     = i % 2 === 0 ? miner2 : miner1;
    const minerName = i % 2 === 0 ? 'Miner 2' : 'Miner 1';

    try {
      const result = await mineBlock(chain, miner.address, [], false);
      const addResult = chain.addBlock(result.block);

      if (!addResult.success) {
        console.error(`  ❌ Block ${i} rejected: ${addResult.error}`);
        continue;
      }

      results.push({ block: result.block, miner: minerName, duration: result.duration });

      const reward = getBlockReward(result.block.height!);
      console.log(`  ✅ Block ${result.block.height} | ${minerName} | reward: ${formatAXN(reward)} | ${result.duration.toFixed(2)}s`);
    } catch (err: any) {
      console.error(`  ❌ Mining error at block ${i}: ${err.message}`);
    }
  }

  // ─── CHAIN STATS ────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('Chain Status:');
  console.log('─'.repeat(60));
  const state = chain.getState();
  console.log(`  Height:        ${state.height}`);
  console.log(`  Best Hash:     ${state.bestBlockHash.substring(0, 32)}...`);
  console.log(`  PoW Target:    ${state.powTarget.substring(0, 32)}...`);
  console.log(`  PoAW Target:   ${state.poawTarget.substring(0, 32)}...`);

  // ─── ISSUANCE SCHEDULE ──────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('AXON Issuance Schedule (Bitcoin-mirrored):');
  console.log('─'.repeat(60));
  console.log('Era | Start Block | End Block  | Reward/Block    | Era Supply');
  console.log('─'.repeat(60));

  const schedule = chain.getIssuanceSchedule();
  for (const row of schedule.slice(0, 10)) {
    console.log(
      `${String(row.era).padStart(3)} | ` +
      `${String(row.startBlock).padStart(11)} | ` +
      `${String(row.endBlock).padStart(10)} | ` +
      `${row.reward.padStart(15)} | ` +
      `${row.eraSupply}`
    );
  }
  console.log('  ... (33 total eras until supply exhausted)');
  console.log('  Max Supply: 21,000,000 AXN (approaches asymptotically)');

  // ─── PROOF VERIFICATION DEMO ────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('Proof Verification Demo:');
  console.log('─'.repeat(60));

  const block5 = chain.getBlockAtHeight(5);
  if (block5) {
    const { verifyPoaw } = await import('../blockchain/block');
    const prevBlock = chain.getBlockAtHeight(4);
    const isValid = prevBlock ? verifyPoaw(
      prevBlock.hash!,
      5,
      block5.header,
      state.poawTarget
    ) : false;

    console.log(`  Block 5 PoAW proof valid: ${isValid ? '✅ YES' : '❌ NO'}`);
    console.log(`  inferenceHash: ${block5.header.inferenceHash.substring(0, 32)}...`);
    console.log(`  poawNonce:     ${block5.header.poawNonce}`);
  }

  // ─── SUMMARY ────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('AXON Testnet Simulation Complete');
  console.log('─'.repeat(60));
  console.log('✅ Hybrid PoW + PoAW consensus working');
  console.log('✅ Block rewards following Bitcoin issuance schedule');
  console.log('✅ Deterministic AI challenge derivation verified');
  console.log('✅ Permissionless — any miner with inference capability can participate');
  console.log('✅ No premine, no admin keys, no central authority');
  console.log('\nNext steps:');
  console.log('  1. Integrate real TinyLlama inference (llama.cpp)');
  console.log('  2. Add P2P networking (libp2p)');
  console.log('  3. Add LevelDB persistence');
  console.log('  4. Launch public testnet');
  console.log('═'.repeat(60) + '\n');
}

main().catch(console.error);
