import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyCommand, validateCommand, deserializeState } from '../js/rules/engine.js';
import { Session } from '../js/session/session.js';
import { materializeLevel, practiceLevel } from '../js/rules/content.js';
import { mulberry32 } from '../js/rules/rng.js';

function baseGame() {
  return createGame({
    tiles: [
      { id: 'a', sym: 'leaf', gx: 0, gy: 0, z: 0 },
      { id: 'b', sym: 'leaf', gx: 3, gy: 0, z: 0 },
      { id: 'c', sym: 'leaf', gx: 6, gy: 0, z: 0 },
    ],
    seed: 'fuzz',
    meta: {},
  });
}

test('fuzz: malformed commands never throw and never corrupt state', () => {
  const rand = mulberry32(42);
  const junk = [
    null,
    undefined,
    42,
    'select',
    [],
    {},
    { type: 1 },
    { type: null },
    { type: 'select' },
    { type: 'select', tileId: 42 },
    { type: 'select', tileId: {} },
    { type: 'tick' },
    { type: 'tick', dt: -5 },
    { type: 'tick', dt: NaN },
    { type: 'tick', dt: Infinity },
    { type: 'tick', dt: 1e12 },
    { type: 'tick', dt: '100' },
    { type: 'nonsense' },
    { type: '__proto__' },
    { type: 'select', tileId: 'a', extra: { deep: [1, 2, 3] } },
  ];
  for (let round = 0; round < 200; round++) {
    let s = baseGame();
    for (let i = 0; i < 50; i++) {
      const cmd = junk[Math.floor(rand() * junk.length)];
      let out;
      assert.doesNotThrow(() => {
        out = applyCommand(s, cmd);
      });
      s = out.state;
      // Invariants after every single command.
      assert.ok(Number.isInteger(s.turn) && s.turn >= 0);
      assert.ok(s.tray.length <= s.trayCapacity);
      assert.ok(Number.isInteger(s.score.total));
      assert.ok(['active', 'won', 'lost'].includes(s.status));
      assert.doesNotThrow(() => deserializeState(JSON.parse(JSON.stringify(s))));
    }
  }
});

test('fuzz: random structured commands keep invariants (no hangs, no NaN)', { timeout: 60000 }, () => {
  const rand = mulberry32(1337);
  for (let round = 0; round < 30; round++) {
    const level = materializeLevel(practiceLevel(['easy', 'normal', 'hard'][round % 3], 'fz' + round));
    const s = new Session(level, { sessionId: 'fz' + round });
    let guard = 0;
    let prevTurn = 0;
    while (s.state.status === 'active' && guard++ < 300) {
      const r = rand();
      if (r < 0.7 && s.state.tiles.length > 0) {
        const t = s.state.tiles[Math.floor(rand() * s.state.tiles.length)];
        s.submit({ type: 'select', tileId: t.id });
      } else if (r < 0.8) {
        s.submit({ type: 'undo' });
      } else if (r < 0.9) {
        s.submit({ type: 'tick', dt: Math.floor(rand() * 2000) + 1 });
      } else if (r < 0.95) {
        s.submit({ type: 'hint' });
      } else {
        s.submit({ type: 'resign' });
      }
      assert.ok(s.state.tray.length <= s.state.trayCapacity, 'tray bounded');
      assert.ok(Number.isFinite(s.state.elapsedMs), 'no NaN clock');
      assert.ok(s.state.turn >= prevTurn, 'turn is monotonic across all commands');
      prevTurn = s.state.turn;
    }
  }
});

test('fuzz: malformed replay envelopes fail cleanly', () => {
  const cases = [null, undefined, {}, { schemaVersion: 999 }, { schemaVersion: 1 }, 'garbage', 42, [], { schemaVersion: 1, level: null }];
  for (const env of cases) {
    // verifyReplay never throws on untrusted input.
    const { verifyReplay } = awaitImport();
    const v = verifyReplay(env);
    assert.equal(v.ok, false);
    assert.ok(typeof v.error === 'string');
  }
});

import { verifyReplay } from '../js/session/session.js';
function awaitImport() {
  return { verifyReplay };
}

test('validateCommand on non-object garbage', () => {
  const s = baseGame();
  for (const cmd of [null, undefined, 0, '', [], Symbol.iterator ? undefined : null]) {
    const v = validateCommand(s, cmd);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'malformed');
  }
});
