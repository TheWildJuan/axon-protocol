import express from 'express';
import { Blockchain } from './blockchain/chain';
import { mineBlock } from './mining/miner';
import { keypairFromSeed, generateKeypair, formatAXN } from './wallet/wallet';
import { getBlockReward } from './blockchain/block';
import { RPC_PORT } from './blockchain/constants';

// ─── NODE ─────────────────────────────────────────────────────────────────────

const chain   = new Blockchain(true); // testnet
const wallet  = keypairFromSeed(process.env.MINER_SEED || 'default-axon-miner-' + Math.random());
let   mining  = false;

console.log('\n🔲 AXON Node starting...');
console.log(`   Miner address: ${wallet.address}`);
console.log(`   Network: testnet`);
console.log(`   RPC port: ${RPC_PORT}\n`);

// ─── RPC SERVER ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/status', (req, res) => {
  const state = chain.getState();
  res.json({
    height:         state.height,
    bestHash:       state.bestBlockHash,
    powTarget:      state.powTarget.substring(0, 16) + '...',
    poawTarget:     state.poawTarget.substring(0, 16) + '...',
    minerAddress:   wallet.address,
    mining,
  });
});

app.get('/block/:height', (req, res) => {
  const block = chain.getBlockAtHeight(parseInt(req.params.height));
  if (!block) return res.status(404).json({ error: 'Block not found' });
  res.json({
    height:        block.height,
    hash:          block.hash,
    prevHash:      block.header.prevHash,
    timestamp:     block.header.timestamp,
    inferenceHash: block.header.inferenceHash,
    powNonce:      block.header.powNonce,
    poawNonce:     block.header.poawNonce,
    txCount:       block.transactions.length,
    reward:        formatAXN(getBlockReward(block.height!)),
  });
});

app.get('/issuance', (req, res) => {
  res.json(chain.getIssuanceSchedule());
});

app.post('/mine', async (req, res) => {
  if (mining) return res.status(409).json({ error: 'Already mining' });
  mining = true;
  try {
    const result = await mineBlock(chain, wallet.address);
    const added  = chain.addBlock(result.block);
    mining = false;
    if (!added.success) return res.status(400).json({ error: added.error });
    res.json({
      success:  true,
      height:   result.block.height,
      hash:     result.block.hash,
      reward:   formatAXN(getBlockReward(result.block.height!)),
      duration: result.duration.toFixed(2) + 's',
      hashrate: result.hashrate + ' H/s',
    });
  } catch (err: any) {
    mining = false;
    res.status(500).json({ error: err.message });
  }
});

app.listen(RPC_PORT, () => {
  console.log(`🔲 AXON RPC listening on http://localhost:${RPC_PORT}`);
  console.log(`   GET  /status       — node status`);
  console.log(`   GET  /block/:n     — get block by height`);
  console.log(`   GET  /issuance     — full issuance schedule`);
  console.log(`   POST /mine         — mine next block`);
});
