import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame,
  applyCommand,
  validateCommand,
  legalActions,
  computeExposure,
  projectSelect,
  serializeState,
  deserializeState,
  stateHash,
  scoreBreakdown,
  compareResults,
  SCORING,
} from '../js/rules/engine.js';

function simpleTiles() {
  // Two triples, all on layer 0, fully exposed.
  return [
    { id: 'a', sym: 'leaf', gx: 0, gy: 0, z: 0 },
    { id: 'b', sym: 'leaf', gx: 3, gy: 0, z: 0 },
    { id: 'c', sym: 'leaf', gx: 6, gy: 0, z: 0 },
    { id: 'd', sym: 'moon', gx: 0, gy: 3, z: 0 },
    { id: 'e', sym: 'moon', gx: 3, gy: 3, z: 0 },
    { id: 'f', sym: 'moon', gx: 6, gy: 3, z: 0 },
  ];
}

function game(overrides = {}) {
  return createGame({ tiles: simpleTiles(), seed: 'test', meta: {}, ...overrides });
}

test('exposure: flat layout exposes everything', () => {
  const s = game();
  const { exposed, blockers } = computeExposure(s);
  assert.equal(exposed.length, 6);
  assert.equal(blockers.size, 0);
});

test('exposure: higher overlapping tile blocks lower', () => {
  const s = createGame({
    tiles: [
      { id: 'low', sym: 'leaf', gx: 0, gy: 0, z: 0 },
      { id: 'high', sym: 'moon', gx: 1, gy: 1, z: 1 }, // half-offset overlap
      { id: 'far', sym: 'sun', gx: 10, gy: 10, z: 0 },
    ],
    seed: 't',
    meta: {},
  });
  assert.equal(isExposedSafe(s, 'low'), false);
  assert.equal(isExposedSafe(s, 'high'), true);
  assert.equal(isExposedSafe(s, 'far'), true);
});

function isExposedSafe(s, id) {
  return computeExposure(s).exposed.includes(id);
}

test('select: moves tile into tray after same symbol, clears third', () => {
  let s = game();
  let r = applyCommand(s, { type: 'select', tileId: 'a' });
  assert.equal(r.ok, true);
  assert.equal(r.state.tray.map((e) => e.id).join(','), 'a');
  r = applyCommand(r.state, { type: 'select', tileId: 'd' });
  assert.equal(r.state.tray.map((e) => e.id).join(','), 'a,d');
  // 'b' is a leaf like 'a' — inserted right after 'a', not at the end.
  r = applyCommand(r.state, { type: 'select', tileId: 'b' });
  assert.equal(r.state.tray.map((e) => e.id).join(','), 'a,b,d');
  r = applyCommand(r.state, { type: 'select', tileId: 'c' });
  assert.equal(r.state.tray.length, 1, 'triple of leaves cleared');
  assert.equal(r.state.tray[0].id, 'd');
  assert.equal(r.state.score.base, SCORING.TRIPLE_BASE);
  assert.equal(r.state.stats.triplesCleared, 1);
});

test('terminal: clearing the layout wins with slot bonus', () => {
  let s = game();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    s = applyCommand(s, { type: 'select', tileId: id }).state;
  }
  assert.equal(s.status, 'won');
  assert.equal(s.terminalReason, 'cleared');
  assert.equal(s.score.slotBonus, 7 * SCORING.SLOT_BONUS);
  assert.equal(s.score.total, s.score.base + s.score.comboBonus + s.score.slotBonus + s.score.timeBonus);
});

test('terminal: full tray with no triple loses', () => {
  // 7 distinct symbols, capacity 7 — the 7th pick fills the tray.
  const syms = ['leaf', 'moon', 'sun', 'wave', 'fan', 'koi', 'peak'];
  const tiles = syms.map((sym, i) => ({ id: 'x' + i, sym, gx: i * 3, gy: 0, z: 0 }));
  // add triples so the layout itself is legal-count
  tiles.push(
    { id: 'y0', sym: 'leaf', gx: 0, gy: 3, z: 0 },
    { id: 'y1', sym: 'leaf', gx: 3, gy: 3, z: 0 },
  );
  let s = createGame({ tiles, seed: 't', meta: {} });
  for (let i = 0; i < 7; i++) {
    const r = applyCommand(s, { type: 'select', tileId: 'x' + i });
    s = r.state;
  }
  assert.equal(s.status, 'lost');
  assert.equal(s.terminalReason, 'tray_full');
});

test('terminal: move limit and time limit', () => {
  let s = game({ limits: { moveLimit: 2 } });
  s = applyCommand(s, { type: 'select', tileId: 'a' }).state;
  s = applyCommand(s, { type: 'select', tileId: 'd' }).state;
  assert.equal(s.status, 'lost');
  assert.equal(s.terminalReason, 'move_limit');

  let t = game({ limits: { timeLimitMs: 1000 } });
  t = applyCommand(t, { type: 'tick', dt: 600 }).state;
  assert.equal(t.status, 'active');
  t = applyCommand(t, { type: 'tick', dt: 600 }).state;
  assert.equal(t.status, 'lost');
  assert.equal(t.terminalReason, 'time_limit');
  assert.equal(t.elapsedMs % 50, 0, 'time is quantized to simulation units');
});

