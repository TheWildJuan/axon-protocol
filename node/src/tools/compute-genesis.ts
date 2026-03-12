/**
 * AXON Protocol — Genesis Hash Computation Tool
 * Run this once to compute the canonical genesis hash, then hardcode it in constants.ts
 *
 * Usage: npx ts-node src/tools/compute-genesis.ts
 */

import { hashBlock, hashTx, computeMerkleRoot } from '../blockchain/block';
import { GENESIS_TIMESTAMP, GENESIS_MESSAGE, CANONICAL_MODEL } from '../blockchain/constants';

// Build genesis coinbase — identical logic to chain.ts initGenesis()
const heightBytes    = Buffer.alloc(4);  // height 0
const modelHashBytes = Buffer.from(CANONICAL_MODEL.sha256, 'hex');
const messageBytes   = Buffer.from(GENESIS_MESSAGE, 'utf8');
const scriptSig      = Buffer.concat([heightBytes, modelHashBytes, messageBytes]).toString('hex');

const genesisCoinbase: any = {
  version: 1,
  inputs: [{
    prevTxid:  '00'.repeat(32),
    prevIndex: 0xffffffff,
    scriptSig,
    sequence:  0xffffffff,
  }],
  outputs: [{
    value:        0n,
    scriptPubKey: '76a914' + '00'.repeat(20) + '88ac',
  }],
  locktime: 0,
};
genesisCoinbase.txid = hashTx(genesisCoinbase);

const merkleRoot = computeMerkleRoot([genesisCoinbase]);

const genesisHeader = {
  version:       1,
  prevHash:      '0'.repeat(64),
  merkleRoot,
  timestamp:     GENESIS_TIMESTAMP,
  powBits:       0x1d00ffff,
  powNonce:      0,
  poawBits:      0x1d00ffff,
  poawNonce:     0,
  minerAddress:  '0'.repeat(40),
  inferenceHash: CANONICAL_MODEL.sha256,
};

const genesisHash = hashBlock(genesisHeader);

console.log('\n╔══════════════════════════════════════════════════════════════════╗');
console.log('║              AXON GENESIS BLOCK COMPUTATION                      ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');
console.log(`Genesis timestamp:   ${GENESIS_TIMESTAMP} (${new Date(GENESIS_TIMESTAMP * 1000).toISOString()})`);
console.log(`Genesis message:     ${GENESIS_MESSAGE}`);
console.log(`Canonical model:     ${CANONICAL_MODEL.name}`);
console.log(`Model SHA256:        ${CANONICAL_MODEL.sha256}`);
console.log(`Coinbase txid:       ${genesisCoinbase.txid}`);
console.log(`Merkle root:         ${merkleRoot}`);
console.log(`\n🔒 GENESIS HASH: ${genesisHash}\n`);
console.log('Update constants.ts:');
console.log(`  GENESIS_HASH = '${genesisHash}'`);
console.log('');
