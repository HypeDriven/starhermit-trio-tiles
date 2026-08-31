/**
 * Versioned game content: journey stages, daily challenge, practice presets,
 * challenge set, learn lessons, themes, and the static achievement set.
 *
 * Every level is data: { id, version, seed, name, config, theme, ... }.
 * Layouts are materialized deterministically from the seed via the generator
 * and proven solvable by the validator (see tests and validateLevelAtLoad).
 */

import { generateLayout, validateLevel, difficultyRating } from './layout.js';
import { hashString } from './rng.js';

export const CONTENT_VERSION = 1;
export const BUILD_ID = '1.0.0';
export const RULESET_STANDARD = 'standard-v1';

// ---------------------------------------------------------------------------
// Themes — five original visual themes (cosmetic only, never rules)
// ---------------------------------------------------------------------------

export const THEMES = Object.freeze({
  dawn: {
    id: 'dawn',
    name: 'Dawn Veranda',
    sky: [0xf6d9b8, 0xe8a87c, 0x9c6b5e],
    fog: 0xeac39a,
    key: { color: 0xffe3c0, intensity: 2.6 },
    fill: { color: 0x88a0b9, intensity: 0.55 },
    table: 0x8a5a3b,
    tableTrim: 0x5e3a24,
    tile: 0xf3e3c8,
    tileSide: 0xd8bd96,
    ink: 0x4a3222,
    accent: 0xc96f4a,
    water: 0x7c9aa8,
    petal: 0xe8a4b8,
  },
  dusk: {
    id: 'dusk',
    name: 'Dusk Pavilion',
    sky: [0x2e2a4e, 0x6b4a7a, 0xc97b5a],
    fog: 0x4a3a5e,
    key: { color: 0xffb37c, intensity: 2.0 },
    fill: { color: 0x5e6a9c, intensity: 0.7 },
    table: 0x6b4632,
    tableTrim: 0x472c1e,
    tile: 0xe9d5b5,
    tileSide: 0xc4a982,
    ink: 0x3a2a20,
    accent: 0xe08a5a,
    water: 0x3e4a6e,
    petal: 0xb08ac9,
  },
  garden: {
    id: 'garden',
    name: 'Moss Garden',
    sky: [0xcfe8c9, 0x8fc49a, 0x4a7a5e],
    fog: 0xaed4b0,
    key: { color: 0xfff2d0, intensity: 2.4 },
    fill: { color: 0x7a9c8a, intensity: 0.6 },
    table: 0x7a5238,
    tableTrim: 0x523424,
    tile: 0xefe6cf,
    tileSide: 0xcbb490,
    ink: 0x33402a,
    accent: 0x5e8a4a,
    water: 0x6a9a8a,
    petal: 0xf0b8c8,
  },
  moonlit: {
    id: 'moonlit',
    name: 'Moonlit Basin',
    sky: [0x10162e, 0x25305a, 0x4a5a8a],
    fog: 0x1c2544,
    key: { color: 0xcfe0ff, intensity: 1.8 },
    fill: { color: 0x3a4a7a, intensity: 0.8 },
    table: 0x4e3a30,
    tableTrim: 0x33241e,
    tile: 0xdcd4c0,
    tileSide: 0xb0a892,
    ink: 0x22243a,
    accent: 0x8ab0e0,
    water: 0x2a3a5e,
    petal: 0x9ab0d8,
  },
  ember: {
    id: 'ember',
    name: 'Ember Hearth',
    sky: [0x2e1a14, 0x6e3424, 0xc97b3a],
    fog: 0x3a2018,
    key: { color: 0xffc27c, intensity: 2.2 },
    fill: { color: 0x7a4a3a, intensity: 0.7 },
    table: 0x5e3c28,
    tableTrim: 0x3e2818,
    tile: 0xe8d0a8,
    tileSide: 0xbf9c6e,
    ink: 0x40261a,
    accent: 0xe07a3a,
    water: 0x5e3a2e,
    petal: 0xe09a6a,
  },
});

export const THEME_IDS = Object.freeze(Object.keys(THEMES));

