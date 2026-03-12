/**
 * AXON Protocol — Full Node
 * RPC + P2P + fee market + rate limiting
 */

import express, { Request, Response, NextFunction } from 'express';
import * as http   from 'http';
import * as net    from 'net';
import rateLimit   from 'express-rate-limit';
import { openChain, Blockchain } from './blockchain/chain';
import { mineBlock }             from './mining/miner';
import { keypairFromSeed, keypairFromMnemonic, formatAXN } from './wallet/wallet';
import { getBlockReward, hashTx, addressToScript } from './blockchain/block';
import { RPC_PORT }              from './blockchain/constants';
import { Transaction }           from './blockchain/types';
import { P2PServer }             from './p2p/server';

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const RPC_HOST    = process.env.RPC_HOST    || '127.0.0.1';
const P2P_PORT    = parseInt(process.env.P2P_PORT || '8333');
const MINER_SEED  = process.env.MINER_SEED  || 'axon-default-miner';
const PEERS       = (process.env.PEERS || '').split(',').filter(Boolean);
const TESTNET     = process.env.NETWORK !== 'mainnet';

// ─── MIN FEE POLICY ──────────────────────────────────────────────────────────
// Minimum relay fee: 1 sat/byte = 1000 satoshis (~250 byte tx)
const MIN_RELAY_FEE = 1_000n; // satoshis

// ─── MEMPOOL ─────────────────────────────────────────────────────────────────

const mempool = new Map<string, { tx: Transaction; fee: bigint; addedAt: number }>();

function mempoolSize(): number { return mempool.size; }

function addToMempool(tx: Transaction, fee: bigint): { ok: boolean; error?: string } {
  if (fee < MIN_RELAY_FEE) {
    return { ok: false, error: `Fee ${fee} below minimum relay fee ${MIN_RELAY_FEE}` };
  }
  const txid = hashTx(tx);
  tx.txid    = txid;
  if (mempool.has(txid)) return { ok: false, error: 'Already in mempool' };
  mempool.set(txid, { tx, fee, addedAt: Date.now() });
  return { ok: true };
}

