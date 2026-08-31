/**
 * Trio Tiles rules engine — pure, deterministic, renderer-independent.
 *
 * Rules contract (spec §2):
 *   Move exposed tiles into a seven-slot tray; three identical symbols clear.
 *   Win by clearing the layout; lose when every tray slot is occupied without
 *   an immediate triple (or when a challenge limit expires, or by resigning).
 *
 * The engine exposes:
 *   - legal-action queries        (legalActions, validateCommand)
 *   - deterministic resolution    (applyCommand — same state+command ⇒ same result)
 *   - serializable state          (serializeState / deserializeState + migration)
 *   - monotonic turn/tick number  (state.turn increments on every applied command,
 *                                  including counted invalid attempts and undo)
 *   - terminal-state reason       (state.terminalReason ∈ TERMINAL_REASONS)
 *
 * Tutorial and hint systems call these same APIs; nothing here knows about
 * rendering, audio, DOM, or the network.
 *
 * Coordinates: tiles occupy a 2×2 footprint in half-grid units, so tiles on
 * higher layers may be offset by half a tile. A tile is blocked when any
 * higher-layer tile overlaps its footprint. The tray stores {id, sym} entries
 * so a serialized state is fully self-contained.
 */

import { hashValue } from './rng.js';

export const RULES_VERSION = 1;
export const DEFAULT_TRAY_CAPACITY = 7;
export const TRIPLE_SIZE = 3;
export const STEP_MS = 50; // simulation tick quantum (integer time units)

export const TERMINAL_REASONS = Object.freeze([
  'cleared', // won — layout empty
  'tray_full', // lost — tray full with no triple
  'move_limit', // lost — challenge move budget exhausted
  'time_limit', // lost — challenge clock expired
  'resigned', // lost — player left the round
]);

export const SCORING = Object.freeze({
  TRIPLE_BASE: 100,
  COMBO_STEP: 25, // per chain level beyond the first
  COMBO_WINDOW_TURNS: 6, // triples within this many turns extend the chain
  SLOT_BONUS: 30, // per empty tray slot on win
  TIME_BONUS_PER_SEC: 2, // per second under par on win
});

export const INVALID_REASONS = Object.freeze({
  not_active: 'The round is already over.',
  malformed: 'That action could not be understood.',
  tile_not_found: 'That tile is no longer on the table.',
  tile_blocked: 'That tile is covered by another tile.',
  limit_exceeded: 'A challenge limit has already ended this round.',
  undo_disabled: 'Undo is not available in this mode.',
  undo_empty: 'There is nothing to undo yet.',
  hint_disabled: 'Hints are not available in this mode.',
});

// ---------------------------------------------------------------------------
// State construction
// ---------------------------------------------------------------------------

/**
 * Create the initial game state.
 * @param {object} args
 * @param {Array}  args.tiles   layout tiles: [{id, sym, gx, gy, z}]
 * @param {string|number} args.seed  content seed (recorded, not rolled here)
 * @param {object} args.meta    {contentId, rulesetId, difficulty, theme}
 * @param {object} [args.limits]  {moveLimit, timeLimitMs}
 * @param {object} [args.assists] {undo, hint, timingAssist}
 * @param {number} [args.trayCapacity]
 * @param {number} [args.parMs]   par time used for the time-bonus component
 */
export function createGame(args) {
  const tiles = args.tiles.map((t) => ({
    id: t.id,
    sym: t.sym,
    gx: t.gx,
    gy: t.gy,
    z: t.z,
  }));
  return {
    version: RULES_VERSION,
    seed: String(args.seed),
    contentId: args.meta?.contentId ?? 'unknown',
    rulesetId: args.meta?.rulesetId ?? 'standard',
    difficulty: args.meta?.difficulty ?? 1,
    theme: args.meta?.theme ?? 'dawn',
    tiles,
    tray: [],
    trayCapacity: args.trayCapacity ?? DEFAULT_TRAY_CAPACITY,
    turn: 0,
    moves: 0,
    invalidCount: 0,
    hintsUsed: 0,
    undosUsed: 0,
    elapsedMs: 0,
    status: 'active',
    terminalReason: null,
    comboChain: 0,
    lastTripleTurn: -1,
    score: { triples: 0, base: 0, comboBonus: 0, slotBonus: 0, timeBonus: 0, total: 0 },
    limits: {
      moveLimit: args.limits?.moveLimit ?? null,
      timeLimitMs: args.limits?.timeLimitMs ?? null,
    },
    parMs: args.parMs ?? null,
    assists: {
      undo: args.assists?.undo ?? false,
      hint: args.assists?.hint ?? true,
      timingAssist: args.assists?.timingAssist ?? false,
    },
    stats: { triplesCleared: 0, tilesCleared: 0 },
  };
}

