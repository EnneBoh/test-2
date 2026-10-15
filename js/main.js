/**
 * main.js — wires GameState (rules) ↔ Renderer (3D) ↔ UI (DOM), AI and online play.
 */
import { GameState, cellXYZ, pegXZ } from './gamestate.js';
import { Renderer } from './renderer.js';
import { chooseMove, DIFFICULTIES } from './ai.js';
import { Sound } from './audio.js';
import { Room, normalizeCode } from './net.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ───────────────────────── settings (localStorage, failure-safe) ─────────────────────────
const KEY = 'score4.settings.v1';
const settings = { sound: true, lastMode: null, difficulty: 'medium', confirmTap: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* storage unavailable */ }
const saveSettings = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ } };

// ───────────────────────── DOM refs ─────────────────────────
const el = {
  stage: $('#stage'), live: $('#sr-live'), toast: $('#toast'),
  screens: { menu: $('#menu'), lobby: $('#lobby'), hud: $('#hud') },
  turn: $('#turn'), turnAvatar: $('#turn-avatar'), turnName: $('#turn-name'), turnSub: $('#turn-sub'),
  moveCount: $('#move-count'), room: $('#hud-room'), roomText: $('#hud-room-text'),
  undo: $('#btn-undo'), view: $('#btn-view'), sound: $('#btn-sound'), menuBtn: $('#btn-menu'),
  result: $('#result'), resultTitle: $('#result-title'), resultSub: $('#result-sub'), resultMedal: $('#result-medal'),
  rematch: $('#btn-rematch'), resultMenu: $('#btn-result-menu'),
  howto: $('#dlg-howto'), confirm: $('#dlg-confirm'), confirmText: $('#confirm-text'),
  swSound: $('#sw-sound'), swConfirm: $('#sw-confirm'),
  lobbyChoose: $('#lobby-choose'), lobbyHost: $('#lobby-host'), lobbyJoin: $('#lobby-join'),
  roomCode: $('#room-code'), hostStatus: $('#host-status'), joinCode: $('#join-code'), joinStatus: $('#join-status'),
  copy: $('#btn-copy'), share: $('#btn-share'),
};

// ───────────────────────── app state ─────────────────────────
const sound = new Sound();
const app = {
  screen: 'menu',
  phase: 'menu',            // 'menu' | 'playing' | 'over'
  mode: null,               // 'local' | 'ai' | 'online'
  state: new GameState(),
  gameId: 0,                // bumps whenever a game is reset → invalidates async continuations
  games: 0,                 // games started in this session (alternates who goes first)
  landing: 0,               // spheres currently falling
  thinking: false,          // AI is thinking
  aimPeg: -1,               // peg being previewed (hover / keyboard / touch select)
  aimType: 'mouse',
  room: null,               // online Room
  myPlayer: 1,              // online: which player am I
  rematch: { me: false, them: false },
  peerGone: false,
  resultTimer: 0,
};

// ───────────────────────── renderer ─────────────────────────
const renderer = new Renderer(el.stage, {
  onHover: (peg) => { if (app.phase === 'playing') { app.aimType = 'mouse'; app.aimPeg = peg; refreshAim(); } },
  onTap: (peg, type) => handleTap(peg, type),
  onLand: (strength) => sound.land(strength),
});

// ───────────────────────── helpers: UI ─────────────────────────
function announce(msg) {
  el.live.textContent = '';
  requestAnimationFrame(() => { el.live.textContent = msg; });
}

let toastTimer = 0;
function toast(msg, ms = 2400) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function showScreen(name) {
  app.screen = name;
  for (const [key, node] of Object.entries(el.screens)) {
    const on = key === name;
    node.classList.toggle('is-active', on);
    node.inert = !on;
    node.setAttribute('aria-hidden', String(!on));
  }
  applyFrame();
}

