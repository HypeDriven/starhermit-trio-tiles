import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNEY,
  CHALLENGES,
  PRACTICE_DIFFICULTIES,
  LESSONS,
  ACHIEVEMENTS,
  THEMES,
  dailyLevel,
  todayUTC,
  practiceLevel,
  materializeLevel,
  lessonLevel,
} from '../js/rules/content.js';
import { validateLevel, generateLayout, SHAPES, SYMBOLS } from '../js/rules/layout.js';
import { solve } from '../js/rules/solver.js';
import { createGame } from '../js/rules/engine.js';

test('journey ships 48 stages across 6 chapters with mastery gates', () => {
  assert.equal(JOURNEY.length, 48);
  const chapters = new Set(JOURNEY.map((s) => s.chapter));
  assert.equal(chapters.size, 6);
  const mastery = JOURNEY.filter((s) => s.mastery);
  assert.equal(mastery.length, 6, 'one mastery stage per chapter');
});

test('every journey stage generates a valid, solvable layout', { timeout: 120000 }, () => {
  for (const stage of JOURNEY) {
    const level = materializeLevel(stage);
    assert.equal(level.tiles.length, stage.config.triples * 3, stage.id);
    assert.ok(level.parMs >= 30000, `${stage.id} has bounded duration`);
    assert.ok(level.difficulty >= 1 && level.difficulty <= 5, stage.id);
  }
});

test('every challenge is valid and solvable', { timeout: 60000 }, () => {
  for (const c of CHALLENGES) {
    const level = materializeLevel(c);
    assert.ok(level.metrics.solvable, c.id);
  }
});

test('practice presets at several seeds are solvable', { timeout: 60000 }, () => {
  for (const preset of PRACTICE_DIFFICULTIES) {
    for (const seed of ['alpha', 'beta', 'gamma']) {
      const level = materializeLevel(practiceLevel(preset.id, seed));
      assert.ok(level.metrics.solvable, `${preset.id}/${seed}`);
    }
  }
});

test('daily level: stable seed per UTC day, rotation covers the week', { timeout: 60000 }, () => {
  const a = dailyLevel(new Date(Date.UTC(2026, 0, 5))); // a Monday
  const b = dailyLevel(new Date(Date.UTC(2026, 0, 5, 23, 59)));
  assert.equal(a.seed, b.seed, 'same UTC day ⇒ same seed');
  assert.equal(a.id, 'daily-2026-01-05');
  const c = dailyLevel(new Date(Date.UTC(2026, 0, 6)));
  assert.notEqual(a.seed, c.seed, 'different days differ');
  for (let d = 4; d <= 10; d++) {
    const level = materializeLevel(dailyLevel(new Date(Date.UTC(2026, 0, d))));
    assert.ok(level.metrics.solvable, level.id);
  }
});

test('generation is deterministic for identical config and seed', () => {
  const cfg = { seed: 'det-1', triples: 8, symbolKinds: 5, shape: 'pagoda', maxLayers: 3, scramble: 9 };
  const a = generateLayout(cfg);
  const b = generateLayout(cfg);
  assert.deepEqual(a.tiles, b.tiles);
});

test('all shapes generate solvable layouts at moderate size', { timeout: 60000 }, () => {
  for (const shape of SHAPES) {
    const layout = generateLayout({ seed: 'shape-' + shape, triples: 9, symbolKinds: 5, shape, maxLayers: 3, scramble: 9 });
    assert.equal(layout.tiles.length, 27);
    const probe = createGame({ tiles: layout.tiles, seed: 'x', meta: {} });
    assert.ok(solve(probe).solvable, shape);
  }
});

test('validator rejects defective content', () => {
  const bad1 = validateLevel({ seed: 'v', tiles: [{ id: 'a', sym: 'leaf', gx: 0, gy: 0, z: 0 }] });
  assert.equal(bad1.ok, false, 'not a multiple of three');
  const bad2 = validateLevel({
    seed: 'v',
    tiles: [
      { id: 'a', sym: 'leaf', gx: 0, gy: 0, z: 0 },
      { id: 'a', sym: 'leaf', gx: 3, gy: 0, z: 0 },
      { id: 'c', sym: 'leaf', gx: 6, gy: 0, z: 0 },
    ],
  });
  assert.equal(bad2.ok, false, 'duplicate ids');
  const bad3 = validateLevel({
    seed: 'v',
    tiles: [
      { id: 'a', sym: 'nope', gx: 0, gy: 0, z: 0 },
      { id: 'b', sym: 'nope', gx: 3, gy: 0, z: 0 },
      { id: 'c', sym: 'nope', gx: 6, gy: 0, z: 0 },
    ],
  });
  assert.equal(bad3.ok, false, 'unknown symbol');
});

test('validator proves an unsolvable layout unsolvable', () => {
  // Capacity trap: 7 distinct singles visible before any triple can complete.
  const syms = ['leaf', 'moon', 'sun', 'wave', 'fan', 'koi', 'peak'];
  const tiles = syms.map((sym, i) => ({ id: 'x' + i, sym, gx: i * 3, gy: 0, z: 0 }));
  tiles.push({ id: 'y0', sym: 'leaf', gx: 0, gy: 3, z: 0 });
  tiles.push({ id: 'y1', sym: 'leaf', gx: 3, gy: 3, z: 0 });
  const res = validateLevel({ seed: 'v', tiles });
  assert.equal(res.ok, false);
  assert.equal(res.metrics.solvable, false);
});

test('lessons are small, valid, and action-completable', () => {
  const ids = new Set();
  for (const lesson of LESSONS) {
    assert.ok(!ids.has(lesson.id));
    ids.add(lesson.id);
    assert.ok(lesson.tiles.length >= 3);
    assert.ok(lesson.steps.length >= 1);
    const level = lessonLevel(lesson);
    const probe = createGame({ tiles: level.tiles, seed: 'l', meta: {} });
    assert.ok(solve(probe).solvable, lesson.id);
    for (const t of lesson.tiles) assert.ok(SYMBOLS.some((s) => s.id === t.sym), `known symbol ${t.sym}`);
  }
});

test('achievements: five stable lowercase keys', () => {
  assert.equal(ACHIEVEMENTS.length, 5);
  for (const a of ACHIEVEMENTS) assert.match(a.key, /^[a-z0-9_]+$/);
});

test('themes: five visual themes with full palettes', () => {
  assert.equal(Object.keys(THEMES).length, 5);
  for (const t of Object.values(THEMES)) {
    assert.ok(Number.isInteger(t.table) && Number.isInteger(t.tile) && Number.isInteger(t.ink), t.id);
  }
});

test('todayUTC normalizes to UTC midnight', () => {
  const d = todayUTC(new Date(Date.UTC(2026, 5, 15, 13, 45)));
  assert.equal(d.toISOString(), '2026-06-15T00:00:00.000Z');
});
