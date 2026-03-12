/**
 * AXON Protocol — Persistent Mempool
 *
 * Wraps the in-memory mempool Map with LevelDB persistence.
 * On startup: loads all unconfirmed txs from disk.
 * On add:     writes to disk immediately.
 * On remove:  deletes from disk.
 * On confirm: called by miner after block is added.
 *
 * Key format: "mempool:<txid>"
 * Value:      JSON({ tx, fee, addedAt })
 */

import { Level } from 'level';
import * as path  from 'path';
import { Transaction } from './types';
import { restoreBigInts, bigintReplacer } from './store';

const MEMPOOL_PREFIX = 'mempool:';

interface MempoolEntry {
  tx:      Transaction;
  fee:     bigint;
  addedAt: number;
}

export class MempoolStore {
  private db:      Level<string, string> | null = null;
  private entries: Map<string, MempoolEntry>    = new Map();
  private dir:     string;
  private persist: boolean;

  constructor(chainDir?: string, persist = false) {
    this.persist = persist;
    this.dir     = chainDir
      ? path.join(chainDir, 'mempool')
      : path.join(process.env.HOME || '.', '.axon', 'mempool');
  }

  async open(): Promise<void> {
    if (!this.persist) return;
    this.db = new Level<string, string>(this.dir, { valueEncoding: 'utf8' });
    await (this.db as any).open();

    // Load all persisted entries
    let loaded = 0;
    try {
      for await (const [key, val] of (this.db as any).iterator()) {
        if (!key.startsWith(MEMPOOL_PREFIX)) continue;
        try {
          const raw   = JSON.parse(val);
          const entry = restoreBigInts(raw) as MempoolEntry;
          const txid  = key.slice(MEMPOOL_PREFIX.length);
          this.entries.set(txid, entry);
          loaded++;
        } catch { /* corrupt entry — skip */ }
      }
    } catch { /* empty db */ }

    if (loaded > 0) {
      console.log(`[Mempool] Restored ${loaded} unconfirmed tx(s) from disk`);
    }
  }

  async close(): Promise<void> {
    if (this.db) await this.db.close();
  }

  // ── Core operations ──────────────────────────────────────────────────────

  has(txid: string): boolean {
    return this.entries.has(txid);
  }

  get(txid: string): MempoolEntry | undefined {
    return this.entries.get(txid);
  }

  size(): number { return this.entries.size; }

  values(): IterableIterator<MempoolEntry> {
    return this.entries.values();
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  async add(txid: string, entry: MempoolEntry): Promise<void> {
    this.entries.set(txid, entry);
    if (this.db) {
      await this.db.put(
        MEMPOOL_PREFIX + txid,
        JSON.stringify(entry, bigintReplacer)
      );
    }
  }

  async remove(txid: string): Promise<void> {
    this.entries.delete(txid);
    if (this.db) {
      try { await this.db.del(MEMPOOL_PREFIX + txid); } catch {}
    }
  }

  async removeMany(txids: string[]): Promise<void> {
    for (const txid of txids) {
      this.entries.delete(txid);
    }
    if (this.db) {
      const batch = (this.db as any).batch();
      for (const txid of txids) {
        batch.del(MEMPOOL_PREFIX + txid);
      }
      await batch.write();
    }
  }

  // Called after a block is mined — remove all confirmed txids
  async confirmBlock(txids: string[]): Promise<void> {
    await this.removeMany(txids);
  }

  // Evict txs older than maxAgeMs (default: 72 hours)
  async evictStale(maxAgeMs = 72 * 60 * 60 * 1000): Promise<number> {
    const cutoff  = Date.now() - maxAgeMs;
    const stale   = [...this.entries.entries()]
      .filter(([, e]) => e.addedAt < cutoff)
      .map(([txid]) => txid);
    if (stale.length > 0) await this.removeMany(stale);
    return stale.length;
  }

  toJSON(): object {
    return {
      count:     this.entries.size,
      txids:     [...this.entries.keys()],
      totalFees: [...this.entries.values()].reduce((s, e) => s + e.fee, 0n),
    };
  }
}
