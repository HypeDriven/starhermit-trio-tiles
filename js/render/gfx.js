/**
 * Graphics quality model — presets, per-category overrides, StarHermit
 * hardware-level detection, per-preset budgets and a cost summary. Pure (no three.js), so the settings panel, the renderer and
 * the unit tests agree on what every setting means. Nothing here alters rules,
 * picking or the visibility of tiles; it only chooses how the table is drawn.
 */

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],
  particles: ['low', 'medium', 'high'],
  background: ['static', 'animated'],
  detail: ['plain', 'detailed'],
};

// Each preset is a row of tiers plus a render scale (multiplies the capped
// device pixel ratio) and a device-pixel-ratio cap.
const TABLE = {
  low: { scale: 0.85, dprCap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off', reflections: 'off', particles: 'low', background: 'animated', detail: 'plain' },
  balanced: { scale: 1, dprCap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', particles: 'medium', background: 'animated', detail: 'detailed' },
  high: { scale: 1, dprCap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { scale: 1.25, dprCap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

// Ambient particle budgets per tier (petals, mist sprites, teapot steam, burst fraction).
export const PARTICLES = {
  low: { petals: 40, mist: 120, steam: 0, burst: 0.25 },
  medium: { petals: 90, mist: 300, steam: 24, burst: 0.6 },
  high: { petals: 160, mist: 520, steam: 48, burst: 1 },
};

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 =
// RTX 5090; js/render/gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low
// from 0, Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  const sys = { webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') };
  if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
  return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Tiles, symbols, hit
 * areas and rules are identical on every preset — only visuals change.
 *   material   tiles, table and tea set: lambert (Low) / standard (Balanced) / physical lacquer (High, Ultra)
 *   texture    tile face + bump texture size in px (one pair per symbol)
 *   tileSeg    tile bevel and corner curve segments [bevelSegments, curveSegments]
 *   propSeg    multiplies teapot, cup and cloud segments
 *   particles  multiplies the Particles tier's petals, mist, steam and burst counts, scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', texture: 128, tileSeg: [1, 3], propSeg: 0.6, particles: 0.75, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', texture: 256, tileSeg: [2, 4], propSeg: 0.8, particles: 1, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', texture: 256, tileSeg: [2, 6], propSeg: 1, particles: 1, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', texture: 512, tileSeg: [3, 8], propSeg: 1.5, particles: 1.25, bloomRes: 1, aoRes: 1 },
};
/** Particle pools are allocated at this multiple of the High tier's counts. */
export const PARTICLE_POOL = 2;

/** A preset's concrete budget for a hardware level (the particle multiplier scales ≤ 2× within the preset). */
export function budgetFor(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
  b.particles = Math.min(PARTICLE_POOL, Math.round(b.particles * k * 100) / 100);
  return b;
}

/** Concrete particle counts for a resolved setting: the Particles tier × the preset's multiplier. */
export function particleCounts(r) {
  const pc = PARTICLES[r.particles] || PARTICLES.medium, k = r.budget.particles;
  return {
    petals: Math.round(pc.petals * k), mist: Math.round(pc.mist * k), steam: Math.round(pc.steam * k),
    burst: Math.min(PARTICLE_POOL, pc.burst * k),
  };
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, renderScale, scale: row.scale * renderScale, dprCap: row.dprCap };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; Low renders directly.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias !== 'off';
  return out;
}

/** Choosing a preset clears every per-category override (scale and toggles stay). */
export function choosePreset(saved, preset) {
  const s = saved || {};
  const out = { preset: preset === 'auto' || PRESETS.includes(preset) ? preset : 'auto' };
  if (s.render_scale != null) out.render_scale = s.render_scale;
  if (s.adaptive != null) out.adaptive = s.adaptive;
  if (s.show_fps != null) out.show_fps = s.show_fps;
  return out;
}

/** Map the legacy single-select `graphicsTier` setting onto a preset. */
export function fromLegacyTier(tier) {
  return { low: 'low', medium: 'balanced', high: 'high' }[tier] ?? 'auto';
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

const EN_WORDS = {
  noShadows: 'no shadows',
  shadows: (n) => `${n}² shadows`,
  ao: 'ambient occlusion',
  aoHigh: 'full ambient occlusion',
  bloom: 'bloom',
  noAA: 'no anti-aliasing',
  reflections: 'reflections',
  particles: { low: 'few particles', medium: 'some particles', high: 'full particles' },
};

/** One-line cost summary: "2048² shadows · ambient occlusion · bloom · SMAA · 1280×800 px". */
export function describe(r, pixels, words = EN_WORDS) {
  const w = { ...EN_WORDS, ...words };
  const parts = [
    r.shadows === 'off' ? w.noShadows : w.shadows(SHADOW_MAP[r.shadows]),
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoHigh : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.reflections === 'on' ? w.reflections : null,
    w.particles[r.particles],
    r.antialias === 'off' ? w.noAA : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