/** Where the board sits in the viewport, depending on which UI is covering it. */
function applyFrame(instant = false) {
  const wide = innerWidth >= 900;
  const shortLand = innerWidth > innerHeight && innerHeight < 520;
  const resultOn = el.result.classList.contains('is-active');
  let x = 0, y = 0, z = 1;
  if (app.screen === 'menu' || app.screen === 'lobby') {
    if (wide) x = 0.17; else if (shortLand) { x = -0.13; y = -0.05; z = 0.8; } else { y = 0.1; z = 0.76; }
  }
  if (resultOn) {
    if (shortLand) { x = -0.17; z = 0.9; } else { y = wide ? 0.08 : 0.12; z = wide ? 1 : 0.9; }
  }
  renderer.setFrame(x, y, z, instant);
}
addEventListener('resize', () => applyFrame());

function names() {
  const m = app.mode;
  if (m === 'ai') return { 1: 'You', 2: 'Computer' };
  if (m === 'online') return app.myPlayer === 1 ? { 1: 'You', 2: 'Opponent' } : { 1: 'Opponent', 2: 'You' };
  return { 1: 'Player 1', 2: 'Player 2' };
}

function setSoundUI() {
  const on = settings.sound;
  sound.enabled = on;
  el.swSound.setAttribute('aria-checked', String(on));
  el.swSound.querySelector('use').setAttribute('href', on ? '#i-sound-on' : '#i-sound-off');
  el.sound.setAttribute('aria-pressed', String(on));
  el.sound.querySelector('use').setAttribute('href', on ? '#i-sound-on' : '#i-sound-off');
}
function setSound(on) { settings.sound = on; saveSettings(); setSoundUI(); if (on) { sound.unlock(); sound.click(); } }

