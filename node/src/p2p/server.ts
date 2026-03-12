/**
 * AXON Protocol — P2P Network Layer
 * TCP-based peer-to-peer with JSON message framing.
 * Messages: VERSION, VERACK, GETBLOCKS, BLOCKS, TX, PING, PONG
 *
 * Protocol:
 *   - Every message is a JSON line: { type, payload } + "\n"
 *   - On connect: VERSION handshake
 *   - Block sync: GETBLOCKS → BLOCKS
 *   - New blocks/txs: immediate broadcast to all peers
 */

import * as net    from 'net';
import * as dns    from 'dns/promises';
import { Block, Transaction } from '../blockchain/types';
import { Blockchain }         from '../blockchain/chain';
import { hashBlock }          from '../blockchain/block';
import { DNS_SEEDS, DEFAULT_PORT } from '../blockchain/constants';

// BigInt-safe JSON helpers
function bigintReplacer(_: string, v: unknown) {
  return typeof v === 'bigint' ? { __bigint__: v.toString() } : v;
}
function restoreBigInts(obj: any): any {
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

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface P2PMessage {
  type:    string;
  payload: any;
}

interface PeerInfo {
  id:        string;
  host:      string;
  port:      number;
  version:   string;
  height:    number;
  connected: number; // unix ms
}

// ─── PEER CONNECTION ─────────────────────────────────────────────────────────

class PeerConnection {
  public  info:     Partial<PeerInfo> = {};
  public  ready     = false;
  private buffer    = '';
  private socket:   net.Socket;
  private onMsg:    (peer: PeerConnection, msg: P2PMessage) => void | Promise<void>;
  private onClose:  (peer: PeerConnection) => void;

  constructor(
    socket:  net.Socket,
    onMsg:   (peer: PeerConnection, msg: P2PMessage) => void,
    onClose: (peer: PeerConnection) => void,
  ) {
    this.socket  = socket;
    this.onMsg   = onMsg;
    this.onClose = onClose;

    socket.setEncoding('utf8');
    socket.on('data',  (data: string) => this.onData(data));
    socket.on('close', ()    => this.onClose(this));
    socket.on('error', (err) => {
      // Swallow connection errors — peer disconnected
    });
    socket.setTimeout(60_000, () => socket.destroy());
  }

  private onData(data: string) {
    this.buffer += data;
    const lines  = this.buffer.split('\n');
    this.buffer  = lines.pop()!; // last (possibly incomplete) chunk

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg: P2PMessage = JSON.parse(line);
        Promise.resolve(this.onMsg(this, msg)).catch(() => {});
      } catch {
        // Invalid JSON — ignore
      }
    }
  }

  send(type: string, payload: any = {}) {
    try {
      const msg = JSON.stringify({ type, payload }, bigintReplacer) + '\n';
      this.socket.write(msg);
    } catch (e: any) {
      // Serialization failure — log but don't crash
    }
  }

  get address(): string {
    const addr = this.socket.remoteAddress || '?';
    const port = this.info.port || this.socket.remotePort || 0;
    return `${addr}:${port}`;
  }

  destroy() { this.socket.destroy(); }
}

// ─── P2P SERVER ──────────────────────────────────────────────────────────────

export class P2PServer {
  private server:   net.Server;
  private peers:    Map<string, PeerConnection> = new Map();
  private chain:    Blockchain;
  private port:     number;
  private seedPeers: string[];
  private seenBlocks = new Set<string>(); // dedup broadcasts
  private seenTxs    = new Set<string>();

  constructor(chain: Blockchain, port: number, seedPeers: string[] = []) {
    this.chain     = chain;
    this.port      = port;
    this.seedPeers = seedPeers;
    this.server    = net.createServer(socket => this.onIncoming(socket));
  }