// ---------------------------------------------------------------------------
// Journey — 48 authored stages across 6 chapters (every 8th is a mastery
// stage). Parameters are hand-chosen; layouts derive deterministically.
// ---------------------------------------------------------------------------

const CHAPTERS = [
  { id: 'ch1', name: 'First Steeps', theme: 'dawn', unlockTheme: null },
  { id: 'ch2', name: 'Layered Leaves', theme: 'garden', unlockTheme: 'garden' },
  { id: 'ch3', name: 'Still Water', theme: 'dusk', unlockTheme: 'dusk' },
  { id: 'ch4', name: 'Mountain Mist', theme: 'moonlit', unlockTheme: 'moonlit' },
  { id: 'ch5', name: 'Ember Hours', theme: 'ember', unlockTheme: 'ember' },
  { id: 'ch6', name: 'Grand Mastery', theme: 'dawn', unlockTheme: null },
];

// [triples, symbolKinds, shape, maxLayers, scramble, extra?]
const JOURNEY_PARAMS = [
  // Chapter 1 — one concept at a time: exposed tiles, triples, tray pressure
  [[4, 3, 'terrace', 1, 3], [5, 3, 'terrace', 1, 3], [5, 4, 'garden', 1, 4], [6, 4, 'terrace', 2, 4], [6, 4, 'garden', 2, 5], [7, 4, 'ring', 1, 5], [7, 5, 'terrace', 2, 6], [9, 5, 'pagoda', 2, 6, { mastery: true }]],
  // Chapter 2 — stacking and half-offset overlap
  [[8, 5, 'pagoda', 2, 6], [9, 5, 'ring', 2, 6], [9, 6, 'pagoda', 2, 7], [10, 5, 'terrace', 3, 7], [10, 6, 'garden', 3, 8], [11, 6, 'pagoda', 3, 8], [11, 6, 'bridge', 2, 8], [12, 6, 'pagoda', 3, 9, { mastery: true }]],
  // Chapter 3 — wider symbol sets, planning ahead
  [[10, 6, 'spiral', 2, 9], [11, 7, 'bridge', 2, 9], [12, 7, 'ring', 3, 9], [12, 7, 'spiral', 3, 10], [13, 7, 'garden', 3, 10], [13, 8, 'terrace', 3, 10], [14, 8, 'bridge', 3, 11], [15, 8, 'spiral', 3, 11, { mastery: true }]],
  // Chapter 4 — tall stacks, hidden information
  [[12, 7, 'pagoda', 4, 10], [13, 8, 'pagoda', 4, 11], [14, 8, 'ring', 4, 11], [14, 8, 'terrace', 4, 12], [15, 9, 'garden', 4, 12], [15, 9, 'pagoda', 4, 12], [16, 9, 'bridge', 4, 12], [17, 9, 'pagoda', 4, 13, { mastery: true }]],
  // Chapter 5 — the clock joins in
  [[13, 8, 'spiral', 3, 12], [14, 8, 'terrace', 4, 12, { timeLimitMs: 240000 }], [14, 9, 'bridge', 3, 12], [15, 9, 'ring', 4, 13, { timeLimitMs: 240000 }], [15, 9, 'spiral', 4, 13], [16, 10, 'garden', 4, 13], [16, 10, 'pagoda', 4, 14, { timeLimitMs: 300000 }], [17, 10, 'terrace', 4, 14, { mastery: true }]],
  // Chapter 6 — combined mastery
  [[15, 9, 'bridge', 4, 14], [16, 10, 'spiral', 4, 14, { timeLimitMs: 300000 }], [16, 10, 'pagoda', 5, 14], [17, 10, 'ring', 5, 15], [17, 11, 'garden', 5, 15, { trayCapacity: 6 }], [18, 11, 'terrace', 5, 15, { timeLimitMs: 330000 }], [18, 11, 'bridge', 5, 16], [20, 12, 'pagoda', 5, 16, { mastery: true }]],
];