// ---------------------------------------------------------------------------
// Legality queries
// ---------------------------------------------------------------------------

function overlaps(a, b) {
  return Math.abs(a.gx - b.gx) < 2 && Math.abs(a.gy - b.gy) < 2;
}

/**
 * Compute exposure for every remaining tile.
 * Returns { exposed: [ids sorted], blockers: Map<id, [blocking ids sorted]> }.
 */
export function computeExposure(state) {
  const tiles = state.tiles;
  const exposed = [];
  const blockers = new Map();
  for (const t of tiles) {
    const list = [];
    for (const o of tiles) {
      if (o !== t && o.z > t.z && overlaps(o, t)) list.push(o.id);
    }
    if (list.length === 0) exposed.push(t.id);
    else blockers.set(t.id, list.sort());
  }
  exposed.sort();
  return { exposed, blockers };
}

export function isExposed(state, tileId) {
  const t = state.tiles.find((x) => x.id === tileId);
  if (!t) return false;
  for (const o of state.tiles) {
    if (o !== t && o.z > t.z && overlaps(o, t)) return false;
  }
  return true;
}

/**
 * The complete legal-action surface for the current state.
 * Tutorials, hints, and input routing all read from here.
 */
export function legalActions(state) {
  if (state.status !== 'active') {
    return { status: state.status, selectable: [], canUndo: false, canHint: false, canResign: false };
  }
  const { exposed } = computeExposure(state);
  return {
    status: 'active',
    selectable: exposed,
    canUndo: state.assists.undo && state.moves > 0,
    canHint: state.assists.hint && state.tiles.length > 0,
    canResign: true,
  };
}

/** Command validation. Returns {ok:true} or {ok:false, reason, message}. */
export function validateCommand(state, cmd) {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
    return fail('malformed');
  }
  switch (cmd.type) {
    case 'select': {
      if (state.status !== 'active') return fail('not_active');
      if (typeof cmd.tileId !== 'string') return fail('malformed');
      const t = state.tiles.find((x) => x.id === cmd.tileId);
      if (!t) return fail('tile_not_found');
      if (!isExposed(state, cmd.tileId)) return fail('tile_blocked');
      return { ok: true };
    }
    case 'undo': {
      if (state.status !== 'active') return fail('not_active');
      if (!state.assists.undo) return fail('undo_disabled');
      if (state.moves <= 0) return fail('undo_empty');
      return { ok: true };
    }
    case 'hint': {
      if (state.status !== 'active') return fail('not_active');
      if (!state.assists.hint) return fail('hint_disabled');
      return { ok: true };
    }
    case 'tick': {
      if (state.status !== 'active') return fail('not_active');
      if (!Number.isFinite(cmd.dt) || cmd.dt <= 0 || cmd.dt > 60 * 60 * 1000) return fail('malformed');
      return { ok: true };
    }
    case 'resign': {
      if (state.status !== 'active') return fail('not_active');
      return { ok: true };
    }
    default:
      return fail('malformed');
  }
}

function fail(reason) {
  return { ok: false, reason, message: INVALID_REASONS[reason] ?? 'Action not allowed.' };
}

// ---------------------------------------------------------------------------
// Deterministic resolution
// ---------------------------------------------------------------------------

function cloneState(state) {
  return structuredClone(state);
}

function recomputeTotal(score) {
  score.total = score.base + score.comboBonus + score.slotBonus + score.timeBonus;
}

/**
 * Where would a tile land in the tray, and would it clear a triple?
 * Pure preview used by the UI for target preview before commit.
 */
export function projectSelect(state, tileId) {
  const t = state.tiles.find((x) => x.id === tileId);
  if (!t) return null;
  let insertAt = state.tray.length;
  let sameCount = 1;
  for (let i = state.tray.length - 1; i >= 0; i--) {
    if (state.tray[i].sym === t.sym) {
      insertAt = i + 1;
      break;
    }
  }
  for (const e of state.tray) if (e.sym === t.sym) sameCount++;
  const wouldClear = sameCount >= TRIPLE_SIZE;
  return {
    insertAt,
    wouldClear,
    trayAfter: state.tray.length + (wouldClear ? 1 - TRIPLE_SIZE : 1),
    symbol: t.sym,
  };
}