  async start() {
    await new Promise<void>((res, rej) => {
      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[P2P] Listening on 0.0.0.0:${this.port}`);
        res();
      });
      this.server.on('error', rej);
    });

    // Connect to manually configured peers
    for (const addr of this.seedPeers) {
      const [host, portStr] = addr.split(':');
      this.connectTo(host, parseInt(portStr || String(DEFAULT_PORT)));
    }

    // Bootstrap from DNS seeds if no manual peers configured
    if (this.seedPeers.length === 0) {
      this.bootstrapFromDNS().catch(() => {});
    }

    // Periodic ping / peer maintenance
    setInterval(() => this.maintenance(), 30_000);
  }

  // ── DNS seed bootstrap ───────────────────────────────────────────────────

  private async bootstrapFromDNS() {
    console.log('[P2P] Bootstrapping from DNS seeds...');
    let found = 0;
    for (const seed of DNS_SEEDS) {
      try {
        const addrs = await dns.resolve4(seed);
        for (const ip of addrs) {
          console.log(`[P2P] DNS seed ${seed} → ${ip}:${DEFAULT_PORT}`);
          this.connectTo(ip, DEFAULT_PORT);
          found++;
        }
      } catch {
        // DNS resolution failed for this seed — normal if seed isn't live yet
      }
    }
    if (found === 0) {
      console.log('[P2P] No DNS seeds reachable — starting as isolated node.');
    }
  }

  // ── Incoming connection ───────────────────────────────────────────────────

  private onIncoming(socket: net.Socket) {
    const peer = new PeerConnection(socket, this.handleMsg.bind(this), this.onPeerClose.bind(this));
    const id   = `${socket.remoteAddress}:${socket.remotePort}`;
    this.peers.set(id, peer);
    console.log(`[P2P] ← Inbound peer: ${id} (total: ${this.peers.size})`);

    // Send our version
    this.sendVersion(peer);
  }

  // ── Outbound connection ───────────────────────────────────────────────────

  connectTo(host: string, port: number) {
    const id = `${host}:${port}`;
    if (this.peers.has(id)) return;

    const socket = net.connect({ host, port, timeout: 10_000 });

    socket.on('connect', () => {
      const peer = new PeerConnection(socket, this.handleMsg.bind(this), this.onPeerClose.bind(this));
      peer.info.host = host;
      peer.info.port = port;
      this.peers.set(id, peer);
      console.log(`[P2P] → Connected to ${id}`);
      this.sendVersion(peer);
    });

    socket.on('error', () => {
      // Connection refused — peer not available
    });
  }

  // ── Message handling ──────────────────────────────────────────────────────

  private async handleMsg(peer: PeerConnection, msg: P2PMessage) {
    try {
      await this._handleMsg(peer, msg);
    } catch(e: any) {
      console.error(`[P2P] handleMsg error (${msg.type}):`, e.message);
    }
  }

  private async _handleMsg(peer: PeerConnection, msg: P2PMessage) {
    switch (msg.type) {

      case 'VERSION': {
        peer.info.version   = msg.payload.version;
        peer.info.height    = msg.payload.height;
        peer.info.connected = Date.now();
        peer.send('VERACK', {});

        // Request blocks if peer is ahead
        const myHeight = this.chain.getHeight();
        if (msg.payload.height > myHeight) {
          peer.send('GETBLOCKS', { fromHeight: myHeight + 1 });
        }
        break;
      }

      case 'VERACK': {
        peer.ready = true;
        console.log(`[P2P] Handshake complete: ${peer.address} height=${peer.info.height}`);
        break;
      }

      case 'GETBLOCKS': {
        const from  = msg.payload.fromHeight || 1;
        const limit = 500;
        const blocks: Block[] = [];
        const maxH  = Math.min(from + limit - 1, this.chain.getHeight());
        for (let h = from; h <= maxH; h++) {
          const b = await (this.chain as any).getBlockAtHeightAsync(h);
          if (b) blocks.push(b);
        }
        console.log(`[P2P] Sending ${blocks.length} blocks to ${peer.address} (heights ${from}-${maxH})`);
        peer.send('BLOCKS', { blocks });
        break;
      }

      case 'BLOCKS': {
        const blocks: Block[] = msg.payload.blocks || [];
        // Sort by height ascending to ensure correct chain ordering
        blocks.sort((a, b) => (a.height || 0) - (b.height || 0));
        let accepted = 0;
        for (let block of blocks) {
          block = restoreBigInts(block); // restore BigInt fields (returns new object)
          const result = await (this.chain as any).addBlockAsync(block);
          if (result.success) {
            accepted++;
          } else {
            console.log(`[P2P] Block h=${block.height} rejected: ${result.error}`);
            break; // stop at first failure
          }
        }
        if (accepted > 0) {
          console.log(`[P2P] Synced ${accepted}/${blocks.length} blocks from ${peer.address} → height ${this.chain.getHeight()}`);
          // If peer is still ahead, request more
          if (peer.info.height && this.chain.getHeight() < peer.info.height) {
            peer.send('GETBLOCKS', { fromHeight: this.chain.getHeight() + 1 });
          }
        }
        break;
      }

      case 'NEWBLOCK': {
        let block: Block = msg.payload.block;
        if (!block?.hash || this.seenBlocks.has(block.hash)) break;
        this.seenBlocks.add(block.hash);
        block = restoreBigInts(block);
        const result = this.chain.addBlock(block);
        if (result.success) {
          console.log(`[P2P] Accepted block ${block.height} from ${peer.address}`);
          // Relay to other peers
          this.broadcast('NEWBLOCK', { block }, peer);
        }
        break;
      }

      case 'TX': {
        const tx: Transaction = msg.payload.tx;
        if (!tx?.inputs || this.seenTxs.has(tx.txid || '')) break;
        if (tx.txid) this.seenTxs.add(tx.txid);
        // Relay
        this.broadcast('TX', { tx }, peer);
        break;
      }

      case 'PING': {
        peer.send('PONG', { nonce: msg.payload.nonce });
        break;
      }

      case 'PONG': break; // latency measurement (future)

      case 'GETPEERS': {
        const peerList = [...this.peers.values()]
          .filter(p => p.info.host)
          .map(p => `${p.info.host}:${p.info.port}`);
        peer.send('PEERS', { peers: peerList });
        break;
      }

      case 'PEERS': {
        // Connect to newly discovered peers (up to 8)
        const addrs: string[] = msg.payload.peers || [];
        for (const addr of addrs.slice(0, 8)) {
          const [host, portStr] = addr.split(':');
          if (host && portStr) this.connectTo(host, parseInt(portStr));
        }
        break;
      }
    }
  }

  // ── Broadcast helpers ─────────────────────────────────────────────────────

  broadcastBlock(block: Block) {
    if (block.hash) this.seenBlocks.add(block.hash);
    this.broadcast('NEWBLOCK', { block });
  }

  broadcastTx(tx: Transaction) {
    if (tx.txid) this.seenTxs.add(tx.txid);
    this.broadcast('TX', { tx });
  }

  private broadcast(type: string, payload: any, except?: PeerConnection) {
    for (const peer of this.peers.values()) {
      if (peer === except) continue;
      if (peer.ready) peer.send(type, payload);
    }
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  private maintenance() {
    // Ping all peers
    for (const peer of this.peers.values()) {
      if (peer.ready) peer.send('PING', { nonce: Date.now() });
    }
    // Request more peers if we have fewer than 8
    if (this.peers.size < 8) {
      for (const peer of this.peers.values()) {
        if (peer.ready) peer.send('GETPEERS', {});
      }
    }
    // Clean up seen sets (prevent unbounded growth)
    if (this.seenBlocks.size > 10_000) this.seenBlocks.clear();
    if (this.seenTxs.size    > 50_000) this.seenTxs.clear();
  }

  private sendVersion(peer: PeerConnection) {
    peer.send('VERSION', {
      version:  '0.4.0',
      height:   this.chain.getHeight(),
      network:  'testnet',
      services: ['full-node'],
    });
  }

  private onPeerClose(peer: PeerConnection) {
    for (const [id, p] of this.peers) {
      if (p === peer) {
        this.peers.delete(id);
        console.log(`[P2P] Peer disconnected: ${id} (remaining: ${this.peers.size})`);
        break;
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  getPeerCount(): number { return this.peers.size; }

  getPeers(): PeerInfo[] {
    return [...this.peers.values()]
      .filter(p => p.ready)
      .map(p => ({
        id:        p.address,
        host:      p.info.host    || p.address.split(':')[0],
        port:      p.info.port    || 8333,
        version:   p.info.version || 'unknown',
        height:    p.info.height  || 0,
        connected: p.info.connected || 0,
      }));
  }
}

// ─── BIGINT RESTORE ───────────────────────────────────────────────────────────
// Blocks arriving over the wire lose BigInt — restore known bigint fields

function restoreBlock(block: Block) {
  for (const tx of block.transactions || []) {
    for (const out of tx.outputs || []) {
      if (typeof out.value === 'string' || typeof out.value === 'number') {
        out.value = BigInt(out.value);
      }
    }
  }
}