function setDifficultyUI() {
  $$('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.diff === settings.difficulty)));
}
function setConfirmUI() { el.swConfirm.setAttribute('aria-checked', String(settings.confirmTap)); }
function markLastMode() {
  $$('.mode').forEach((b) => b.classList.toggle('is-last', b.dataset.mode === settings.lastMode));
}

// ───────────────────────── game flow ─────────────────────────
const canAct = () => {
  const s = app.state;
  if (app.phase !== 'playing' || s.isOver || app.landing > 0 || app.thinking) return false;
  if (app.mode === 'local') return true;
  if (app.mode === 'ai') return s.current === 1;
  return s.current === app.myPlayer && !!app.room && app.room.alive && !app.peerGone;
};

function canUndo() {
  const s = app.state;
  if (app.phase !== 'playing' || s.isOver || app.landing > 0 || app.thinking || app.mode === 'online') return false;
  if (app.mode === 'ai') return s.history.some((m) => m.player === 1);
  return s.moveCount > 0;
}

/** Show/hide the ghost sphere + peg highlight according to the current aim. */
function refreshAim() {
  const s = app.state, p = app.aimPeg;
  if (p >= 0 && canAct() && s.canPlay(p)) renderer.setAim(p, s.heights[p], s.current);
  else renderer.setAim(-1);
}

function updateHud(bump = false) {
  const s = app.state, n = names();
  const p = s.isOver ? s.winner || s.current : s.current;
  el.turn.dataset.player = p;
  el.turnAvatar.dataset.p = p;
  el.turnName.textContent = s.draw ? 'Draw' : n[p];
  let sub = '';
  if (s.isOver) sub = s.winner ? 'Winner' : 'Board full';
  else if (app.mode === 'ai') sub = p === 1 ? 'Your move' : app.thinking ? 'Thinking' : 'Computer’s move';
  else if (app.mode === 'online') sub = p === app.myPlayer ? 'Your move' : 'Waiting for opponent';
  else sub = 'Drop a sphere';
  el.turnSub.textContent = sub;
  el.turn.classList.toggle('is-thinking', app.thinking);
  el.moveCount.textContent = s.moveCount;
  el.undo.setAttribute('aria-disabled', String(!canUndo()));
  if (bump && !reduceMotion) { el.turn.classList.remove('bump'); void el.turn.offsetWidth; el.turn.classList.add('bump'); }
}

function startGame(mode) {
  clearTimeout(app.resultTimer);
  app.gameId++;
  app.mode = mode;
  const first = app.games % 2 === 0 ? 1 : 2;   // alternate the opening player on rematches
  app.games++;
  app.state = new GameState(first);
  app.phase = 'playing';
  app.landing = 0;
  app.thinking = false;
  app.aimPeg = -1;
  app.peerGone = false;
  app.rematch = { me: false, them: false };
  hideResult();
  renderer.clear();
  renderer.setMode('game');
  renderer.resetView(true);
  showScreen('hud');
  el.room.hidden = mode !== 'online';
  if (mode === 'online') { el.roomText.textContent = `ROOM ${app.room.code}`; setRoomDot(true); }
  updateHud(true);
  const n = names();
  announce(`New game. ${n[first]} ${n[first] === 'You' ? 'go' : 'goes'} first.`);
  el.stage.focus({ preventScroll: true });
  if (mode === 'ai' && first === 2) aiTurn();
}

/** Apply a move to the state, animate it, and run the follow-ups. source: 'local' | 'ai' | 'remote' */
async function commitMove(peg, source) {
  const s = app.state;
  const nBefore = s.moveCount;
  const r = s.play(peg);
  if (!r.ok) return r;
  const id = app.gameId;
  if (source === 'local' && app.mode === 'online') app.room.send({ t: 'move', peg, n: nBefore });

  app.landing++;
  if (app.aimType === 'touch') app.aimPeg = -1;
  refreshAim();
  updateHud();
  const { x, z } = pegXZ(peg);
  const n = names();
  announce(`${n[r.player]} dropped a sphere on column ${x + 1}, row ${4 - z}, level ${r.level + 1}.${r.win || r.draw ? '' : ` ${n[s.current]}, your turn.`}`);

  await renderer.drop(peg, r.level, r.player);
  if (id !== app.gameId) return r;           // game was reset/left while falling
  app.landing--;
  renderer.markLast(peg, r.level, r.player);

  if (r.win || r.draw) endGame(r);
  else {
    updateHud(true);
    refreshAim();
    if (app.mode === 'ai' && s.current === 2) aiTurn();
  }
  return r;
}

async function aiTurn() {
  const id = app.gameId;
  app.thinking = true;
  refreshAim();
  updateHud();
  const t0 = performance.now();
  await wait(60);                            // let "Thinking" paint before the search blocks the thread
  if (id !== app.gameId) return;
  const peg = chooseMove(app.state, settings.difficulty);
  await wait(Math.max(0, 650 - (performance.now() - t0)));   // natural pacing
  if (id !== app.gameId) return;
  app.thinking = false;
  commitMove(peg, 'ai');
}

function slotsOf(line) {
  return line.map((c) => { const { x, y, z } = cellXYZ(c); return { peg: z * 4 + x, level: y }; });
}

function endGame(r) {
  const s = app.state, n = names();
  app.phase = 'over';
  app.thinking = false;
  refreshAim();
  updateHud();
  let title, sub, medal, accent;
  if (r.win) {
    renderer.showWin(slotsOf(s.winLine), r.player);
    sound.win();
    const me = app.mode === 'local' ? null : app.mode === 'ai' ? 1 : app.myPlayer;
    title = me === null ? `${n[r.player]} wins!` : r.player === me ? 'You win!' : `${n[r.player]} wins`;
    sub = `Four in a line after ${s.moveCount} moves.`;
    medal = `p${r.player}`;
    accent = r.player === 1 ? 'var(--p1)' : 'var(--p2)';
    announce(`${title} Four in a line after ${s.moveCount} moves.`);
  } else {
    renderer.showDraw();
    sound.draw();
    title = 'It’s a draw';
    sub = 'All 64 spots are filled and no one found the line.';
    medal = 'draw';
    accent = 'var(--ink)';
    announce('Draw. The board is full.');
  }
  app.resultTimer = setTimeout(() => showResult({ title, sub, medal, accent, rematch: true }), reduceMotion ? 150 : 1300);
}

// ───────────────────────── result overlay ─────────────────────────
function showResult({ title, sub, medal, accent, rematch }) {
  el.resultTitle.textContent = title;
  el.resultSub.textContent = sub;
  el.resultMedal.className = `result-medal ${medal}`;
  el.result.style.setProperty('--accent', accent);
  el.rematch.hidden = !rematch;
  updateRematchButton();
  el.result.classList.add('is-active');
  el.result.inert = false;
  el.result.setAttribute('aria-hidden', 'false');
  applyFrame();
  setTimeout(() => (rematch ? el.rematch : el.resultMenu).focus({ preventScroll: true }), 60);
}
function hideResult() {
  el.result.classList.remove('is-active');
  el.result.inert = true;
  el.result.setAttribute('aria-hidden', 'true');
  applyFrame();
}
function updateRematchButton() {
  const b = el.rematch, label = b.querySelector('span');
  b.disabled = false;
  if (app.mode !== 'online') { label.textContent = 'Rematch'; return; }
  if (app.peerGone) { label.textContent = 'Opponent left'; b.disabled = true; return; }
  if (app.rematch.me) { label.textContent = 'Waiting for opponent…'; b.disabled = true; }
  else if (app.rematch.them) label.textContent = 'Accept rematch';
  else label.textContent = 'Rematch';
}

// ───────────────────────── input ─────────────────────────
function handleTap(peg, type) {
  sound.unlock();
  if (app.phase !== 'playing') return;
  if (peg < 0) { app.aimPeg = -1; refreshAim(); return; }
  if (!canAct()) { if (app.mode === 'online' && !app.thinking && app.state.current !== app.myPlayer) toast('Wait for your opponent’s move'); return; }
  if (!app.state.canPlay(peg)) { sound.error(); toast('That peg is full'); announce('That peg is full.'); return; }
  const touchy = type !== 'mouse';
  app.aimType = touchy ? 'touch' : 'mouse';
  if (touchy && settings.confirmTap && app.aimPeg !== peg) {   // first tap previews, second tap drops
    app.aimPeg = peg;
    refreshAim();
    sound.click();
    const { x, z } = pegXZ(peg);
    announce(`Column ${x + 1}, row ${4 - z}. Tap again to drop.`);
    return;
  }
  app.aimPeg = peg;
  commitMove(peg, 'local');
}

/** Arrow keys move relative to the screen, whatever the camera angle. */
function moveCursor(dir) {
  const th = renderer.azimuth();
  const right = { x: Math.cos(th), z: -Math.sin(th) };
  const down = { x: Math.sin(th), z: Math.cos(th) };       // towards the viewer
  const snap = (v) => (Math.abs(v.x) >= Math.abs(v.z) ? { x: Math.sign(v.x), z: 0 } : { x: 0, z: Math.sign(v.z) });
  const vec = { right: snap(right), left: snap({ x: -right.x, z: -right.z }), down: snap(down), up: snap({ x: -down.x, z: -down.z }) }[dir];
  let { x, z } = app.aimPeg >= 0 ? pegXZ(app.aimPeg) : { x: 1, z: 1 };
  if (app.aimPeg >= 0) { x = Math.min(3, Math.max(0, x + vec.x)); z = Math.min(3, Math.max(0, z + vec.z)); }
  app.aimType = 'kbd';
  app.aimPeg = z * 4 + x;
  refreshAim();
  const h = app.state.heights[app.aimPeg];
  announce(`Column ${x + 1}, row ${4 - z}. ${h >= 4 ? 'Full' : `${h} of 4 filled`}.`);
}

addEventListener('keydown', (e) => {
  if (app.phase !== 'playing' || app.screen !== 'hud' || document.querySelector('dialog[open]')) return;
  const tag = e.target.tagName;
  const onControl = tag === 'BUTTON' || tag === 'INPUT';
  const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  if (map[e.key] && !onControl) { e.preventDefault(); moveCursor(map[e.key]); return; }
  if ((e.key === 'Enter' || e.key === ' ') && !onControl && app.aimPeg >= 0) {
    e.preventDefault();
    if (!canAct()) return;
    if (!app.state.canPlay(app.aimPeg)) { sound.error(); toast('That peg is full'); return; }
    app.aimType = 'kbd';
    commitMove(app.aimPeg, 'local');
  } else if (e.key.toLowerCase() === 'z' && !e.ctrlKey && !e.metaKey) doUndo();
  else if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) renderer.resetView(true);
});