/**
 * Apply a command. Returns { ok, state, events, reason? }.
 * `state` is a new object on success and on counted invalid select attempts;
 * the input state is never mutated.
 *
 * Events (in order) drive presentation:
 *   {type:'invalid', reason, tileId?}
 *   {type:'pick', tileId, sym, insertAt}
 *   {type:'triple', sym, tileIds, chain}
 *   {type:'win'} / {type:'lose', reason}
 *   {type:'tick', elapsedMs} / {type:'hint'} / {type:'resign'}
 */
export function applyCommand(state, cmd) {
  const v = validateCommand(state, cmd);
  if (!v.ok) {
    // Counted invalid select attempts live inside the state (they advance the
    // turn so every state hash covers them) because invalid-action count is a
    // rules-visible tiebreak. All other rejections are pure no-ops.
    if (cmd && cmd.type === 'select' && (v.reason === 'tile_blocked' || v.reason === 'tile_not_found')) {
      const next = cloneState(state);
      next.turn = state.turn + 1;
      next.invalidCount = state.invalidCount + 1;
      return {
        ok: false,
        reason: v.reason,
        state: next,
        events: [{ type: 'invalid', reason: v.reason, tileId: cmd.tileId ?? null }],
      };
    }
    return { ok: false, reason: v.reason, state, events: [{ type: 'invalid', reason: v.reason }] };
  }

  const next = cloneState(state);
  next.turn = state.turn + 1;
  const events = [];

  switch (cmd.type) {
    case 'select': {
      const idx = next.tiles.findIndex((x) => x.id === cmd.tileId);
      const tile = next.tiles[idx];
      next.tiles.splice(idx, 1);
      // Insert directly after the last same-symbol entry so groups stay together.
      let insertAt = next.tray.length;
      for (let i = next.tray.length - 1; i >= 0; i--) {
        if (next.tray[i].sym === tile.sym) {
          insertAt = i + 1;
          break;
        }
      }
      next.tray.splice(insertAt, 0, { id: tile.id, sym: tile.sym });
      next.moves += 1;
      events.push({ type: 'pick', tileId: tile.id, sym: tile.sym, insertAt });

      // Resolve a triple of this symbol (count can never exceed TRIPLE_SIZE
      // here because a third copy clears immediately).
      const positions = [];
      for (let i = 0; i < next.tray.length; i++) {
        if (next.tray[i].sym === tile.sym) positions.push(i);
      }
      if (positions.length >= TRIPLE_SIZE) {
        const clearedIds = positions.slice(0, TRIPLE_SIZE).map((i) => next.tray[i].id);
        next.tray = next.tray.filter((e) => !clearedIds.includes(e.id));
        const withinWindow =
          state.lastTripleTurn >= 0 && next.turn - state.lastTripleTurn <= SCORING.COMBO_WINDOW_TURNS;
        next.comboChain = withinWindow ? state.comboChain + 1 : 1;
        next.lastTripleTurn = next.turn;
        next.score.triples += 1;
        next.score.base += SCORING.TRIPLE_BASE;
        next.score.comboBonus += (next.comboChain - 1) * SCORING.COMBO_STEP;
        next.stats.triplesCleared += 1;
        next.stats.tilesCleared += TRIPLE_SIZE;
        events.push({ type: 'triple', sym: tile.sym, tileIds: clearedIds, chain: next.comboChain });
      }

      // Terminal checks — win first, then losses.
      if (next.tiles.length === 0) {
        next.status = 'won';
        next.terminalReason = 'cleared';
        next.score.slotBonus = (next.trayCapacity - next.tray.length) * SCORING.SLOT_BONUS;
        if (next.parMs != null) {
          const underMs = Math.max(0, next.parMs - next.elapsedMs);
          next.score.timeBonus = Math.floor(underMs / 1000) * SCORING.TIME_BONUS_PER_SEC;
        }
        recomputeTotal(next.score);
        events.push({ type: 'win' });
      } else if (next.tray.length >= next.trayCapacity) {
        next.status = 'lost';
        next.terminalReason = 'tray_full';
        recomputeTotal(next.score);
        events.push({ type: 'lose', reason: 'tray_full' });
      } else if (next.limits.moveLimit != null && next.moves >= next.limits.moveLimit) {
        next.status = 'lost';
        next.terminalReason = 'move_limit';
        recomputeTotal(next.score);
        events.push({ type: 'lose', reason: 'move_limit' });
      } else {
        recomputeTotal(next.score);
      }
      break;
    }

    case 'tick': {
      const dt = Math.round(cmd.dt / STEP_MS) * STEP_MS; // quantize to simulation units
      next.elapsedMs += dt;
      events.push({ type: 'tick', elapsedMs: next.elapsedMs });
      if (next.limits.timeLimitMs != null && next.elapsedMs >= next.limits.timeLimitMs) {
        next.status = 'lost';
        next.terminalReason = 'time_limit';
        events.push({ type: 'lose', reason: 'time_limit' });
      }
      break;
    }

    case 'resign': {
      next.status = 'lost';
      next.terminalReason = 'resigned';
      events.push({ type: 'resign' }, { type: 'lose', reason: 'resigned' });
      break;
    }

    case 'hint': {
      next.hintsUsed += 1;
      events.push({ type: 'hint' });
      break;
    }

    default:
      // 'undo' is validated above but resolved by the session layer, which
      // owns the state stack; the engine stays a pure single-step machine.
      events.push({ type: cmd.type });
      break;
  }

  return { ok: true, state: next, events };
}