test('resign ends the round with a terminal reason', () => {
  let s = game();
  s = applyCommand(s, { type: 'resign' }).state;
  assert.equal(s.status, 'lost');
  assert.equal(s.terminalReason, 'resigned');
});

test('invalid: blocked tile explains why and counts the attempt', () => {
  const s0 = createGame({
    tiles: [
      { id: 'low', sym: 'leaf', gx: 0, gy: 0, z: 0 },
      { id: 'high', sym: 'moon', gx: 0, gy: 0, z: 1 },
    ],
    seed: 't',
    meta: {},
  });
  const v = validateCommand(s0, { type: 'select', tileId: 'low' });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'tile_blocked');
  const r = applyCommand(s0, { type: 'select', tileId: 'low' });
  assert.equal(r.ok, false);
  assert.equal(r.state.invalidCount, 1);
  assert.equal(r.state.turn, 1, 'counted invalid attempts advance the monotonic turn');
  assert.equal(r.state.tiles.length, 2, 'no state theft on invalid select');
});

test('invalid: unknown tile, post-terminal commands are no-ops', () => {
  let s = game();
  const r = applyCommand(s, { type: 'select', tileId: 'zzz' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tile_not_found');
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) s = applyCommand(s, { type: 'select', tileId: id }).state;
  assert.equal(s.status, 'won');
  const after = applyCommand(s, { type: 'select', tileId: 'a' });
  assert.equal(after.ok, false);
  assert.equal(after.reason, 'not_active');
  assert.equal(after.state, s, 'terminal-state commands return the same state object');
});

test('combo: chains within window, resets outside', () => {
  const tiles = [];
  const syms = ['leaf', 'moon', 'sun'];
  syms.forEach((sym, k) => {
    for (let i = 0; i < 3; i++) tiles.push({ id: `${sym}${i}`, sym, gx: i * 3, gy: k * 3, z: 0 });
  });
  let s = createGame({ tiles, seed: 't', meta: {} });
  for (const id of ['leaf0', 'leaf1', 'leaf2']) s = applyCommand(s, { type: 'select', tileId: id }).state;
  assert.equal(s.comboChain, 1);
  for (const id of ['moon0', 'moon1', 'moon2']) s = applyCommand(s, { type: 'select', tileId: id }).state;
  assert.equal(s.comboChain, 2);
  assert.equal(s.score.comboBonus, SCORING.COMBO_STEP);
  for (const id of ['sun0', 'sun1', 'sun2']) s = applyCommand(s, { type: 'select', tileId: id }).state;
  assert.equal(s.comboChain, 3);
  assert.equal(s.score.comboBonus, SCORING.COMBO_STEP * (1 + 2));
});

test('projection: previews insert position and clear', () => {
  let s = game();
  s = applyCommand(s, { type: 'select', tileId: 'a' }).state;
  s = applyCommand(s, { type: 'select', tileId: 'd' }).state;
  const p = projectSelect(s, 'b');
  assert.equal(p.insertAt, 1);
  assert.equal(p.wouldClear, false);
  const p2 = projectSelect(applyCommand(s, { type: 'select', tileId: 'b' }).state, 'c');
  assert.equal(p2.wouldClear, true);
  assert.equal(p2.trayAfter, 1);
});

test('serialization roundtrip + migration from v0', () => {
  let s = game();
  s = applyCommand(s, { type: 'select', tileId: 'a' }).state;
  const json = serializeState(s);
  const back = deserializeState(json);
  assert.equal(stateHash(back), stateHash(s));

  const v0 = JSON.parse(json);
  delete v0.version;
  delete v0.assists;
  const migrated = deserializeState(v0);
  assert.equal(migrated.version, 1);
  assert.ok(migrated.assists);
  assert.throws(() => deserializeState('{"version":99}'), /unsupported/);
  assert.throws(() => deserializeState('{"tiles":42}'), /invalid shape/);
});

test('scoring breakdown exposes components, not a bare total', () => {
  let s = game();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) s = applyCommand(s, { type: 'select', tileId: id }).state;
  const b = scoreBreakdown(s);
  assert.equal(b.rows.length, 4);
  assert.equal(b.total, b.rows.reduce((a, r) => a + r.value, 0));
});

test('tie-breaks: completion, invalid count, elapsed, session id', () => {
  const mk = (over) => ({
    status: 'won',
    score: { total: 1000 },
    invalidCount: 0,
    elapsedMs: 60000,
    sessionId: 'a',
    ...over,
  });
  assert.ok(compareResults(mk({}), mk({ status: 'lost' })) < 0);
  assert.ok(compareResults(mk({ invalidCount: 1 }), mk({ invalidCount: 3 })) < 0);
  assert.ok(compareResults(mk({ elapsedMs: 1000 }), mk({ elapsedMs: 2000 })) < 0);
  assert.ok(compareResults(mk({ sessionId: 'a' }), mk({ sessionId: 'b' })) < 0);
});

test('legalActions is the single source of truth for legality', () => {
  const s = game({ assists: { undo: true, hint: true } });
  const la = legalActions(s);
  assert.equal(la.selectable.length, 6);
  assert.equal(la.canUndo, false, 'nothing played yet');
  const s2 = applyCommand(s, { type: 'select', tileId: 'a' }).state;
  assert.equal(legalActions(s2).canUndo, true);
});