function doUndo() {
  if (!canUndo()) { sound.error(); return; }
  const s = app.state;
  let undone = 0;
  const pop = () => { const m = s.undo(); if (m) { renderer.remove(m.peg, m.level); undone++; } return m; };
  if (app.mode === 'ai') {
    let m = pop();
    if (m && m.player === 2 && s.history.some((h) => h.player === 1)) pop();   // also take back the human move before it
  } else pop();
  const last = s.history[s.history.length - 1];
  if (last) renderer.markLast(last.peg, last.level, last.player); else renderer.markLast(-1);
  sound.undo();
  announce(`Undid ${undone} move${undone === 1 ? '' : 's'}. ${names()[s.current]}, your turn.`);
  refreshAim();
  updateHud(true);
}

// ───────────────────────── menu / navigation ─────────────────────────
function showMenu() {
  clearTimeout(app.resultTimer);
  app.gameId++;
  app.phase = 'menu';
  app.landing = 0;
  app.thinking = false;
  app.aimPeg = -1;
  app.mode = null;
  leaveRoom();
  hideResult();
  renderer.clear();
  renderer.setMode('menu');
  buildDemo();
  renderer.resetView(false);
  showScreen('menu');
  markLastMode();
  setTimeout(() => el.screens.menu.focus({ preventScroll: true }), 0);
}

