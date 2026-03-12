import { Block, BlockchainState, UTXO } from './types';
import { hashBlock, validateBlock, getBlockReward, computeMerkleRoot } from './block';
import {
  GENESIS_TIMESTAMP, INITIAL_POW_TARGET, INITIAL_POAW_TARGET,
  TESTNET_POW_TARGET, TESTNET_POAW_TARGET,
  TARGET_BLOCK_TIME, DIFFICULTY_ADJUSTMENT_INTERVAL, HALVING_INTERVAL,
} from './constants';
import { adjustTarget, bitsToTarget, targetToBits } from './crypto';

// ─── IN-MEMORY BLOCKCHAIN ─────────────────────────────────────────────────────
// Production: replace with LevelDB persistence

export class Blockchain {
  private blocks: Map<string, Block> = new Map();
  private heightIndex: Map<number, string> = new Map(); // height → hash
  private utxos: Map<string, UTXO> = new Map();         // txid:index → UTXO
  private state: BlockchainState;
  private testnet: boolean;

  constructor(testnet = true) {
    this.testnet = testnet;
    this.state = {
      height:         0,
      bestBlockHash:  '0'.repeat(64),
      totalWork:      0n,
      powTarget:      testnet ? TESTNET_POW_TARGET  : INITIAL_POW_TARGET,
      poawTarget:     testnet ? TESTNET_POAW_TARGET : INITIAL_POAW_TARGET,
      lastAdjustTime: GENESIS_TIMESTAMP,
    };
    this.initGenesis();
  }

  private initGenesis() {
    const genesis: Block = {
      header: {
        version:       1,
        prevHash:      '0'.repeat(64),
        merkleRoot:    '0'.repeat(64),
        timestamp:     GENESIS_TIMESTAMP,
        powBits:       0x1d00ffff,
        powNonce:      0,
        poawBits:      0x1d00ffff,
        poawNonce:     0,
        minerAddress:  '0'.repeat(40),
        inferenceHash: '0'.repeat(64),
      },
      transactions: [],
      height: 0,
    };

    const genesisHash = '0'.repeat(63) + '1'; // symbolic
    genesis.hash = genesisHash;

    this.blocks.set(genesisHash, genesis);
    this.heightIndex.set(0, genesisHash);
    this.state.bestBlockHash = genesisHash;

    console.log(`[AXON] Genesis block: ${genesisHash}`);
    console.log(`[AXON] Message: "Mine with intelligence, not just electricity. 2026-03-12"`);
  }

  getHeight(): number { return this.state.height; }
  getBestHash(): string { return this.state.bestBlockHash; }
  getState(): BlockchainState { return { ...this.state }; }
  getPowTarget(): string { return this.state.powTarget; }
  getPoawTarget(): string { return this.state.poawTarget; }

  getBlock(hash: string): Block | undefined {
    return this.blocks.get(hash);
  }

  getBlockAtHeight(height: number): Block | undefined {
    const hash = this.heightIndex.get(height);
    return hash ? this.blocks.get(hash) : undefined;
  }

  getUTXO(txid: string, index: number): UTXO | undefined {
    return this.utxos.get(`${txid}:${index}`);
  }

  // Add a validated block to the chain
  addBlock(block: Block): { success: boolean; error?: string } {
    const height = this.state.height + 1;
    const prevHash = this.state.bestBlockHash;

    const result = validateBlock(
      block,
      prevHash,
      height,
      this.state.powTarget,
      this.state.poawTarget,
      (txid, index) => {
        const utxo = this.utxos.get(`${txid}:${index}`);
        return utxo ? utxo.value : null;
      }
    );

    if (!result.valid) {
      return { success: false, error: result.error };
    }

    const blockHash = hashBlock(block.header);
    block.hash   = blockHash;
    block.height = height;

    // Update UTXO set
    this.applyBlock(block, height);

    // Update chain state
    this.blocks.set(blockHash, block);
    this.heightIndex.set(height, blockHash);
    this.state.height        = height;
    this.state.bestBlockHash = blockHash;

    // Difficulty adjustment
    if (height % DIFFICULTY_ADJUSTMENT_INTERVAL === 0) {
      this.adjustDifficulty(height);
    }

    return { success: true };
  }

  private applyBlock(block: Block, height: number) {
    for (const tx of block.transactions) {
      const isCoinbase = tx.inputs[0].prevIndex === 0xffffffff;

      // Remove spent UTXOs
      if (!isCoinbase) {
        for (const inp of tx.inputs) {
          this.utxos.delete(`${inp.prevTxid}:${inp.prevIndex}`);
        }
      }

      // Add new UTXOs
      const txid = tx.txid!;
      for (let i = 0; i < tx.outputs.length; i++) {
        this.utxos.set(`${txid}:${i}`, {
          txid,
          index:        i,
          value:        tx.outputs[i].value,
          scriptPubKey: tx.outputs[i].scriptPubKey,
          blockHeight:  height,
          coinbase:     isCoinbase,
        });
      }
    }
  }

  private adjustDifficulty(height: number) {
    const startBlock = this.getBlockAtHeight(height - DIFFICULTY_ADJUSTMENT_INTERVAL);
    const endBlock   = this.getBlockAtHeight(height);
    if (!startBlock || !endBlock) return;

    const actualTime   = endBlock.header.timestamp - startBlock.header.timestamp;
    const expectedTime = DIFFICULTY_ADJUSTMENT_INTERVAL * TARGET_BLOCK_TIME;

    const newPowTarget  = adjustTarget(this.state.powTarget,  actualTime, expectedTime);
    const newPoawTarget = adjustTarget(this.state.poawTarget, actualTime, expectedTime);

    console.log(`[AXON] Difficulty adjustment at block ${height}`);
    console.log(`  PoW:  ${this.state.powTarget.substring(0,16)}... → ${newPowTarget.substring(0,16)}...`);
    console.log(`  PoAW: ${this.state.poawTarget.substring(0,16)}... → ${newPoawTarget.substring(0,16)}...`);

    this.state.powTarget  = newPowTarget;
    this.state.poawTarget = newPoawTarget;
    this.state.lastAdjustTime = endBlock.header.timestamp;
  }

  getIssuanceSchedule(): Array<{ era: number; startBlock: number; endBlock: number; reward: string; eraSupply: string }> {
    const schedule = [];
    for (let era = 0; era < 33; era++) {
      const reward = era < 64 ? (5_000_000_000n >> BigInt(era)) : 0n;
      if (reward === 0n) break;
      schedule.push({
        era:        era + 1,
        startBlock: era * HALVING_INTERVAL + 1,
        endBlock:   (era + 1) * HALVING_INTERVAL,
        reward:     (Number(reward) / 1e8).toFixed(8) + ' AXN',
        eraSupply:  (Number(reward * BigInt(HALVING_INTERVAL)) / 1e8).toFixed(2) + ' AXN',
      });
    }
    return schedule;
  }
}