function buildJourney() {
  const stages = [];
  CHAPTERS.forEach((ch, ci) => {
    JOURNEY_PARAMS[ci].forEach((p, si) => {
      const [triples, symbolKinds, shape, maxLayers, scramble, extra = {}] = p;
      const index = stages.length;
      const id = `j${ci + 1}-${si + 1}`;
      stages.push({
        id,
        version: CONTENT_VERSION,
        kind: 'journey',
        name: `${ch.name} ${si + 1}`,
        chapter: ch.id,
        chapterName: ch.name,
        chapterIndex: ci,
        stageIndex: si,
        index,
        mastery: !!extra.mastery,
        theme: ch.theme,
        seed: hashString(`trio:journey:${id}`),
        config: {
          triples,
          symbolKinds,
          shape,
          maxLayers,
          scramble,
          trayCapacity: extra.trayCapacity ?? 7,
          timeLimitMs: extra.timeLimitMs ?? null,
          undo: false,
          hints: true,
          ranked: true,
        },
      });
    });
  });
  return stages;
}

export const JOURNEY = Object.freeze(buildJourney());

export const JOURNEY_CHAPTERS = Object.freeze(
  CHAPTERS.map((c, i) => ({
    ...c,
    stages: JOURNEY.filter((s) => s.chapterIndex === i).map((s) => s.id),
  })),
);

// ---------------------------------------------------------------------------
// Practice presets — undo allowed, unranked
// ---------------------------------------------------------------------------

export const PRACTICE_DIFFICULTIES = Object.freeze([
  { id: 'easy', name: 'Easy', config: { triples: 6, symbolKinds: 4, shape: 'terrace', maxLayers: 2, scramble: 5 } },
  { id: 'normal', name: 'Normal', config: { triples: 10, symbolKinds: 6, shape: 'pagoda', maxLayers: 3, scramble: 9 } },
  { id: 'hard', name: 'Hard', config: { triples: 14, symbolKinds: 8, shape: 'bridge', maxLayers: 4, scramble: 12 } },
  { id: 'expert', name: 'Expert', config: { triples: 18, symbolKinds: 11, shape: 'pagoda', maxLayers: 5, scramble: 15, trayCapacity: 6 } },
]);