/** A few pre-placed spheres so the idle menu board looks alive. */
function buildDemo() {
  const g = new GameState();
  for (const p of [5, 6, 10, 9, 5, 9, 6, 10, 5, 0, 15, 6, 12, 3, 10, 9]) {
    const r = g.play(p);
    if (!r.ok || r.win) break;
    renderer.place(r.peg, r.level, r.player);
  }
}

function requestLeave() {
  const inProgress = app.phase === 'playing' && app.state.moveCount > 0;
  if (!inProgress) return showMenu();
  el.confirmText.textContent = app.mode === 'online' ? 'Leaving will end the game for both players.' : 'Your current game will be lost.';
  el.confirm.returnValue = '';
  el.confirm.showModal();
  el.confirm.addEventListener('close', () => { if (el.confirm.returnValue === 'leave') showMenu(); }, { once: true });
}

function chooseMode(mode) {
  sound.unlock(); sound.click();
  settings.lastMode = mode;
  saveSettings();
  if (mode === 'online') return openLobby();
  startGame(mode);
}

// ───────────────────────── online play ─────────────────────────
function leaveRoom() {
  if (app.room) { app.room.close(true); app.room = null; }
}

function openLobby(prefill) {
  leaveRoom();
  app.mode = 'online';
  el.lobbyChoose.hidden = false;
  el.lobbyHost.hidden = true;
  el.lobbyJoin.hidden = true;
  setStatus(el.joinStatus, '');
  showScreen('lobby');
  if (prefill) showJoin(prefill, true);
  else setTimeout(() => $('#btn-create').focus({ preventScroll: true }), 80);
}

function setStatus(node, text, { error = false, spin = false } = {}) {
  node.classList.toggle('is-error', error);
  const t = node.querySelector('.status-text');
  if (t) t.textContent = text;
  const sp = node.querySelector('.spinner');
  if (sp) sp.hidden = !spin;
}

function wireRoom(room) {
  app.room = room;
  room.on('connected', () => {
    if (room.role === 'host') {
      app.games = 0;
      app.myPlayer = 1;
      room.send({ t: 'start', first: 1 });
      toast('Opponent joined');
      startGame('online');
    }
  });
  room.on('message', onNetMessage);
  room.on('unstable', () => { setRoomDot(false); toast('Connection unstable…'); });
  room.on('recovered', () => { setRoomDot(true); toast('Connection restored'); });
  room.on('disconnected', () => onPeerGone());
  room.on('error', () => { /* non-fatal broker errors */ });
}