// ---------------------------------------------------------------------------
// Result / scoring presentation helpers
// ---------------------------------------------------------------------------

/** Ordered score component breakdown for the results screen. */
export function scoreBreakdown(state) {
  const s = state.score;
  const rows = [
    { key: 'triples', label: `Triples cleared ×${s.triples}`, value: s.base },
    { key: 'combo', label: 'Combo bonus', value: s.comboBonus },
    { key: 'slots', label: 'Tray space kept', value: s.slotBonus },
    { key: 'time', label: 'Under par time', value: s.timeBonus },
  ];
  return { rows, total: s.total };
}

/**
 * Authoritative result comparison (ties broken in spec order):
 *   1. primary objective completion  2. score  3. fewer invalid actions
 *   4. lower elapsed time            5. stable session identifier
 * Returns <0 if a ranks above b.
 */
export function compareResults(a, b) {
  const completeA = a.status === 'won' ? 1 : 0;
  const completeB = b.status === 'won' ? 1 : 0;
  if (completeA !== completeB) return completeB - completeA;
  if (a.score.total !== b.score.total) return b.score.total - a.score.total;
  if (a.invalidCount !== b.invalidCount) return a.invalidCount - b.invalidCount;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return String(a.sessionId ?? '').localeCompare(String(b.sessionId ?? ''));
}

/** Compact public result record used for boards and progression. */
export function resultRecord(state, sessionId) {
  return {
    sessionId,
    contentId: state.contentId,
    rulesetId: state.rulesetId,
    seed: state.seed,
    status: state.status,
    terminalReason: state.terminalReason,
    score: state.score.total,
    components: { ...state.score },
    moves: state.moves,
    invalidCount: state.invalidCount,
    hintsUsed: state.hintsUsed,
    undosUsed: state.undosUsed,
    elapsedMs: state.elapsedMs,
    turn: state.turn,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeState(state) {
  return JSON.stringify(state);
}

/** Deserialize with version migration. Throws on structurally invalid data. */
export function deserializeState(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || typeof data !== 'object') throw new Error('state: not an object');
  const version = data.version ?? 0;
  if (version > RULES_VERSION) throw new Error(`state: unsupported version ${version}`);
  let state = data;
  if (version < 1) state = migrate0to1(state);
  validateStateShape(state);
  return state;
}

function migrate0to1(old) {
  // Pre-release states lacked assists/stats; fill defaults.
  return {
    assists: { undo: false, hint: true, timingAssist: false },
    stats: { triplesCleared: 0, tilesCleared: 0 },
    hintsUsed: 0,
    undosUsed: 0,
    parMs: null,
    ...old,
    version: 1,
  };
}

function validateStateShape(s) {
  const ok =
    Array.isArray(s.tiles) &&
    Array.isArray(s.tray) &&
    s.tray.every((e) => e && typeof e.id === 'string' && typeof e.sym === 'string') &&
    Number.isInteger(s.turn) &&
    s.turn >= 0 &&
    Number.isInteger(s.trayCapacity) &&
    (s.status === 'active' || s.status === 'won' || s.status === 'lost') &&
    s.score &&
    Number.isInteger(s.score.total);
  if (!ok) throw new Error('state: invalid shape');
}

/** Rules-visible state hash (covers everything that affects outcomes). */
export function stateHash(state) {
  return hashValue({
    tiles: state.tiles,
    tray: state.tray,
    turn: state.turn,
    moves: state.moves,
    invalidCount: state.invalidCount,
    elapsedMs: state.elapsedMs,
    status: state.status,
    terminalReason: state.terminalReason,
    score: state.score,
    comboChain: state.comboChain,
    lastTripleTurn: state.lastTripleTurn,
    hintsUsed: state.hintsUsed,
    undosUsed: state.undosUsed,
  });
}