export function practiceLevel(difficultyId, seed, theme = 'dawn') {
  const preset = PRACTICE_DIFFICULTIES.find((d) => d.id === difficultyId) ?? PRACTICE_DIFFICULTIES[1];
  return {
    id: `practice-${preset.id}-${hashString(String(seed)).slice(0, 6)}`,
    version: CONTENT_VERSION,
    kind: 'practice',
    name: `${preset.name} Practice`,
    theme,
    seed: String(seed),
    config: {
      ...preset.config,
      trayCapacity: preset.config.trayCapacity ?? 7,
      timeLimitMs: null,
      undo: true,
      hints: true,
      ranked: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Daily — one shared seed and ruleset per UTC day, immutable after publication
// ---------------------------------------------------------------------------

const DAILY_ROTATION = Object.freeze([
  { triples: 9, symbolKinds: 5, shape: 'terrace', maxLayers: 2, scramble: 7 }, // Sun
  { triples: 11, symbolKinds: 6, shape: 'garden', maxLayers: 3, scramble: 9 }, // Mon
  { triples: 12, symbolKinds: 7, shape: 'pagoda', maxLayers: 3, scramble: 10 }, // Tue
  { triples: 13, symbolKinds: 8, shape: 'bridge', maxLayers: 3, scramble: 11 }, // Wed
  { triples: 14, symbolKinds: 9, shape: 'ring', maxLayers: 4, scramble: 12 }, // Thu
  { triples: 15, symbolKinds: 9, shape: 'spiral', maxLayers: 4, scramble: 13 }, // Fri
  { triples: 16, symbolKinds: 10, shape: 'pagoda', maxLayers: 4, scramble: 14 }, // Sat
]);

const DAILY_THEMES = Object.freeze(['dawn', 'garden', 'dusk', 'moonlit', 'ember', 'garden', 'moonlit']);

export function dailyLevel(date /* Date in UTC */) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const day = `${y}-${m}-${d}`;
  const weekday = date.getUTCDay();
  const params = DAILY_ROTATION[weekday];
  return {
    id: `daily-${day}`,
    version: CONTENT_VERSION,
    kind: 'daily',
    name: `Daily Steep — ${day}`,
    day,
    theme: DAILY_THEMES[weekday],
    seed: hashString(`trio:daily:${day}`),
    config: {
      ...params,
      trayCapacity: 7,
      timeLimitMs: null,
      undo: false,
      hints: true,
      ranked: true,
    },
  };
}

export function todayUTC(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ---------------------------------------------------------------------------
// Challenges — constrained goals: speed targets, altered capacity/layouts,
// restricted tools. Authored and fixed.
// ---------------------------------------------------------------------------

export const CHALLENGES = Object.freeze([
  {
    id: 'swift-steep',
    name: 'Swift Steep',
    blurb: 'Clear the table before the tea cools. Two minutes on the clock.',
    theme: 'ember',
    seed: hashString('trio:challenge:swift-steep'),
    config: { triples: 10, symbolKinds: 6, shape: 'terrace', maxLayers: 2, scramble: 8, trayCapacity: 7, timeLimitMs: 120000, undo: false, hints: true, ranked: true },
  },
  {
    id: 'six-cups',
    name: 'Six Cups',
    blurb: 'One fewer slot in the tray. Every choice matters.',
    theme: 'dusk',
    seed: hashString('trio:challenge:six-cups'),
    config: { triples: 11, symbolKinds: 6, shape: 'garden', maxLayers: 3, scramble: 10, trayCapacity: 6, timeLimitMs: null, undo: false, hints: true, ranked: true },
  },
  {
    id: 'five-cups',
    name: 'Five Cups',
    blurb: 'A narrow tray and a crowded table. For steady hands.',
    theme: 'moonlit',
    seed: hashString('trio:challenge:five-cups'),
    config: { triples: 9, symbolKinds: 5, shape: 'ring', maxLayers: 3, scramble: 11, trayCapacity: 5, timeLimitMs: null, undo: false, hints: true, ranked: true },
  },
  {
    id: 'no-second-pour',
    name: 'No Second Pour',
    blurb: 'No hints on a deep pagoda. Read the layers yourself.',
    theme: 'garden',
    seed: hashString('trio:challenge:no-second-pour'),
    config: { triples: 13, symbolKinds: 8, shape: 'pagoda', maxLayers: 4, scramble: 12, trayCapacity: 7, timeLimitMs: null, undo: false, hints: false, ranked: true },
  },
  {
    id: 'tall-order',
    name: 'Tall Order',
    blurb: 'Five layers high. Most of the table is hidden.',
    theme: 'dawn',
    seed: hashString('trio:challenge:tall-order'),
    config: { triples: 14, symbolKinds: 8, shape: 'pagoda', maxLayers: 5, scramble: 13, trayCapacity: 7, timeLimitMs: null, undo: false, hints: true, ranked: true },
  },
  {
    id: 'monochrome',
    name: 'Monochrome Garden',
    blurb: 'Few symbols, many tiles. The tray fills before you notice.',
    theme: 'moonlit',
    seed: hashString('trio:challenge:monochrome'),
    config: { triples: 16, symbolKinds: 4, shape: 'spiral', maxLayers: 3, scramble: 14, trayCapacity: 7, timeLimitMs: null, undo: false, hints: true, ranked: true },
  },
].map((c) => Object.freeze({ ...c, version: CONTENT_VERSION, kind: 'challenge' })));

// ---------------------------------------------------------------------------
// Learn — interactive lessons; one rule at a time, action required to advance
// ---------------------------------------------------------------------------

export const LESSONS = Object.freeze([
  {
    id: 'lesson-1',
    name: 'Picking Tiles',
    theme: 'dawn',
    intro: 'Tiles rest on the tea table. Tap any tile to lift it into your tray.',
    tiles: [
      { id: 'a', sym: 'leaf', gx: 0, gy: 0, z: 0 },
      { id: 'b', sym: 'leaf', gx: 3, gy: 0, z: 0 },
      { id: 'c', sym: 'leaf', gx: 6, gy: 0, z: 0 },
    ],
    steps: [
      { id: 'l1s1', text: 'Tap the leaf tile on the left.', require: { select: 'a' } },
      { id: 'l1s2', text: 'Now tap the middle leaf.', require: { select: 'b' } },
      { id: 'l1s3', text: 'One more — tap the last leaf. Three of a kind clear from the tray!', require: { select: 'c' } },
      { id: 'l1s4', text: 'Three matching tiles cleared the tray. That is the whole idea.', require: { event: 'triple' } },
    ],
  },
  {
    id: 'lesson-2',
    name: 'Three of a Kind',
    theme: 'garden',
    intro: 'Match three identical symbols to clear them. Clear every tile to win.',
    tiles: [
      { id: 'a', sym: 'moon', gx: 0, gy: 0, z: 0 },
      { id: 'b', sym: 'sun', gx: 3, gy: 0, z: 0 },
      { id: 'c', sym: 'moon', gx: 6, gy: 0, z: 0 },
      { id: 'd', sym: 'sun', gx: 0, gy: 3, z: 0 },
      { id: 'e', sym: 'moon', gx: 3, gy: 3, z: 0 },
      { id: 'f', sym: 'sun', gx: 6, gy: 3, z: 0 },
    ],
    steps: [
      { id: 'l2s1', text: 'Gather the three moons. Tap a moon tile.', require: { selectSym: 'moon' } },
      { id: 'l2s2', text: 'Another moon — matching tiles sit together in the tray.', require: { selectSym: 'moon' } },
      { id: 'l2s3', text: 'The third moon clears the set.', require: { event: 'triple' } },
      { id: 'l2s4', text: 'Now finish the suns to clear the table.', require: { event: 'win' } },
    ],
  },
  {
    id: 'lesson-3',
    name: 'Covered Tiles',
    theme: 'dusk',
    intro: 'Tiles stacked above cast a shadow on the ones below. Covered tiles cannot be picked yet.',
    tiles: [
      { id: 'a', sym: 'wave', gx: 0, gy: 0, z: 0 },
      { id: 'b', sym: 'wave', gx: 3, gy: 0, z: 0 },
      { id: 'c', sym: 'wave', gx: 6, gy: 0, z: 0 },
      { id: 'top', sym: 'bloom', gx: 1, gy: 1, z: 1 },
      { id: 'd', sym: 'bloom', gx: 6, gy: 3, z: 0 },
      { id: 'e', sym: 'bloom', gx: 0, gy: 4, z: 0 },
    ],
    steps: [
      { id: 'l3s1', text: 'Try to tap the shadowed wave under the blossom. It is covered!', require: { invalid: 'a' }, optional: true },
      { id: 'l3s2', text: 'Lift the blossom on top to free the tile beneath.', require: { select: 'top' } },
      { id: 'l3s3', text: 'The wave is uncovered now. Clear the rest of the table.', require: { event: 'win' } },
    ],
  },
  {
    id: 'lesson-4',
    name: 'Mind the Tray',
    theme: 'moonlit',
    intro: 'The tray holds seven tiles. If it fills with no triple, the round is lost. Plan ahead.',
    tiles: [
      { id: 'a', sym: 'fan', gx: 0, gy: 0, z: 0 },
      { id: 'b', sym: 'fan', gx: 3, gy: 0, z: 0 },
      { id: 'c', sym: 'stone', gx: 6, gy: 0, z: 0 },
      { id: 'd', sym: 'fan', gx: 0, gy: 3, z: 0 },
      { id: 'e', sym: 'stone', gx: 3, gy: 3, z: 0 },
      { id: 'f', sym: 'stone', gx: 6, gy: 3, z: 0 },
      { id: 'g', sym: 'koi', gx: 0, gy: 6, z: 0 },
      { id: 'h', sym: 'koi', gx: 3, gy: 6, z: 0 },
      { id: 'i', sym: 'koi', gx: 6, gy: 6, z: 0 },
    ],
    steps: [
      { id: 'l4s1', text: 'Watch the tray gauge at the bottom. Complete sets of three before it fills.', require: { event: 'win' }, hintAllowed: true },
    ],
  },
  {
    id: 'lesson-5',
    name: 'Combos',
    theme: 'ember',
    intro: 'Clear sets in quick succession to build a combo and earn bonus points.',
    tiles: [
      { id: 'a', sym: 'crane', gx: 0, gy: 0, z: 0 },
      { id: 'b', sym: 'crane', gx: 3, gy: 0, z: 0 },
      { id: 'c', sym: 'crane', gx: 6, gy: 0, z: 0 },
      { id: 'd', sym: 'lantern', gx: 0, gy: 3, z: 0 },
      { id: 'e', sym: 'lantern', gx: 3, gy: 3, z: 0 },
      { id: 'f', sym: 'lantern', gx: 6, gy: 3, z: 0 },
    ],
    steps: [
      { id: 'l5s1', text: 'Clear the cranes, then the lanterns, without dawdling between.', require: { event: 'win' } },
    ],
  },
]);

// ---------------------------------------------------------------------------
// Achievements — small static set, stable lowercase keys, idempotent unlocks
// ---------------------------------------------------------------------------

export const ACHIEVEMENTS = Object.freeze([
  { key: 'first_clear', name: 'First Steep', description: 'Clear your first table.' },
  { key: 'lesson_master', name: 'Scholar of the Tray', description: 'Complete every lesson in Learn mode.' },
  { key: 'daily_streak_7', name: 'Seven Sunrises', description: 'Play the Daily Steep on seven days in a row.' },
  { key: 'summit', name: 'Summit of Masters', description: 'Complete the final mastery stage of the Journey.' },
  { key: 'thousand_tiles', name: 'A Thousand Tiles', description: 'Clear one thousand tiles across all rounds.' },
]);

// ---------------------------------------------------------------------------
// Materialization + load-time validation
// ---------------------------------------------------------------------------

const materialCache = new Map();

/**
 * Materialize a level: generate (and cache) its layout, compute par time and
 * difficulty, and run the load-time validator. Throws on invalid content —
 * defective content must never reach play silently.
 */
export function materializeLevel(level) {
  if (materialCache.has(level.id)) return materialCache.get(level.id);
  const layout = generateLayout({
    seed: level.seed,
    triples: level.config.triples,
    symbolKinds: level.config.symbolKinds,
    shape: level.config.shape,
    maxLayers: level.config.maxLayers,
    scramble: level.config.scramble,
    trayCapacity: level.config.trayCapacity ?? 7,
  });
  const validation = validateLevel(
    { seed: level.seed, tiles: layout.tiles, config: level.config },
    { solverBudget: 150_000 },
  );
  if (!validation.ok) {
    throw new Error(`content ${level.id} failed validation: ${validation.issues.join('; ')}`);
  }
  const parMs = validation.metrics.parSeconds * 1000;
  const out = {
    ...level,
    tiles: layout.tiles,
    symbolIds: layout.symbolIds,
    parMs,
    difficulty: difficultyRating(validation.metrics),
    metrics: validation.metrics,
    star: [
      // [two-star, three-star] thresholds from achievable components
      validation.metrics.triples * 100 + Math.floor(validation.metrics.triples * 8),
      validation.metrics.triples * 100 + Math.floor(validation.metrics.triples * 22) + 150,
    ],
  };
  materialCache.set(level.id, out);
  return out;
}

export function lessonLevel(lesson) {
  return {
    id: lesson.id,
    version: CONTENT_VERSION,
    kind: 'learn',
    name: lesson.name,
    theme: lesson.theme,
    seed: `lesson:${lesson.id}`,
    tiles: lesson.tiles,
    symbolIds: [...new Set(lesson.tiles.map((t) => t.sym))],
    parMs: null,
    difficulty: 1,
    metrics: { tiles: lesson.tiles.length, triples: lesson.tiles.length / 3, layers: 2, symbolKinds: 2, solverNodes: 0, solvable: true },
    star: [0, 0],
    config: { trayCapacity: 7, timeLimitMs: null, undo: false, hints: true, ranked: false },
  };
}
