import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS,
  CATEGORIES,
  detectPreset,
  resolve,
  presetTier,
  choosePreset,
  describe,
  fromLegacyTier,
} from '../js/render/gfx.js';
import { GFX_STRINGS, pickLocale } from '../js/ui/gfx-strings.js';

test('detectPreset maps GPU strings to presets', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 650'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
  // Touch/mobile devices are capped at balanced.
  assert.equal(detectPreset('Apple M2', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
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