function setRoomDot(ok) { $('.dot', el.room).classList.toggle('bad', !ok); }

async function createRoom() {
  sound.unlock(); sound.click();
  el.lobbyChoose.hidden = true;
  el.lobbyHost.hidden = false;
  el.roomCode.replaceChildren();
  setStatus(el.hostStatus, 'Creating room…', { spin: true });
  const room = new Room();
  wireRoom(room);
  try {
    const code = await room.host();
    if (app.room !== room) return;
    for (const ch of code) { const s = document.createElement('span'); s.textContent = ch; el.roomCode.append(s); }
    el.roomCode.setAttribute('aria-label', `Room code ${code.split('').join(' ')}`);
    setStatus(el.hostStatus, 'Waiting for your friend to join…', { spin: true });
    announce(`Room ${code.split('').join(' ')} created. Waiting for a friend.`);
  } catch (err) {
    if (app.room !== room) return;
    setStatus(el.hostStatus, err.message, { error: true });
  }
}

function inviteLink() {
  const u = new URL(location.href);
  u.search = ''; u.hash = '';
  u.searchParams.set('room', app.room.code);
  return u.toString();
}

async function copyLink() {
  const link = inviteLink();
  try { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = link; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('Invite link copied'); } catch { toast(link, 6000); }
    ta.remove();
  }
}

function showJoin(prefill = '', autoJoin = false) {
  el.lobbyChoose.hidden = true;
  el.lobbyHost.hidden = true;
  el.lobbyJoin.hidden = false;
  el.joinCode.value = normalizeCode(prefill);
  setStatus(el.joinStatus, '');
  if (autoJoin && el.joinCode.value.length === 4) joinRoom(); else setTimeout(() => el.joinCode.focus({ preventScroll: true }), 80);
}

async function joinRoom() {
  sound.unlock();
  const code = normalizeCode(el.joinCode.value);
  el.joinCode.value = code;
  if (code.length !== 4) { setStatus(el.joinStatus, 'Enter the 4-letter code.', { error: true }); sound.error(); return; }
  $('#btn-join').disabled = true;
  setStatus(el.joinStatus, 'Connecting…', { spin: true });
  const room = new Room();
  wireRoom(room);
  try {
    await room.join(code);
    if (app.room !== room) return;
    setStatus(el.joinStatus, 'Connected! Waiting for the host…', { spin: true });
  } catch (err) {
    if (app.room === room) { app.room = null; }
    room.close(false);
    setStatus(el.joinStatus, err.message, { error: true });
    sound.error();
  } finally { $('#btn-join').disabled = false; }
}

function onNetMessage(msg) {
  const room = app.room;
  switch (msg.t) {
    case 'start': // guest only
      if (room.role !== 'guest') return;
      app.games = msg.first === 1 ? 0 : 1;
      app.myPlayer = 2;
      toast('Connected to host');
      startGame('online');
      break;
    case 'move': onRemoteMove(msg); break;
    case 'rematch':
      app.rematch.them = true;
      if (app.rematch.me) startRematch(); else { updateRematchButton(); toast('Opponent wants a rematch'); }
      break;
    case 'bye': onPeerGone('left'); break;
    case 'full': room.close(false); app.room = null; setStatus(el.joinStatus, 'That room is already full.', { error: true }); break;
    default: break;
  }
}

/** Validate a move from the opponent before applying it. */
function onRemoteMove(msg) {
  const s = app.state, remote = app.myPlayer === 1 ? 2 : 1;
  const ok = app.phase === 'playing' && s.current === remote && msg.n === s.moveCount && s.canPlay(msg.peg);
  if (!ok) {
    // Out of sync or cheating: refuse and end the session cleanly.
    app.room && app.room.send({ t: 'bye' });
    app.peerGone = true;
    app.phase = 'over';
    renderer.setAim(-1);
    showResult({ title: 'Out of sync', sub: 'An invalid move was received, so the game was stopped.', medal: 'off', accent: 'var(--ink)', rematch: false });
    return;
  }
  commitMove(msg.peg, 'remote');
}

