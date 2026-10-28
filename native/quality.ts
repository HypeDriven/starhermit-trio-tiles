// The look per graphics level: the browser build's four presets and budgets
// (js/render/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest
// GPU its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the particle multiplier scaled within the tier by the level
// (frame().levelIndex, at most 2×) as gfx.js budgetFor scaled it by the
// hardware level. The runtime owns the rest of what the old Graphics section
// did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout. The old per-category
// overrides are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";

export interface Budget {
  material: "lambert" | "standard" | "physical";
  texture: number;
  tileSeg: [number, number];
  propSeg: number;
  particles: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: "off" | "fxaa" | "smaa" | "msaa";
  reflections: boolean;
  particles: "low" | "medium" | "high";
  animated: boolean;
  detailed: boolean;
  budget: Budget;
}
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", reflections: false, particles: "low", animated: true, detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, particles: "medium", animated: true, detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 128, tileSeg: [1, 3], propSeg: 0.6, particles: 0.75, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", texture: 256, tileSeg: [2, 4], propSeg: 0.8, particles: 1, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", texture: 256, tileSeg: [2, 6], propSeg: 1, particles: 1, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", texture: 512, tileSeg: [3, 8], propSeg: 1.5, particles: 1.25, bloomRes: 1, aoRes: 1 },
};
/** gfx.js PARTICLES. */
export const PARTICLES = {
  low: { petals: 40, mist: 120, steam: 0, burst: 0.25 },
  medium: { petals: 90, mist: 300, steam: 24, burst: 0.6 },
  high: { petals: 160, mist: 520, steam: 48, burst: 1 },
};
export const PARTICLE_POOL = 2;
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b: Budget = { ...BUDGETS[preset], tileSeg: [...BUDGETS[preset].tileSeg] as [number, number] };
  const k = Math.min(2, Math.pow(1.4, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.particles = Math.min(PARTICLE_POOL, Math.round(b.particles * k * 100) / 100);
  return { preset, ...TABLE[preset], budget: b };
}
/** gfx.js particleCounts. */
export function particleCounts(l: Look): { petals: number; mist: number; steam: number; burst: number } {
  const pc = PARTICLES[l.particles], k = l.budget.particles;
  return { petals: Math.round(pc.petals * k), mist: Math.round(pc.mist * k), steam: Math.round(pc.steam * k), burst: Math.min(PARTICLE_POOL, pc.burst * k) };
}
