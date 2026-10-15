/**
 * Net — peer-to-peer rooms over WebRTC using PeerJS (no backend of our own;
 * signalling uses the free public PeerJS broker).
 *
 * Protocol (JSON messages):
 *   hi     guest → host   {v}                      guest says hello
 *   start  host  → guest  {first}                  host starts game 0
 *   move   both           {peg, n}                 n = moves already played
 *   rematch both          {}                       "I want a rematch"
 *   ping/pong             {}                       liveness (watchdog)
 *   bye    both           {}                       leaving on purpose
 */
const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O
const PREFIX = 'sf4-';
const PING_EVERY = 3000;
const DEAD_AFTER = 11000;

let loading = null;
function loadPeerJS() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PEERJS_URL;
    s.async = true;
    s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS missing')));
    s.onerror = () => { loading = null; reject(new Error('Could not load the online module. Check your connection.')); };
    document.head.appendChild(s);
  });
  return loading;
}

export const randomCode = () =>
  Array.from({ length: 4 }, () => ALPHABET[(Math.random() * ALPHABET.length) | 0]).join('');
export const normalizeCode = (s) => (s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

/** Tiny event emitter helper */
class Emitter {
  constructor() { this._h = {}; }
  on(e, fn) { (this._h[e] ||= []).push(fn); return this; }
  emit(e, ...a) { (this._h[e] || []).slice().forEach((fn) => fn(...a)); }
}

export class Room extends Emitter {
  constructor() {
    super();
    this.peer = null;
    this.conn = null;
    this.code = '';
    this.role = null; // 'host' | 'guest'
    this.alive = false;
    this._timers = [];
    this._lastSeen = 0;
    this._closed = false;
    this._opened = false;
    this.warned = false;
  }

  /** Host: create a room and wait for a guest. Resolves with the code. */
  async host() {
    const Peer = await loadPeerJS();
    this.role = 'host';
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = randomCode();
      try {
        await this._openPeer(Peer, PREFIX + code);
        this.code = code;
        this.peer.on('connection', (c) => this._onIncoming(c));
        return code;
      } catch (err) {
        if (err && err.type === 'unavailable-id') continue; // code taken → retry
        throw new Error('Could not reach the matchmaking server.');
      }
    }
    throw new Error('Could not create a room. Try again.');
  }

  /** Guest: join a room by code. Resolves when connected. */
  async join(rawCode) {
    const code = normalizeCode(rawCode);
    if (code.length !== 4) throw new Error('Enter the 4-letter room code.');
    const Peer = await loadPeerJS();
    this.role = 'guest';
    this.code = code;
    try {
      await this._openPeer(Peer, undefined);
    } catch {
      throw new Error('Could not reach the matchmaking server.');
    }
    await new Promise((resolve, reject) => {
      const conn = this.peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      const timer = setTimeout(() => reject(new Error('Room not found or host is unreachable.')), 12000);
      this.peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') { clearTimeout(timer); reject(new Error('Room not found. Check the code.')); }
      });
      conn.on('open', () => { clearTimeout(timer); this._attach(conn); resolve(); });
      conn.on('error', () => { clearTimeout(timer); reject(new Error('Connection failed.')); });
    });
    this.send({ t: 'hi', v: 1 });
  }

  _openPeer(Peer, id) {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id) : new Peer();
      this.peer = peer;
      const t = setTimeout(() => reject(new Error('timeout')), 12000);
      peer.on('open', () => { clearTimeout(t); resolve(); });
      peer.on('error', (err) => {
        clearTimeout(t);
        if (!this._opened) { try { peer.destroy(); } catch { /* ignore */ } this._opened = false; reject(err); }
        else if (!this._closed) this.emit('error', err);
      });
      peer.on('open', () => { this._opened = true; });
      peer.on('disconnected', () => { if (!this._closed && this._opened) { try { peer.reconnect(); } catch { /* ignore */ } } });
    });
  }

  _onIncoming(conn) {
    if (this.conn) { // room already full
      conn.on('open', () => { try { conn.send({ t: 'full' }); } catch { /* ignore */ } setTimeout(() => conn.close(), 200); });
      return;
    }
    conn.on('open', () => this._attach(conn));
  }

  _attach(conn) {
    this.conn = conn;
    this.alive = true;
    this._lastSeen = Date.now();
    conn.on('data', (msg) => {
      this._lastSeen = Date.now();
      if (!msg || typeof msg !== 'object') return;
      if (this.warned) { this.warned = false; this.emit('recovered'); }
      if (msg.t === 'ping') return this.send({ t: 'pong' });
      if (msg.t === 'pong') return;
      this.emit('message', msg);
    });
    conn.on('close', () => this._lost('closed'));
    conn.on('error', () => this._lost('error'));
    this._timers.push(setInterval(() => {
      this.send({ t: 'ping' });
      const idle = Date.now() - this._lastSeen;
      if (idle > DEAD_AFTER) this._lost('timeout');
      else if (idle > DEAD_AFTER / 2 && !this.warned) { this.warned = true; this.emit('unstable'); }
    }, PING_EVERY));
    this.emit('connected');
  }

  _lost(reason) {
    if (!this.alive) return;
    this.alive = false;
    this._clearTimers();
    this.emit('disconnected', reason);
  }

  _clearTimers() { this._timers.forEach(clearInterval); this._timers = []; }

  send(msg) {
    try { if (this.conn && this.conn.open) this.conn.send(msg); } catch { /* connection closing */ }
  }

  /** Close everything. `polite` tells the other side we left on purpose. */
  close(polite = true) {
    if (this._closed) return;
    this._closed = true;
    if (polite) this.send({ t: 'bye' });
    this._clearTimers();
    this.alive = false;
    setTimeout(() => {
      try { this.conn && this.conn.close(); } catch { /* ignore */ }
      try { this.peer && this.peer.destroy(); } catch { /* ignore */ }
    }, polite ? 120 : 0);
  }
}
