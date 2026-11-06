// The look per graphics level. The engine owns shadows, ambient occlusion, bloom,
// the grade and the anti-aliasing (levelSettings(): the frame's level); the
// browser build's art columns and budgets (js/render/gfx.js TABLE / BUDGETS) stay
// keyed by the runtime's quality tier (frame().quality), with the particle
// multiplier scaled within the tier by the level's particle budget (at most 2×).
// The runtime owns the rest of what the old Graphics section did: Auto and the
// level choice, render scale and the pixel-ratio cap, adaptive resolution, the
// frame-rate limit and readout. The old per-category overrides are not offered
// (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";

export interface Budget {
  material: "lambert" | "standard" | "physical";
  texture: number;
  tileSeg: [number, number];
  propSeg: number;
  particles: number;
}
export interface Look {
  preset: QualityTier;
  /** The level's shadow map size, 0 = off. */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution, null = off. */
  bloom: number | null;
  grade: boolean;
  antialias: "off" | "fxaa" | "smaa" | "msaa";
  reflections: boolean;
  particles: "low" | "medium" | "high";
  animated: boolean;
  detailed: boolean;
  budget: Budget;
}
const ART: Record<QualityTier, Pick<Look, "reflections" | "particles" | "animated" | "detailed">> = {
  low: { reflections: false, particles: "low", animated: true, detailed: false },
  balanced: { reflections: true, particles: "medium", animated: true, detailed: true },
  high: { reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 128, tileSeg: [1, 3], propSeg: 0.6, particles: 0.75 },
  balanced: { material: "standard", texture: 256, tileSeg: [2, 4], propSeg: 0.8, particles: 1 },
  high: { material: "physical", texture: 256, tileSeg: [2, 6], propSeg: 1, particles: 1 },
  ultra: { material: "physical", texture: 512, tileSeg: [3, 8], propSeg: 1.5, particles: 1.25 },
};
/** gfx.js PARTICLES. */
export const PARTICLES = {
  low: { petals: 40, mist: 120, steam: 0, burst: 0.25 },
  medium: { petals: 90, mist: 300, steam: 24, burst: 0.6 },
  high: { petals: 160, mist: 520, steam: 48, burst: 1 },
};
export const PARTICLE_POOL = 2;
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = BUDGETS[preset];
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: { ...b, tileSeg: [...b.tileSeg] as [number, number], texture: Math.min(b.texture, s.maxTextureSize), particles: Math.min(PARTICLE_POOL, Math.round(b.particles * k * 100) / 100) },
  };
}
/** gfx.js particleCounts. */
export function particleCounts(l: Look): { petals: number; mist: number; steam: number; burst: number } {
  const pc = PARTICLES[l.particles], k = l.budget.particles;
  return { petals: Math.round(pc.petals * k), mist: Math.round(pc.mist * k), steam: Math.round(pc.steam * k), burst: Math.min(PARTICLE_POOL, pc.burst * k) };
}
