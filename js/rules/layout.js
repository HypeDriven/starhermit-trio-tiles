/**
 * Layout generation — original shape templates plus a seeded, solver-verified
 * generator. Every layout is guaranteed solvable by construction and then
 * proven so by the solver (the offline validator re-proves it).
 *
 * A layout is a list of tiles: { id, sym, gx, gy, z } in half-grid units.
 * Generation pipeline (all from the 'rules' random stream):
 *   1. Build positions from a shape template, filled bottom layer first.
 *   2. Compute a random valid peel order of the shape.
 *   3. Assign symbol triples along that order (a trivial winning line).
 *   4. Scramble assignments inside difficulty-sized windows.
 *   5. Prove solvability with the real solver; re-roll deterministically if not.
 */

import { rulesStream } from './rng.js';
import { createGame } from './engine.js';
import { solve } from './solver.js';

export const SYMBOLS = Object.freeze([
  { id: 'leaf', name: 'Tea Leaf' },
  { id: 'drop', name: 'Rain Drop' },
  { id: 'moon', name: 'Moon' },
  { id: 'sun', name: 'Sun' },
  { id: 'bloom', name: 'Plum Blossom' },
  { id: 'peak', name: 'Mountain' },
  { id: 'wave', name: 'Wave' },
  { id: 'fan', name: 'Paper Fan' },
  { id: 'stone', name: 'Garden Stone' },
  { id: 'crane', name: 'Crane' },
  { id: 'koi', name: 'Koi' },
  { id: 'lantern', name: 'Lantern' },
]);

export const SYMBOL_NAMES = Object.freeze(Object.fromEntries(SYMBOLS.map((s) => [s.id, s.name])));

export const SHAPES = Object.freeze(['terrace', 'pagoda', 'garden', 'bridge', 'ring', 'spiral']);

// ---------------------------------------------------------------------------
// Shape templates
// ---------------------------------------------------------------------------

function rectPositions(cols, rows, ox, oy, z, order = 'row') {
  const list = [];
  if (order === 'spiral') {
    let x0 = 0;
    let x1 = cols - 1;
    let y0 = 0;
    let y1 = rows - 1;
    while (x0 <= x1 && y0 <= y1) {
      for (let x = x0; x <= x1; x++) list.push({ gx: ox + x * 2, gy: oy + y0 * 2, z });
      for (let y = y0 + 1; y <= y1; y++) list.push({ gx: ox + x1 * 2, gy: oy + y * 2, z });
      if (y1 > y0) for (let x = x1 - 1; x >= x0; x--) list.push({ gx: ox + x * 2, gy: oy + y1 * 2, z });
      if (x1 > x0) for (let y = y1 - 1; y > y0; y--) list.push({ gx: ox + x0 * 2, gy: oy + y * 2, z });
      x0++;
      x1--;
      y0++;
      y1--;
    }
  } else {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) list.push({ gx: ox + x * 2, gy: oy + y * 2, z });
    }
  }
  return list;
}

function plusPositions(c, r, z) {
  // Horizontal and vertical bars crossing at the center, in half-units.
  const list = [];
  const seen = new Set();
  const push = (gx, gy) => {
    const k = gx + ',' + gy;
    if (!seen.has(k)) {
      seen.add(k);
      list.push({ gx, gy, z });
    }
  };
  const cy = Math.floor(r / 2);
  const cx = Math.floor(c / 2);
  for (let x = 0; x < c; x++) push(x * 2, cy * 2);
  for (let y = 0; y < r; y++) push(cx * 2, y * 2);
  if (c > 2 && r > 2) {
    for (let x = 1; x < c - 1; x++) {
      push(x * 2, (cy - 1) * 2);
      push(x * 2, (cy + 1) * 2);
    }
  }
  return list;
}

function ringPositions(c, r, ox, oy, z) {
  const list = [];
  for (let x = 0; x < c; x++) {
    list.push({ gx: ox + x * 2, gy: oy, z });
    if (r > 1) list.push({ gx: ox + x * 2, gy: oy + (r - 1) * 2, z });
  }
  for (let y = 1; y < r - 1; y++) {
    list.push({ gx: ox, gy: oy + y * 2, z });
    if (c > 1) list.push({ gx: ox + (c - 1) * 2, gy: oy + y * 2, z });
  }
  return list;
}

/**
 * Positions for a shape, ordered fill-first (lower layers, template order),
 * length ≥ count. Slicing to count is done by the caller.
 */
export function shapePositions(shape, count, maxLayers = 3) {
  const base = Math.max(3, Math.ceil(Math.sqrt(count)) + 1);
  for (let size = base; size <= base + 6; size++) {
    const out = buildShape(shape, size, maxLayers);
    if (out.length >= count) return out;
  }
  // Deterministic last resort: a plain wide terrace always fits.
  const cols = Math.ceil(count / 3);
  return rectPositions(cols, 3, 0, 0, 0);
}

