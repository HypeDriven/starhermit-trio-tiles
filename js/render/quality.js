/**
 * Quality tiers — mechanism-backed knobs only (shadows, environment detail,
 * particle counts, antialiasing, render scale). Tiers never alter rules or
 * hide hazards. Dynamic degradation lowers render scale before touching the
 * simulation, and UI text stays at native resolution regardless.
 */

export const TIERS = {
  low: {
    id: 'low',
    dprCap: 1,
    shadows: false,
    shadowMapSize: 512,
    particles: 0.25,
    islands: 2,
    petals: 40,
    mist: 120,
    renderScale: 0.85,
    antialias: false,
    envDetail: 0.3,
  },
  medium: {
    id: 'medium',
    dprCap: 1.5,
    shadows: true,
    shadowMapSize: 1024,
    particles: 0.6,
    islands: 4,
    petals: 90,
    mist: 300,
    renderScale: 1,
    antialias: true,
    envDetail: 0.65,
  },
  high: {
    id: 'high',
    dprCap: 2,
    shadows: true,
    shadowMapSize: 2048,
    particles: 1,
    islands: 6,
    petals: 160,
    mist: 520,
    renderScale: 1,
    antialias: true,
    envDetail: 1,
  },
};

export function detectTier() {
  try {
    const ua = navigator.userAgent || '';
    const mobile = /Mobi|Android|iPhone|iPad/i.test(ua);
    const mem = navigator.deviceMemory ?? 8;
    const cores = navigator.hardwareConcurrency ?? 8;
    if (mobile && (mem <= 4 || cores <= 4)) return 'low';
    if (mobile) return 'medium';
    if (mem <= 4 || cores <= 2) return 'medium';
    return 'high';
  } catch {
    return 'medium';
  }
}

/**
 * Rolling frame-rate monitor. Degrades render scale step-by-step before
 * recommending a tier drop; upgrades only after sustained headroom.
 */
export class FrameMonitor {
  constructor(onChange) {
    this.onChange = onChange;
    this.samples = [];
    this.renderScaleSteps = [1, 0.9, 0.78, 0.66];
    this.scaleIndex = 0;
    this.cooldown = 0;
    this.tierDropVotes = 0;
  }

  frame(dtMs) {
    this.samples.push(dtMs);
    if (this.samples.length > 90) this.samples.shift();
    this.cooldown -= dtMs;
    if (this.samples.length < 60 || this.cooldown > 0) return;
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    if (avg > 19 && this.scaleIndex < this.renderScaleSteps.length - 1) {
      this.scaleIndex++;
      this.cooldown = 2000;
      this.samples.length = 0;
      this.onChange({ renderScaleFactor: this.renderScaleSteps[this.scaleIndex] });
    } else if (avg > 24 && this.scaleIndex === this.renderScaleSteps.length - 1) {
      this.tierDropVotes++;
      if (this.tierDropVotes >= 3) {
        this.tierDropVotes = 0;
        this.cooldown = 4000;
        this.onChange({ suggestTierDrop: true });
      }
    } else if (avg < 12 && this.scaleIndex > 0) {
      // Sustained headroom: restore one step.
      this.scaleIndex--;
      this.cooldown = 5000;
      this.samples.length = 0;
      this.onChange({ renderScaleFactor: this.renderScaleSteps[this.scaleIndex] });
    }
  }
}
