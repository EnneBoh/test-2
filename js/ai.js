/**
 * AI — negamax with alpha-beta pruning.
 * Heuristic: count "open" lines (lines that contain only one player's spheres),
 * weighted by how many spheres they already hold.
 */
import { LINES } from './gamestate.js';

const WIN = 1e6;
// weight by number of own spheres in an otherwise-open line (index = count)
const WEIGHTS = [0, 1, 7, 55];

export const DIFFICULTIES = {
  easy: { depth: 2, randomness: 0.4, label: 'Easy' },
  medium: { depth: 3, randomness: 0.08, label: 'Medium' },
  hard: { depth: 4, randomness: 0, label: 'Hard' },
};

// Centre pegs take part in more lines: try them first for better pruning.
const MOVE_ORDER = [5, 6, 9, 10, 0, 3, 12, 15, 1, 2, 4, 7, 8, 11, 13, 14];

/** Static evaluation from the point of view of `me`. */
function evaluate(state, me) {
  const b = state.board;
  let score = 0;
  for (let i = 0; i < LINES.length; i++) {
    const l = LINES[i];
    let mine = 0, theirs = 0;
    for (let k = 0; k < 4; k++) {
      const v = b[l[k]];
      if (v === 0) continue;
      if (v === me) mine++; else theirs++;
    }
    if (mine && theirs) continue; // dead line
    if (mine) score += WEIGHTS[mine];
    else if (theirs) score -= WEIGHTS[theirs];
  }
  return score;
}

function orderedMoves(state) {
  const out = [];
  for (const p of MOVE_ORDER) if (state.heights[p] < 4) out.push(p);
  return out;
}

/** Negamax: score from the perspective of the player to move in `state`. */
function negamax(state, depth, alpha, beta) {
  // The previous mover just won → the side to move has lost.
  if (state.winner) return -(WIN + depth);
  if (state.draw) return 0;
  if (depth === 0) return evaluate(state, state.current);

  let best = -Infinity;
  for (const p of orderedMoves(state)) {
    state.play(p);
    const v = -negamax(state, depth - 1, -beta, -alpha);
    state.undo();
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

/**
 * Choose a peg for `state.current`. The state is mutated during the search but
 * always restored. Returns a peg index (0..15), or -1 if there is no move.
 */
export function chooseMove(state, difficulty = 'medium') {
  const cfg = DIFFICULTIES[difficulty] || DIFFICULTIES.medium;
  const moves = orderedMoves(state);
  if (!moves.length) return -1;

  // Always take an immediate win.
  for (const p of moves) {
    const r = state.play(p);
    state.undo();
    if (r.win) return p;
  }

  // Lower difficulties sometimes play a random move.
  if (cfg.randomness && Math.random() < cfg.randomness) {
    return moves[(Math.random() * moves.length) | 0];
  }

  let bestScore = -Infinity;
  let best = [];
  for (const p of moves) {
    state.play(p);
    // window slightly wider than the best so far, so equal moves are not pruned
    // and we can choose randomly among them.
    const v = -negamax(state, cfg.depth - 1, -Infinity, -bestScore + 1);
    state.undo();
    if (v > bestScore) { bestScore = v; best = [p]; }
    else if (v === bestScore) best.push(p);
  }
  return best[(Math.random() * best.length) | 0];
}