function buildShape(shape, size, maxLayers) {
  const out = [];
  switch (shape) {
    case 'terrace': {
      for (let z = 0; z < maxLayers; z++) {
        const cols = size - Math.floor(z / 2);
        const rows = size - z;
        if (cols < 2 || rows < 2) break;
        out.push(...rectPositions(cols, rows, z, z, z));
      }
      break;
    }
    case 'pagoda': {
      for (let z = 0; z < maxLayers; z++) {
        const cols = size - z;
        const rows = size - z;
        if (cols < 1 || rows < 1) break;
        out.push(...rectPositions(cols, rows, z, z, z));
      }
      break;
    }
    case 'garden': {
      let c = size;
      let r = size;
      for (let z = 0; z < maxLayers; z++) {
        if (c < 3 || r < 3) break;
        const layer = plusPositions(c, r, z).map((p) => ({ gx: p.gx + z, gy: p.gy + z, z }));
        out.push(...layer);
        c -= 2;
        r -= 2;
      }
      break;
    }
    case 'bridge': {
      const half = Math.max(3, Math.floor(size / 2));
      const gap = 2;
      out.push(...rectPositions(half, half, 0, 0, 0));
      const rightX = (half + gap) * 2;
      out.push(...rectPositions(half, half, rightX, 0, 0));
      const cy = Math.floor(half / 2) * 2;
      for (let x = half; x < half + gap; x++) out.push({ gx: x * 2, gy: cy, z: 0 });
      for (let z = 1; z < maxLayers; z++) {
        const inner = half - z;
        if (inner < 2) break;
        out.push(...rectPositions(inner, inner, z, z, z));
        out.push(...rectPositions(inner, inner, rightX + z, z, z));
        if (z === 1) out.push({ gx: (half + 1) * 2 - 2, gy: cy, z });
      }
      break;
    }
    case 'ring': {
      let c = size;
      let r = size;
      for (let z = 0; z < maxLayers; z++) {
        if (c < 3 || r < 3) break;
        out.push(...ringPositions(c, r, z, z, z));
        c -= 2;
        r -= 2;
      }
      break;
    }
    case 'spiral': {
      for (let z = 0; z < maxLayers; z++) {
        const cols = size - z;
        const rows = size - z;
        if (cols < 2 || rows < 2) break;
        out.push(...rectPositions(cols, rows, z, z, z, 'spiral'));
      }
      break;
    }
    default:
      return buildShape('terrace', size, maxLayers);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Peel order + symbol assignment
// ---------------------------------------------------------------------------

function peelOrder(positions, rand) {
  const remaining = new Set(positions.map((_, i) => i));
  const order = [];
  while (remaining.size > 0) {
    const exposed = [];
    for (const i of remaining) {
      const p = positions[i];
      let free = true;
      for (const j of remaining) {
        if (j === i) continue;
        const q = positions[j];
        if (q.z > p.z && Math.abs(q.gx - p.gx) < 2 && Math.abs(q.gy - p.gy) < 2) {
          free = false;
          break;
        }
      }
      if (free) exposed.push(i);
    }
    const pick = exposed[Math.floor(rand.next() * exposed.length)];
    remaining.delete(pick);
    order.push(pick);
  }
  return order;
}

function chooseSymbols(kinds, rand) {
  const pool = SYMBOLS.map((s) => s.id);
  rand.shuffle(pool);
  return pool.slice(0, Math.max(1, Math.min(kinds, pool.length)));
}

function scrambleAssign(assign, windowSize, rand) {
  const W = Math.max(3, windowSize);
  for (let start = 0; start < assign.length; start += W) {
    const end = Math.min(assign.length, start + W);
    for (let i = end - 1; i > start; i--) {
      const j = start + Math.floor(rand.next() * (i - start + 1));
      const t = assign[i];
      assign[i] = assign[j];
      assign[j] = t;
    }
  }
}

// ---------------------------------------------------------------------------
// Public generator
// ---------------------------------------------------------------------------

/**
 * Generate a solver-verified layout.
 * @param {object} cfg
 * @param {string|number} cfg.seed
 * @param {number} cfg.triples       number of symbol triples (tiles = ×3)
 * @param {number} cfg.symbolKinds   distinct symbols in play
 * @param {string} cfg.shape         one of SHAPES
 * @param {number} [cfg.maxLayers]
 * @param {number} [cfg.scramble]    interleave window (3 = trivially grouped)
 * @param {number} [cfg.trayCapacity]
 * @returns {{tiles:Array, symbolIds:string[], attempts:number, solverNodes:number}}
 */
export function generateLayout(cfg) {
  const N = cfg.triples * 3;
  const maxAttempts = 48;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rand = rulesStream(`${cfg.seed}:layout:${attempt}`);
    const positions = shapePositions(cfg.shape, N, cfg.maxLayers ?? 3).slice(0, N);
    const order = peelOrder(positions, rand);
    const stepOf = new Array(N);
    order.forEach((posIdx, step) => {
      stepOf[posIdx] = step;
    });

    const symbolIds = chooseSymbols(cfg.symbolKinds, rand);
    const tripleSyms = [];
    for (let i = 0; i < cfg.triples; i++) tripleSyms.push(symbolIds[i % symbolIds.length]);
    rand.shuffle(tripleSyms);
    const assign = new Array(N);
    for (let t = 0; t < cfg.triples; t++) {
      for (let k = 0; k < 3; k++) assign[3 * t + k] = tripleSyms[t];
    }
    scrambleAssign(assign, cfg.scramble ?? 6, rand);

    const tiles = positions.map((p, i) => ({
      id: 't' + i,
      sym: assign[stepOf[i]],
      gx: p.gx,
      gy: p.gy,
      z: p.z,
    }));

    const probe = createGame({
      tiles,
      seed: cfg.seed,
      meta: {},
      trayCapacity: cfg.trayCapacity,
    });
    const res = solve(probe, { budget: 120_000 });
    if (res.solvable && !res.exhausted) {
      return { tiles, symbolIds, attempts: attempt + 1, solverNodes: res.nodes };
    }
  }
  throw new Error(`layout: no solvable layout for seed ${cfg.seed} (${cfg.shape}/${cfg.triples})`);
}

// ---------------------------------------------------------------------------
// Structural validation (offline content gate; also run at load time)
// ---------------------------------------------------------------------------

/**
 * Validate a finished level definition. Returns { ok, issues[], metrics }.
 * Metrics feed difficulty display and are recorded with the content.
 */
export function validateLevel(level, { solverBudget = 150_000 } = {}) {
  const issues = [];
  const tiles = level.tiles ?? [];
  const ids = new Set();
  const symCount = new Map();
  let maxZ = 0;
  for (const t of tiles) {
    if (!t.id || ids.has(t.id)) issues.push(`duplicate or missing tile id ${t.id}`);
    ids.add(t.id);
    if (!Number.isInteger(t.gx) || !Number.isInteger(t.gy) || !Number.isInteger(t.z)) {
      issues.push(`tile ${t.id} has non-integer coordinates`);
    }
    if (t.z < 0) issues.push(`tile ${t.id} below layer zero`);
    if (Math.abs(t.gx) > 64 || Math.abs(t.gy) > 64) issues.push(`tile ${t.id} out of bounds`);
    symCount.set(t.sym, (symCount.get(t.sym) ?? 0) + 1);
    maxZ = Math.max(maxZ, t.z);
  }
  if (tiles.length === 0) issues.push('layout is empty');
  if (tiles.length % 3 !== 0) issues.push('tile count is not a multiple of three');
  for (const [sym, n] of symCount) {
    if (n % 3 !== 0) issues.push(`symbol ${sym} appears ${n} times (not a multiple of three)`);
  }
  if (!SYMBOL_NAMES[tiles[0]?.sym] && tiles.length > 0) {
    if ([...symCount.keys()].some((s) => !SYMBOL_NAMES[s])) issues.push('unknown symbol id in layout');
  }

  let metrics = {
    tiles: tiles.length,
    triples: Math.floor(tiles.length / 3),
    layers: maxZ + 1,
    symbolKinds: symCount.size,
    solverNodes: 0,
    solvable: false,
    parSeconds: Math.ceil(tiles.length * 1.1),
  };

  if (issues.length === 0) {
    const probe = createGame({
      tiles,
      seed: level.seed ?? 'validate',
      meta: {},
      trayCapacity: level.config?.trayCapacity,
    });
    const res = solve(probe, { budget: solverBudget });
    metrics.solvable = res.solvable;
    metrics.solverNodes = res.nodes;
    if (!res.solvable) issues.push(res.exhausted ? 'solver budget exhausted (cannot prove solvable)' : 'layout is not solvable');
    // Bounded duration: a round is exactly `tiles` selects plus overhead.
    metrics.parSeconds = Math.max(30, Math.ceil(tiles.length * 1.1));
  }

  return { ok: issues.length === 0, issues, metrics };
}

/**
 * Difficulty rating 1–5 measured from solution depth, branching, hidden
 * information (layers), symbol spread, and capacity pressure — not raw size.
 */
export function difficultyRating(metrics) {
  const depthScore = metrics.triples / 6; // more triples = deeper solutions
  const branchScore = Math.min(2, metrics.solverNodes / 4000);
  const layerScore = (metrics.layers - 1) * 0.8;
  const spreadScore = metrics.symbolKinds / 6;
  const raw = depthScore * 0.5 + branchScore + layerScore + spreadScore;
  return Math.max(1, Math.min(5, Math.round(raw)));
}