function onPeerGone() {
  if (app.mode !== 'online' || app.peerGone) return;
  app.peerGone = true;
  setRoomDot(false);
  renderer.setAim(-1);
  if (app.screen === 'lobby') {
    setStatus(el.joinStatus, 'The host left the room.', { error: true });
    return;
  }
  if (app.phase === 'playing') {
    app.phase = 'over';
    app.thinking = false;
    updateHud();
    announce('Your opponent disconnected.');
    showResult({ title: 'Opponent left', sub: 'The connection was lost, so the game ended.', medal: 'off', accent: 'var(--ink)', rematch: false });
  } else {
    updateRematchButton();
    toast('Opponent left the room');
  }
}

function requestRematch() {
  if (app.mode !== 'online') return startGame(app.mode);
  if (app.peerGone) return;
  app.rematch.me = true;
  app.room.send({ t: 'rematch' });
  if (app.rematch.them) startRematch(); else updateRematchButton();
}
function startRematch() { startGame('online'); }

// ───────────────────────── wiring ─────────────────────────
// Browsers only allow audio after a gesture.
addEventListener('pointerdown', () => sound.unlock(), { once: true, capture: true });
addEventListener('keydown', () => sound.unlock(), { once: true, capture: true });

$$('.mode').forEach((b) => b.addEventListener('click', () => chooseMode(b.dataset.mode)));
$$('.seg button').forEach((b) => b.addEventListener('click', () => {
  settings.difficulty = b.dataset.diff; saveSettings(); setDifficultyUI(); sound.unlock(); sound.click();
}));
$('#btn-howto').addEventListener('click', () => { sound.unlock(); sound.click(); el.howto.showModal(); });
el.swSound.addEventListener('click', () => setSound(!settings.sound));
el.swConfirm.addEventListener('click', () => { settings.confirmTap = !settings.confirmTap; saveSettings(); setConfirmUI(); sound.click(); });

el.undo.addEventListener('click', doUndo);
el.view.addEventListener('click', () => { sound.click(); renderer.resetView(true); });
el.sound.addEventListener('click', () => setSound(!settings.sound));
el.menuBtn.addEventListener('click', () => { sound.click(); requestLeave(); });
el.rematch.addEventListener('click', () => { sound.click(); requestRematch(); });
el.resultMenu.addEventListener('click', () => { sound.click(); showMenu(); });

// lobby
$('#lobby-back').addEventListener('click', () => {
  sound.click();
  if (!el.lobbyChoose.hidden) showMenu();
  else { leaveRoom(); openLobby(); }
});
$('#btn-create').addEventListener('click', createRoom);
$('#btn-joinview').addEventListener('click', () => { sound.click(); showJoin(); });
el.copy.addEventListener('click', copyLink);
if (navigator.share) {
  el.share.hidden = false;
  el.share.addEventListener('click', () => {
    navigator.share({ title: 'Score Four', text: `Join my Score Four room: ${app.room.code}`, url: inviteLink() }).catch(() => {});
  });
}
el.lobbyJoin.addEventListener('submit', (e) => { e.preventDefault(); joinRoom(); });
el.joinCode.addEventListener('input', () => { el.joinCode.value = normalizeCode(el.joinCode.value); });

// dialogs: click on backdrop closes
for (const dlg of [el.howto, el.confirm]) {
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

// a hidden tab shouldn't leave the AI mid-thought in a weird state: nothing to do, rAF pauses itself.

// ───────────────────────── boot ─────────────────────────
setSoundUI();
setDifficultyUI();
setConfirmUI();
markLastMode();
renderer.setMode('menu');
buildDemo();
showScreen('menu');
applyFrame(true);
el.result.inert = true;

const params = new URLSearchParams(location.search);
if (params.has('debug')) window.__score4 = { app, renderer, settings, DIFFICULTIES, commitMove };   // handle for automated tests

const roomParam = normalizeCode(params.get('room') || '');
if (roomParam.length === 4) {
  settings.lastMode = 'online';
  params.delete('room');
  history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : ''));
  openLobby(roomParam);
}