function getTopTxs(maxBytes = 1_000_000): Transaction[] {
  // Sort by fee-per-byte descending, fill up to maxBytes
  const sorted = [...mempool.values()].sort((a, b) =>
    Number(b.fee - a.fee)
  );
  const selected: Transaction[] = [];
  let   totalBytes = 0;
  for (const entry of sorted) {
    const size = JSON.stringify(entry.tx).length;
    if (totalBytes + size > maxBytes) break;
    selected.push(entry.tx);
    totalBytes += size;
  }
  return selected;
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────

async function main() {
  const chain  = await openChain(TESTNET);
  const wallet = keypairFromSeed(MINER_SEED);
  let   mining = false;

  console.log('\n⚡ AXON Node');
  console.log(`   Network:  ${TESTNET ? 'testnet' : 'mainnet'}`);
  console.log(`   Height:   ${chain.getHeight()}`);
  console.log(`   Miner:    ${wallet.address}`);
  console.log(`   RPC:      http://${RPC_HOST}:${RPC_PORT}`);
  console.log(`   P2P:      0.0.0.0:${P2P_PORT}`);
  console.log(`   Min fee:  ${formatAXN(MIN_RELAY_FEE)}/tx\n`);

  // ─── P2P SERVER ─────────────────────────────────────────────────────────────

  const p2p = new P2PServer(chain, P2P_PORT, PEERS);
  await p2p.start();

  // ─── RPC SERVER ─────────────────────────────────────────────────────────────

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // ── Rate limiting ──────────────────────────────────────────────────────────

  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,    // 1 minute
    max: 120,               // 120 req/min per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down' },
  });

  const mineLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,                 // 5 mine requests/min per IP
    message: { error: 'Mining rate limited' },
  });

  const txLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,                // 30 tx submissions/min per IP
    message: { error: 'Transaction rate limited' },
  });

  app.use(globalLimiter);

  // ── Endpoints ──────────────────────────────────────────────────────────────

  // GET /status
  app.get('/status', (req, res) => {
    const state = chain.getState();
    res.json({
      version:      '0.4.0',
      network:      TESTNET ? 'testnet' : 'mainnet',
      height:       state.height,
      bestHash:     state.bestBlockHash,
      powTarget:    state.powTarget.substring(0, 16) + '...',
      poawTarget:   state.poawTarget.substring(0, 16) + '...',
      miner:        wallet.address,
      peers:        p2p.getPeerCount(),
      mempool:      mempoolSize(),
      minRelayFee:  formatAXN(MIN_RELAY_FEE),
      mining,
    });
  });

  // GET /block/:height
  app.get('/block/:height', (req, res) => {
    const height = parseInt(req.params.height);
    if (isNaN(height) || height < 0) return res.status(400).json({ error: 'Invalid height' });
    const block = chain.getBlockAtHeight(height);
    if (!block) return res.status(404).json({ error: 'Block not found' });
    res.json({
      height:        block.height,
      hash:          block.hash,
      prevHash:      block.header.prevHash,
      merkleRoot:    block.header.merkleRoot,
      timestamp:     block.header.timestamp,
      inferenceHash: block.header.inferenceHash,
      minerAddress:  block.header.minerAddress,
      powNonce:      block.header.powNonce,
      poawNonce:     block.header.poawNonce,
      txCount:       block.transactions.length,
      reward:        formatAXN(getBlockReward(block.height!)),
    });
  });

  // GET /tx/:txid
  app.get('/tx/:txid', (req, res) => {
    const entry = mempool.get(req.params.txid);
    if (entry) return res.json({ ...entry.tx, status: 'mempool', fee: formatAXN(entry.fee) });
    res.status(404).json({ error: 'Transaction not found' });
  });

  // GET /balance/:address
  app.get('/balance/:address', (req, res) => {
    const bal = chain.getBalance(req.params.address);
    res.json({
      address:   req.params.address,
      confirmed: formatAXN(bal.confirmed),
      satoshis:  bal.confirmed.toString(),
      utxos:     bal.utxos.length,
    });
  });

  // GET /utxos/:address
  app.get('/utxos/:address', (req, res) => {
    const bal = chain.getBalance(req.params.address);
    res.json(bal.utxos.map(u => ({
      txid:        u.txid,
      index:       u.index,
      value:       formatAXN(u.value),
      satoshis:    u.value.toString(),
      blockHeight: u.blockHeight,
      coinbase:    u.coinbase,
    })));
  });

  // GET /mempool
  app.get('/mempool', (req, res) => {
    res.json({
      count: mempool.size,
      txids: [...mempool.keys()],
      totalFees: formatAXN([...mempool.values()].reduce((s, e) => s + e.fee, 0n)),
    });
  });

  // GET /issuance
  app.get('/issuance', (req, res) => {
    res.json(chain.getIssuanceSchedule());
  });

  // GET /peers
  app.get('/peers', (req, res) => {
    res.json(p2p.getPeers());
  });

  // POST /tx — broadcast a transaction
  app.post('/tx', txLimiter, (req, res) => {
    const tx: Transaction = req.body;
    if (!tx || !tx.inputs || !tx.outputs) {
      return res.status(400).json({ error: 'Invalid transaction format' });
    }

    // Calculate fee (input sum - output sum)
    // For now: require fee field explicitly (full UTXO lookup needs synced chain)
    const feeStr = req.body.fee;
    const fee    = feeStr ? BigInt(feeStr) : MIN_RELAY_FEE;

    if (fee < MIN_RELAY_FEE) {
      return res.status(400).json({
        error: `Fee too low. Minimum: ${formatAXN(MIN_RELAY_FEE)}`,
        minFee: MIN_RELAY_FEE.toString(),
      });
    }

    const result = addToMempool(tx, fee);
    if (!result.ok) return res.status(400).json({ error: result.error });

    // Broadcast to peers
    p2p.broadcastTx(tx);

    res.json({ success: true, txid: tx.txid, fee: formatAXN(fee) });
  });

  // POST /mine — mine next block
  app.post('/mine', mineLimiter, async (req, res) => {
    if (mining) return res.status(409).json({ error: 'Already mining' });
    mining = true;
    try {
      const txs    = getTopTxs();           // include highest-fee mempool txs
      const result = await mineBlock(chain, wallet.address, txs, false);
      const added  = await (chain as any).addBlockAsync(result.block);
      mining       = false;

      if (!added.success) return res.status(400).json({ error: added.error });

      // Clear included txs from mempool
      for (const tx of txs) {
        if (tx.txid) mempool.delete(tx.txid);
      }

      // Broadcast to peers
      p2p.broadcastBlock(result.block);

      res.json({
        success:  true,
        height:   result.block.height,
        hash:     result.block.hash,
        reward:   formatAXN(getBlockReward(result.block.height!)),
        txs:      result.block.transactions.length,
        duration: result.duration.toFixed(2) + 's',
        hashrate: result.hashrate + ' H/s',
      });
    } catch (err: any) {
      mining = false;
      res.status(500).json({ error: err.message });
    }
  });

  // ── Error handler ──────────────────────────────────────────────────────────
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  const server = app.listen(RPC_PORT, RPC_HOST, () => {
    console.log(`⚡ AXON RPC ready on http://${RPC_HOST}:${RPC_PORT}`);
    console.log('   GET  /status         node status');
    console.log('   GET  /block/:n        block by height');
    console.log('   GET  /balance/:addr   address balance');
    console.log('   GET  /utxos/:addr     UTXO list');
    console.log('   GET  /mempool         mempool info');
    console.log('   GET  /peers           connected peers');
    console.log('   GET  /issuance        issuance schedule');
    console.log('   POST /tx              broadcast transaction');
    console.log('   POST /mine            mine next block');
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
