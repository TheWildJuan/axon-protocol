/**
 * AXON Protocol — Blockchain
 * Persistent (LevelDB) by default; in-memory for tests.
 */

import { Block, BlockchainState, UTXO } from './types';
import { hashBlock, validateBlock, getBlockReward, computeMerkleRoot } from './block';
import {
  GENESIS_TIMESTAMP, GENESIS_HASH, GENESIS_MESSAGE,
  INITIAL_POW_TARGET, INITIAL_POAW_TARGET,
  TESTNET_POW_TARGET, TESTNET_POAW_TARGET,
  TARGET_BLOCK_TIME, DIFFICULTY_ADJUSTMENT_INTERVAL, HALVING_INTERVAL,
  CANONICAL_MODEL, CHECKPOINTS,
} from './constants';
import { adjustTarget } from './crypto';
import { ChainStore }    from './store';

// ─── BLOCKCHAIN ───────────────────────────────────────────────────────────────

export class Blockchain {
  // In-memory caches (always populated)
  private blocks:      Map<string, Block>  = new Map();
  private heightIndex: Map<number, string> = new Map();
  private utxos:       Map<string, UTXO>   = new Map();
  private state!:      BlockchainState;

  private testnet:           boolean;
  private store:             ChainStore | null = null;
  private persisted:         boolean;
  private skipMaturity:      boolean;
  private initPromise:       Promise<void>;

  constructor(testnet = true, persist = false, chainDir?: string, skipMaturity = false) {
    this.testnet      = testnet;
    this.persisted    = persist;
    this.skipMaturity = skipMaturity;
    if (persist) {
      this.store = new ChainStore(chainDir);
    }
    this.initPromise = this.init();
  }

  // Wait for async init — call before first use when persist=true
  async ready(): Promise<void> {
    return this.initPromise;
  }

  private async init() {
    if (this.store) {
      await this.store.open();
      const saved = await this.store.getState();
      if (saved) {
        this.state  = saved;
        this.utxos  = await this.store.getAllUTXOs();
        console.log(`[AXON] Loaded chain from disk: height ${this.state.height}, best: ${this.state.bestBlockHash.substring(0, 16)}...`);
        console.log(`[AXON] Restored ${this.utxos.size} UTXOs from disk`);
        return;
      }
    }
    // Fresh chain
    this.state = {
      height:         0,
      bestBlockHash:  '0'.repeat(64),
      totalWork:      0n,
      powTarget:      this.testnet ? TESTNET_POW_TARGET  : INITIAL_POW_TARGET,
      poawTarget:     this.testnet ? TESTNET_POAW_TARGET : INITIAL_POAW_TARGET,
      lastAdjustTime: GENESIS_TIMESTAMP,
    };
    this.initGenesis();
  }

  private initGenesis() {
    const { hashTx, computeMerkleRoot } = require('./block');

    // Genesis coinbase — embeds the canonical model hash and genesis message
    // scriptSig: height(4) + model_sha256(32) + message_utf8
    const heightBytes = Buffer.alloc(4);
    heightBytes.writeUInt32LE(0, 0);
    const modelHashBytes = Buffer.from(CANONICAL_MODEL.sha256, 'hex');
    const messageBytes   = Buffer.from(GENESIS_MESSAGE, 'utf8');
    const scriptSig = Buffer.concat([heightBytes, modelHashBytes, messageBytes]).toString('hex');

    const genesisCoinbase: any = {
      version: 1,
      inputs: [{
        prevTxid:  '00'.repeat(32),
        prevIndex: 0xffffffff,
        scriptSig,
        sequence:  0xffffffff,
      }],
      outputs: [{
        value:        0n,          // no reward on genesis block
        scriptPubKey: '76a914' + '00'.repeat(20) + '88ac',
      }],
      locktime: 0,
    };
    genesisCoinbase.txid = hashTx(genesisCoinbase);

    const merkleRoot = computeMerkleRoot([genesisCoinbase]);

    const genesis: Block = {
      header: {
        version:       1,
        prevHash:      '0'.repeat(64),
        merkleRoot,
        timestamp:     GENESIS_TIMESTAMP,
        powBits:       0x1d00ffff,
        powNonce:      0,
        poawBits:      0x1d00ffff,
        poawNonce:     0,
        minerAddress:  '0'.repeat(40),
        inferenceHash: CANONICAL_MODEL.sha256,  // pin model in genesis header
      },
      transactions: [genesisCoinbase as any],
      height: 0,
    };

    // Compute the real genesis hash from the header
    const { hashBlock } = require('./block');
    const genesisHash = hashBlock(genesis.header);
    genesis.hash = genesisHash;

    // Verify it matches our hardcoded expected hash (catches any accidental changes)
    if (genesisHash !== GENESIS_HASH) {
      throw new Error(
        `Genesis hash mismatch!\n` +
        `  Computed: ${genesisHash}\n` +
        `  Expected: ${GENESIS_HASH}\n` +
        `  Update GENESIS_HASH in constants.ts if this is intentional.`
      );
    }

    this.blocks.set(genesisHash, genesis);
    this.heightIndex.set(0, genesisHash);
    this.state.bestBlockHash = genesisHash;

    if (!this.persisted) {
      console.log(`[AXON] Genesis: ${genesisHash.substring(0, 24)}...`);
    }
  }

