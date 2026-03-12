/**
 * AXON Protocol — LevelDB persistence layer
 * Stores blocks, UTXOs, and chain state on disk.
 * Keys:
 *   b:<hash>          → Block (JSON)
 *   h:<height>        → block hash at that height
 *   u:<txid>:<index>  → UTXO (JSON)
 *   meta:state        → BlockchainState (JSON)
 */

import { Level } from 'level';
import * as path  from 'path';
import * as fs    from 'fs';
import { Block, BlockchainState, UTXO } from './types';

// BigInt JSON serialization
export function bigintReplacer(_: string, v: unknown) {
  return typeof v === 'bigint' ? { __bigint__: v.toString() } : v;
}
function bigintReviver(_: string, v: unknown) {
  if (v && typeof v === 'object' && '__bigint__' in (v as any)) {
    return BigInt((v as any).__bigint__);
  }
  return v;
}

const DEFAULT_DIR = path.join(process.env.HOME || '.', '.axon', 'chain');

// Recursively restore BigInt wrappers in a deserialized object
export function restoreBigInts(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'object' && '__bigint__' in obj) return BigInt(obj.__bigint__);
  if (Array.isArray(obj)) return obj.map(restoreBigInts);
  if (typeof obj === 'object') {
    const out: any = {};
    for (const k of Object.keys(obj)) out[k] = restoreBigInts(obj[k]);
    return out;
  }
  return obj;
}

export class ChainStore {
  private db: Level<string, string>;
  private ready = false;

  constructor(dir = DEFAULT_DIR) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Level<string, string>(dir, { valueEncoding: 'json' });
  }

  async open() {
    if (!this.ready) {
      await this.db.open();
      this.ready = true;
    }
  }

  async close() {
    if (this.ready) {
      await this.db.close();
      this.ready = false;
    }
  }

  // ─── BLOCK ──────────────────────────────────────────────────────────────────

  async putBlock(block: Block): Promise<void> {
    await this.db.put(`b:${block.hash}`, JSON.stringify(block, bigintReplacer));
    await this.db.put(`h:${block.height}`, block.hash!);
  }

  async getBlock(hash: string): Promise<Block | null> {
    try {
      const raw = await this.db.get(`b:${hash}`);
      return restoreBigInts(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch { return null; }
  }

  async getBlockAtHeight(height: number): Promise<Block | null> {
    try {
      const hash = await this.db.get(`h:${height}`);
      return this.getBlock(hash as unknown as string);
    } catch { return null; }
  }

  // ─── UTXO ───────────────────────────────────────────────────────────────────

  async putUTXO(utxo: UTXO): Promise<void> {
    await this.db.put(`u:${utxo.txid}:${utxo.index}`, JSON.stringify(utxo, bigintReplacer));
  }

  async getUTXO(txid: string, index: number): Promise<UTXO | null> {
    try {
      const raw = await this.db.get(`u:${txid}:${index}`);
      return restoreBigInts(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch { return null; }
  }

  async deleteUTXO(txid: string, index: number): Promise<void> {
    try { await this.db.del(`u:${txid}:${index}`); } catch {}
  }

  async getUTXOsForAddress(scriptPubKey: string): Promise<UTXO[]> {
    const results: UTXO[] = [];
    for await (const [, value] of this.db.iterator({ gte: 'u:', lte: 'u:~' })) {
      try {
        const raw  = typeof value === 'string' ? JSON.parse(value) : value;
        const utxo = restoreBigInts(raw) as UTXO;
        if (utxo.scriptPubKey === scriptPubKey) results.push(utxo);
      } catch {}
    }
    return results;
  }

  async getAllUTXOs(): Promise<Map<string, UTXO>> {
    const map = new Map<string, UTXO>();
    for await (const [key, value] of this.db.iterator({ gte: 'u:', lte: 'u:~' })) {
      try {
        const raw  = typeof value === 'string' ? JSON.parse(value) : value;
        const utxo = restoreBigInts(raw) as UTXO;
        map.set((key as string).slice(2), utxo);
      } catch {}
    }
    return map;
  }

  // ─── CHAIN STATE ─────────────────────────────────────────────────────────────

  async putState(state: BlockchainState): Promise<void> {
    await this.db.put('meta:state', JSON.stringify(state, bigintReplacer));
  }

  async getState(): Promise<BlockchainState | null> {
    try {
      const raw = await this.db.get('meta:state');
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return restoreBigInts(obj) as BlockchainState;
    } catch { return null; }
  }

  async isInitialized(): Promise<boolean> {
    return (await this.getState()) !== null;
  }
}
