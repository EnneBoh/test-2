/**
 * GameState — pure game logic for Score Four (3D Connect Four).
 * No DOM, no Three.js: can run in Node, a Worker, or the AI.
 *
 * Coordinates: x, z ∈ 0..3 pick the peg, y ∈ 0..3 is the height (0 = bottom).
 * Cell index  = y*16 + z*4 + x        (0..63)
 * Peg index   = z*4 + x               (0..15)
 */
export const SIZE = 4;
export const PEGS = SIZE * SIZE;
export const CELLS = SIZE * SIZE * SIZE;

export const cellIndex = (x, y, z) => y * 16 + z * 4 + x;
export const pegIndex = (x, z) => z * 4 + x;
export const pegXZ = (peg) => ({ x: peg % 4, z: (peg / 4) | 0 });
export const cellXYZ = (cell) => ({ x: cell % 4, y: (cell / 16) | 0, z: ((cell / 4) | 0) % 4 });

/** Build all 76 winning lines as arrays of 4 cell indices. */
function buildLines() {
  const dirs = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dy && !dz) continue;
        // keep one direction of each opposite pair
        const first = dx !== 0 ? dx : dy !== 0 ? dy : dz;
        if (first > 0) dirs.push([dx, dy, dz]);
      }
  const lines = [];
  const inside = (v) => v >= 0 && v < SIZE;
  for (const [dx, dy, dz] of dirs)
    for (let x = 0; x < SIZE; x++)
      for (let y = 0; y < SIZE; y++)
        for (let z = 0; z < SIZE; z++) {
          const ex = x + 3 * dx, ey = y + 3 * dy, ez = z + 3 * dz;
          if (!inside(ex) || !inside(ey) || !inside(ez)) continue;
          lines.push([0, 1, 2, 3].map((k) => cellIndex(x + k * dx, y + k * dy, z + k * dz)));
        }
  return lines;
}

/** The 76 winning lines, computed once. */
export const LINES = buildLines();

/** For every cell, the lines passing through it (fast post-move win check). */
export const LINES_BY_CELL = (() => {
  const m = Array.from({ length: CELLS }, () => []);
  LINES.forEach((line) => line.forEach((c) => m[c].push(line)));
  return m;
})();

export class GameState {
  /** @param {1|2} first player who moves first */
  constructor(first = 1) {
    this.reset(first);
  }

  reset(first = this.first || 1) {
    this.first = first;
    this.board = new Uint8Array(CELLS); // 0 empty, 1, 2
    this.heights = new Uint8Array(PEGS);
    this.history = []; // {peg, level, player}
    this.current = first;
    this.winner = 0;
    this.winLine = null; // array of 4 cell indices
    this.draw = false;
  }

  get moveCount() { return this.history.length; }
  get isOver() { return this.winner !== 0 || this.draw; }

  canPlay(peg) {
    return !this.isOver && Number.isInteger(peg) && peg >= 0 && peg < PEGS && this.heights[peg] < SIZE;
  }

  legalMoves() {
    const out = [];
    if (this.isOver) return out;
    for (let p = 0; p < PEGS; p++) if (this.heights[p] < SIZE) out.push(p);
    return out;
  }

  /**
   * Drop a sphere for the current player on `peg`.
   * @returns {{ok:false, reason:string} | {ok:true, peg, level, player, cell, win:boolean, draw:boolean, line:number[]|null}}
   */
  play(peg) {
    if (this.isOver) return { ok: false, reason: 'game-over' };
    if (!Number.isInteger(peg) || peg < 0 || peg >= PEGS) return { ok: false, reason: 'bad-peg' };
    if (this.heights[peg] >= SIZE) return { ok: false, reason: 'peg-full' };

    const { x, z } = pegXZ(peg);
    const level = this.heights[peg];
    const cell = cellIndex(x, level, z);
    const player = this.current;

    this.board[cell] = player;
    this.heights[peg] = level + 1;
    this.history.push({ peg, level, player });

    const line = this._findWin(cell, player);
    if (line) {
      this.winner = player;
      this.winLine = line;
    } else if (this.history.length === CELLS) {
      this.draw = true;
    } else {
      this.current = player === 1 ? 2 : 1;
    }
    return { ok: true, peg, level, player, cell, win: !!line, draw: this.draw, line };
  }

  /** Undo the last move. Returns it, or null when there is nothing to undo. */
  undo() {
    const m = this.history.pop();
    if (!m) return null;
    const { x, z } = pegXZ(m.peg);
    this.board[cellIndex(x, m.level, z)] = 0;
    this.heights[m.peg] = m.level;
    this.winner = 0;
    this.winLine = null;
    this.draw = false;
    this.current = m.player;
    return m;
  }

  /** Cell → winning line through it for `player` (or null). */
  _findWin(cell, player) {
    for (const line of LINES_BY_CELL[cell]) {
      if (this.board[line[0]] === player && this.board[line[1]] === player &&
          this.board[line[2]] === player && this.board[line[3]] === player) return line;
    }
    return null;
  }

  clone() {
    const c = new GameState(this.first);
    c.board.set(this.board);
    c.heights.set(this.heights);
    c.history = this.history.map((m) => ({ ...m }));
    c.current = this.current;
    c.winner = this.winner;
    c.winLine = this.winLine;
    c.draw = this.draw;
    return c;
  }

  /** Compact, replayable representation (used for sync / debugging). */
  serialize() {
    return { first: this.first, moves: this.history.map((m) => m.peg) };
  }

  static from({ first, moves }) {
    const s = new GameState(first);
    for (const p of moves) if (!s.play(p).ok) throw new Error('Invalid move list');
    return s;
  }
}