  // ─── GETTERS ─────────────────────────────────────────────────────────────────

  getHeight():    number           { return this.state.height; }
  getBestHash():  string           { return this.state.bestBlockHash; }
  getState():     BlockchainState  { return { ...this.state }; }
  getPowTarget(): string           { return this.state.powTarget; }
  getPoawTarget():string           { return this.state.poawTarget; }

  getBlock(hash: string): Block | undefined {
    return this.blocks.get(hash);
  }

  getBlockAtHeight(height: number): Block | undefined {
    const hash = this.heightIndex.get(height);
    return hash ? this.blocks.get(hash) : undefined;
  }

  async getBlockAtHeightAsync(height: number): Promise<Block | null> {
    // Check in-memory first
    const hash = this.heightIndex.get(height);
    if (hash) {
      const block = this.blocks.get(hash);
      if (block) return block;
    }
    // Fall back to store
    if (this.store) {
      return this.store.getBlockAtHeight(height);
    }
    return null;
  }

  getUTXO(txid: string, index: number): UTXO | undefined {
    return this.utxos.get(`${txid}:${index}`);
  }

  // ─── ADD BLOCK ───────────────────────────────────────────────────────────────

  addBlock(block: Block): { success: boolean; error?: string } {
    const height   = this.state.height + 1;
    const prevHash = this.state.bestBlockHash;

    const result = validateBlock(
      block, prevHash, height,
      this.state.powTarget, this.state.poawTarget,
      (txid, index) => {
        const utxo = this.utxos.get(`${txid}:${index}`);
        if (!utxo) return null;
        // skipMaturity: treat all UTXOs as non-coinbase (test-only flag)
        const effectiveCoinbase = this.skipMaturity ? false : utxo.coinbase;
        return { value: utxo.value, scriptPubKey: utxo.scriptPubKey, coinbase: effectiveCoinbase, blockHeight: utxo.blockHeight };
      }
    );

    if (!result.valid) return { success: false, error: result.error };

    const blockHash = hashBlock(block.header);

    // Checkpoint enforcement — block hash must match if height is checkpointed
    const checkpoint = CHECKPOINTS.find(([h]) => h === height);
    if (checkpoint) {
      const [, expectedHash] = checkpoint;
      if (blockHash !== expectedHash) {
        return { success: false, error: `Checkpoint failure at height ${height}: expected ${expectedHash.substring(0, 16)}..., got ${blockHash.substring(0, 16)}...` };
      }
    }
    block.hash   = blockHash;
    block.height = height;

    // Update UTXO set
    this.applyBlock(block, height);

    // Update in-memory state
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

  async addBlockAsync(block: Block): Promise<{ success: boolean; error?: string }> {
    const result = this.addBlock(block);
    if (result.success && this.store) {
      await this.persistBlock(block);
    }
    return result;
  }

  private async persistBlock(block: Block) {
    if (!this.store) return;
    await this.store.putBlock(block);
    await this.store.putState(this.state);
    // Persist UTXO changes (rebuild from in-memory map)
    for (const tx of block.transactions) {
      const isCoinbase = tx.inputs[0].prevIndex === 0xffffffff;
      if (!isCoinbase) {
        for (const inp of tx.inputs) {
          await this.store.deleteUTXO(inp.prevTxid, inp.prevIndex);
        }
      }
      for (let i = 0; i < tx.outputs.length; i++) {
        const utxo = this.utxos.get(`${tx.txid}:${i}`);
        if (utxo) await this.store.putUTXO(utxo);
      }
    }
  }

  private applyBlock(block: Block, height: number) {
    for (const tx of block.transactions) {
      const isCoinbase = tx.inputs[0].prevIndex === 0xffffffff;
      if (!isCoinbase) {
        for (const inp of tx.inputs) {
          this.utxos.delete(`${inp.prevTxid}:${inp.prevIndex}`);
        }
      }
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

    this.state.powTarget  = adjustTarget(this.state.powTarget,  actualTime, expectedTime);
    this.state.poawTarget = adjustTarget(this.state.poawTarget, actualTime, expectedTime);
    this.state.lastAdjustTime = endBlock.header.timestamp;

    console.log(`[AXON] Difficulty adjusted at block ${height}`);
  }

  // ─── BALANCE / UTXO QUERY ────────────────────────────────────────────────────

  getBalance(address: string): { confirmed: bigint; utxos: UTXO[] } {
    const { addressToScript } = require('./block');
    const targetScript = addressToScript(address);
    const matching: UTXO[] = [];
    for (const utxo of this.utxos.values()) {
      if (utxo.scriptPubKey === targetScript) matching.push(utxo);
    }
    const total = matching.reduce((s, u) => s + u.value, 0n);
    return { confirmed: total, utxos: matching };
  }

  // ─── ISSUANCE SCHEDULE ───────────────────────────────────────────────────────

  getIssuanceSchedule(): Array<{
    era: number; startBlock: number; endBlock: number; reward: string; eraSupply: string;
  }> {
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

  async close() {
    if (this.store) await this.store.close();
  }
}

// ─── FACTORY: open persistent chain ──────────────────────────────────────────

export async function openChain(testnet = true, chainDir?: string): Promise<Blockchain> {
  const chain = new Blockchain(testnet, true, chainDir);
  await chain.ready();
  return chain;
}
