// The save paths native/platform.ts builds on (signed-in flows cannot run here):
// SaveStore over a one-key storage (the engine save), the browser build's cloud
// document merged in as the foreign slot, two devices' copies merged on a
// conflict, the old settings KV values the game keeps, and the baked grain map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SaveStore, mergeSaveDocs } from '../js/session/storage.js';
import { materializeLevel, JOURNEY } from '../js/rules/content.js';
import { pickLegacy } from '../js/migrate.js';
import { grainPng } from '../tools/bake-grain.mjs';

function oneKey() {
  let v = null;
  return { getItem: (k) => (k === 'trio-tiles/save' ? v : null), setItem: (k, x) => { if (k === 'trio-tiles/save') v = x; }, peek: () => v };
}
const result = (score, status = 'won') => ({ sessionId: 's-' + score, status, score, components: { triples: 4 }, elapsedMs: 1000 });

test('a store round-trips through the one-key storage', () => {
  const st = oneKey();
  const a = new SaveStore(st);
  a.recordRound(result(500), materializeLevel(JOURNEY[0]));
  const b = new SaveStore(st);
  assert.equal(b.doc.progression.journey['j1-1'].bestScore, 500);
  assert.equal(b.doc.progression.roundsWon, 1);
});
test('the browser build\'s cloud document merges into a fresh device', () => {
  const old = new SaveStore(oneKey());
  old.recordRound(result(640), materializeLevel(JOURNEY[0]));
  old.unlockAchievement('first_clear');
  const foreign = JSON.parse(JSON.stringify(old.doc));
  const fresh = new SaveStore(oneKey());
  const r = fresh.mergeCloud(foreign);
  assert.equal(r.status, 'merged');
  assert.equal(fresh.doc.progression.journey['j1-1'].stars > 0, true);
  assert.ok(fresh.doc.achievements.first_clear);
  assert.equal(fresh.mergeCloud({ junk: 1 }).status, 'rejected');
});
test('two devices merge keeping the best of each', () => {
  const a = new SaveStore(oneKey()), b = new SaveStore(oneKey());
  a.recordRound(result(300), materializeLevel(JOURNEY[0]));
  b.recordRound(result(700), materializeLevel(JOURNEY[0]));
  b.recordRound(result(200), materializeLevel(JOURNEY[1]));
  const m = mergeSaveDocs(a.doc, b.doc);
  assert.equal(m.progression.journey['j1-1'].bestScore, 700);
  assert.ok(m.progression.journey['j1-2']);
});
test('old settings KV: only the game\'s own options, well typed', () => {
  assert.deepEqual(pickLegacy({ music: 0.2, colorblindPalette: 'tritanopia', leftHanded: true, cameraView: 'sideways', captions: 'yes', themeChoice: 'dusk' }),
    { colorblindPalette: 'tritanopia', leftHanded: true, themeChoice: 'dusk' });
});
test('assets/grain.png is the current bake', () => {
  assert.ok(readFileSync(new URL('../assets/grain.png', import.meta.url)).equals(grainPng()));
});
