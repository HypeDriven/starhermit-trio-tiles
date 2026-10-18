import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// js/render/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way here.
new Function('window', 'module', readFileSync(new URL('../js/render/gpu-level.js', import.meta.url), 'utf8'))(globalThis, undefined);
const {
  PRESETS, CATEGORIES, PARTICLES, detectPreset, detectLevel, presetForLevel, budgetFor, particleCounts, resolve, presetTier,
  choosePreset, describe, fromLegacyTier, LEVELS, BUDGETS, PARTICLE_POOL,
} = await import('../js/render/gfx.js');
import { GFX_STRINGS, pickLocale } from '../js/ui/gfx-strings.js';

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', DESK), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(detectPreset('', DESK), 'low', 'no WebGL');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(detectPreset('Apple M2', PHONE), 'balanced');
  assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budget table: explicit, never cheaper from Low to Ultra, particles scale with the level', () => {
  const keys = ['material', 'texture', 'tileSeg', 'propSeg', 'particles', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.notEqual(BUDGETS[p][k], undefined, `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) {
    const a = BUDGETS[PRESETS[i - 1]], b = BUDGETS[PRESETS[i]];
    for (const k of ['texture', 'propSeg', 'particles', 'bloomRes', 'aoRes']) assert.ok(b[k] >= a[k], `${PRESETS[i]}.${k}`);
    assert.ok(b.tileSeg[0] >= a.tileSeg[0] && b.tileSeg[1] >= a.tileSeg[1], `${PRESETS[i]}.tileSeg`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1]);
  assert.equal(budgetFor('high', 10).particles, BUDGETS.high.particles);
  assert.equal(budgetFor('high', 0).particles, BUDGETS.high.particles, 'a forced preset never drops below its budget');
  assert.ok(budgetFor('high', 13).particles > BUDGETS.high.particles);
  assert.ok(budgetFor('ultra', 20).particles <= PARTICLE_POOL);
  const r = resolve({ preset: 'balanced' }, 'low', 4);
  assert.equal(r.level, 4);
  assert.deepEqual(r.budget, budgetFor('balanced', 4));
  assert.deepEqual(particleCounts(r), { petals: PARTICLES.medium.petals, mist: PARTICLES.medium.mist, steam: PARTICLES.medium.steam, burst: PARTICLES.medium.burst });
  const lo = particleCounts(resolve({ preset: 'low' }, 'low', 0));
  assert.equal(lo.petals, Math.round(PARTICLES.low.petals * BUDGETS.low.particles));
});

test('resolve: auto uses the detected preset, explicit preset wins', () => {
  const a = resolve({}, 'low');
  assert.equal(a.preset, 'low');
  assert.equal(a.auto, true);
  assert.equal(a.post, false, 'Low renders without a post chain');
  assert.equal(a.shadows, 'off');
  const h = resolve({ preset: 'high' }, 'low');
  assert.equal(h.preset, 'high');
  assert.equal(h.auto, false);
  assert.equal(h.shadows, presetTier('high', 'shadows'));
  assert.equal(h.post, true);
  assert.equal(resolve({ preset: 'bogus' }, undefined).preset, 'balanced');
});

test('resolve: per-category overrides apply and invalid ones fall back', () => {
  const r = resolve({ preset: 'high', bloom: 'off', shadows: 'nonsense', particles: 'low' }, 'low');
  assert.equal(r.bloom, 'off');
  assert.equal(r.shadows, presetTier('high', 'shadows'));
  assert.equal(r.particles, 'low');
  for (const cat of Object.keys(CATEGORIES)) assert.ok(CATEGORIES[cat].includes(r[cat]), cat);
  // Low + an antialias override needs the post chain.
  assert.equal(resolve({ preset: 'low', antialias: 'fxaa' }, 'low').post, true);
});

test('resolve: render scale is clamped to 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }, 'low').renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }, 'low').renderScale, 0.5);
  assert.equal(resolve({ preset: 'high', render_scale: 1.5 }, 'low').scale, 1.5);
  assert.equal(resolve({ preset: 'low' }, 'low').dprCap, 1);
  assert.equal(resolve({ preset: 'balanced' }, 'low').dprCap, 1.5);
  assert.equal(resolve({ preset: 'ultra' }, 'low').dprCap, 2);
});

test('resolve: adaptive defaults on, frame rate readout defaults off', () => {
  const r = resolve({}, 'high');
  assert.equal(r.adaptive, true);
  assert.equal(r.showFps, false);
  const s = resolve({ adaptive: false, show_fps: true }, 'high');
  assert.equal(s.adaptive, false);
  assert.equal(s.showFps, true);
});

test('choosing a preset clears overrides but keeps scale and toggles', () => {
  const saved = { preset: 'high', bloom: 'off', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true };
  const next = choosePreset(saved, 'low');
  assert.deepEqual(next, { preset: 'low', render_scale: 1.5, adaptive: false, show_fps: true });
  assert.equal(choosePreset({}, 'nope').preset, 'auto');
  for (const p of PRESETS) assert.equal(choosePreset(saved, p).bloom, undefined);
});

test('legacy graphicsTier maps onto presets', () => {
  assert.equal(fromLegacyTier('low'), 'low');
  assert.equal(fromLegacyTier('medium'), 'balanced');
  assert.equal(fromLegacyTier('high'), 'high');
  assert.equal(fromLegacyTier('auto'), 'auto');
});

test('describe summarises the cost', () => {
  const s = describe(resolve({ preset: 'high' }, 'low'), [1280, 800]);
  assert.match(s, /2048² shadows/);
  assert.match(s, /SMAA/);
  assert.match(s, /1280×800 px/);
  assert.match(describe(resolve({ preset: 'low' }, 'low')), /no shadows.*no anti-aliasing/);
});

test('every locale has every Graphics string', () => {
  const required = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  const en = GFX_STRINGS['en-US'];
  for (const loc of required) {
    const t = GFX_STRINGS[loc];
    assert.ok(t, loc);
    for (const k of Object.keys(en)) assert.ok(t[k] != null, `${loc}.${k}`);
    for (const p of PRESETS) assert.ok(t.presets[p], `${loc} preset ${p}`);
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      assert.ok(t.categories[cat], `${loc} category ${cat}`);
      for (const tier of tiers) assert.ok(t.tiers[tier], `${loc} tier ${tier}`);
    }
    assert.ok(describe(resolve({ preset: 'ultra' }, 'low'), [10, 10], t.words).length > 0);
  }
  assert.equal(pickLocale('en-GB'), 'en-GB');
  assert.equal(pickLocale('en-AU'), 'en-GB');
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('es-ES'), 'es-ES');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('fr-BE'), 'fr-FR');
  assert.equal(pickLocale('pt-PT'), 'pt-BR');
  assert.equal(pickLocale('ja-JP'), 'en-US');
});
