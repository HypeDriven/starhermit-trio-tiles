/**
 * Depth-first solvability solver with memoization and a node budget.
 *
 * Used by:
 *   - the content validator (prove every shipped/generated layout is solvable)
 *   - the hint system (suggest the first move of a winning line)
 *   - fuzz/property tests
 *
 * Tray order does not affect future legality — only per-symbol counts (0..2)
 * and total occupancy — so the memo key is (remaining-id set, symbol counts).
 */

import { computeExposure, TRIPLE_SIZE } from './engine.js';

export const SOLVER_BUDGET = 200_000;

/**
 * @param {object} state  engine state (not mutated)
 * @param {object} [opts] { budget, wantPath }
 * @returns {{solvable:boolean, exhausted:boolean, path?:string[], nodes:number, depth:number}}
 */
export function solve(state, opts = {}) {
  const budget = opts.budget ?? SOLVER_BUDGET;
  const wantPath = opts.wantPath ?? false;
  let nodes = 0;
  let exhausted = false;

  const remaining = new Set(state.tiles.map((t) => t.id));
  const tileById = new Map(state.tiles.map((t) => [t.id, t]));

  // Blocker sets: tile -> tiles above it that must leave first.
  const blockers = new Map();
  {
    const exp = computeExposure(state);
    for (const [id, list] of exp.blockers) blockers.set(id, new Set(list));
    for (const id of exp.exposed) blockers.set(id, new Set());
  }

  const counts = new Map(); // sym -> 0|1|2 in tray
  let traySize = 0;
  for (const e of state.tray) {
    counts.set(e.sym, (counts.get(e.sym) ?? 0) + 1);
    traySize++;
  }

  const capacity = state.trayCapacity;
  const memo = new Map(); // key -> false (only dead ends are cached)

  function key() {
    const ids = [...remaining].sort().join('.');
    const cs = [...counts.entries()].sort().map(([s, c]) => s + c).join(',');
    return ids + '|' + cs;
  }

  function dfs(path) {
    if (remaining.size === 0) return true;
    if (++nodes > budget) {
      exhausted = true;
      return false;
    }
    const k = key();
    if (memo.has(k)) return false;

    // Exposed = remaining tiles whose blockers are all gone.
    const exposedNow = [];
    for (const id of remaining) {
      let free = true;
      for (const b of blockers.get(id)) {
        if (remaining.has(b)) {
          free = false;
          break;
        }
      }
      if (free) exposedNow.push(id);
    }

    // Order candidates: prefer symbols already in the tray (forced clears),
    // then symbols with the most copies currently exposed.
    const exposedSymCount = new Map();
    for (const id of exposedNow) {
      const s = tileById.get(id).sym;
      exposedSymCount.set(s, (exposedSymCount.get(s) ?? 0) + 1);
    }
    exposedNow.sort((a, b) => {
      const sa = tileById.get(a).sym;
      const sb = tileById.get(b).sym;
      const ca = counts.get(sa) ?? 0;
      const cb = counts.get(sb) ?? 0;
      if (cb !== ca) return cb - ca;
      const ea = exposedSymCount.get(sa);
      const eb = exposedSymCount.get(sb);
      if (eb !== ea) return eb - ea;
      return a < b ? -1 : 1;
    });

    for (const id of exposedNow) {
      const sym = tileById.get(id).sym;
      const prev = counts.get(sym) ?? 0;
      remaining.delete(id);
      let cleared = false;
      if (prev + 1 >= TRIPLE_SIZE) {
        counts.delete(sym);
        traySize -= TRIPLE_SIZE - 1;
        cleared = true;
      } else {
        counts.set(sym, prev + 1);
        traySize += 1;
      }
      if (traySize < capacity || cleared) {
        if (dfs(path)) {
          if (wantPath) path.unshift(id);
          return true;
        }
      }
      // undo
      if (cleared) {
        counts.set(sym, TRIPLE_SIZE - 1);
        traySize += TRIPLE_SIZE - 1;
      } else {
        if (prev === 0) counts.delete(sym);
        else counts.set(sym, prev);
        traySize -= 1;
      }
      remaining.add(id);
      if (exhausted) return false;
    }

    memo.set(k, false);
    return false;
  }

  const path = wantPath ? [] : null;
  const solvable = dfs(path);
  return { solvable, exhausted, path: wantPath ? path : undefined, nodes, depth: Math.ceil(state.tiles.length / TRIPLE_SIZE) };
}

/**
 * Suggest a move for the hint system. Solver-first; falls back to heuristics
 * when the budget is exhausted or the position is already unsolvable (the
 * heuristic still picks a "reasonable" legal tile, never an illegal one).
 * @returns {string|null} tile id, or null when no legal move exists
 */
export function suggestMove(state) {
  const { exposed } = computeExposure(state);
  if (exposed.length === 0) return null;

  const result = solve(state, { wantPath: true, budget: 60_000 });
  if (result.solvable && result.path.length > 0) return result.path[0];

  // Heuristic fallback: complete a pair in the tray, then match a single in
  // the tray, then the symbol with the most exposed copies.
  const tileById = new Map(state.tiles.map((t) => [t.id, t]));
  const trayCounts = new Map();
  for (const e of state.tray) trayCounts.set(e.sym, (trayCounts.get(e.sym) ?? 0) + 1);
  let best = null;
  let bestScore = -1;
  const exposedSymCount = new Map();
  for (const id of exposed) {
    const s = tileById.get(id).sym;
    exposedSymCount.set(s, (exposedSymCount.get(s) ?? 0) + 1);
  }
  for (const id of exposed) {
    const s = tileById.get(id).sym;
    const inTray = trayCounts.get(s) ?? 0;
    const score = inTray * 100 + (exposedSymCount.get(s) ?? 0);
    if (score > bestScore || (score === bestScore && id < best)) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}
