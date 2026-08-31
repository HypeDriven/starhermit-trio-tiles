/**
 * Audio engine — original short synthesized transients tied to logical
 * events, layered material impacts, quiet ambience, and an adaptive
 * generative music bed. Four independent buses (music / effects / ambience /
 * voice) feed the master. Pitch variants come from the seeded audio stream
 * so replays sound identical. Nothing here is required for play (captions
 * mirror every meaningful cue).
 *
 * Authored one-shot samples (sfx/<name>.opus, see sfx/manifest.json) are
 * preferred for the mapped events: they are fetched, decoded and cached
 * lazily on first use after the user-gesture unlock, and played through the
 * effects bus. The synthesized version stays as the fallback while a sample
 * is still loading or could not be fetched/decoded.
 */

import { audioStream } from '../rules/rng.js';

const PENTATONIC = [0, 2, 4, 7, 9]; // semitones
const BASE_FREQ = 220; // A3

/** Logical event (playEvent case / public method) -> authored sample basenames. */
const SFX = {
  pick: ['tile-pick-a', 'tile-pick-b'],
  triple: ['triple-clear-a', 'triple-clear-b'],
  invalid: ['invalid-deny-a', 'invalid-deny-b'],
  undo: ['undo-swoop'],
  hint: ['hint-chime'],
  win: ['win-fanfare'],
  lose: ['lose-droop'],
  uiClick: ['ui-click-a', 'ui-click-b'],
};

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.buses = {};
    this.rand = audioStream('trio:audio');
    this.onCaption = null; // (text) => void
    this._musicTimer = null;
    this._musicStep = 0;
    this._intensity = 0;
    this._started = false;
    this._sfx = new Map(); // basename -> { state: 'loading'|'ready'|'failed', buffer }
    this._sfxTurn = {}; // event key -> variant rotation counter
  }

  /** Must be called from a user gesture (autoplay policy). Idempotent. */
  unlock() {
    if (this._started) return;
    this._started = true;
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const master = this.ctx.createGain();
    master.connect(this.ctx.destination);
    this.buses = { master };
    for (const name of ['music', 'effects', 'ambience', 'voice']) {
      const g = this.ctx.createGain();
      g.connect(master);
      this.buses[name] = g;
    }
    this.applySettings(this.settings);
    this._startAmbience();
    this._startMusic();
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  applySettings(s) {
    this.settings = s;
    if (!this.ctx) return;
    const mute = s.muted ? 0 : 1;
    this.buses.master.gain.value = mute;
    this.buses.music.gain.value = s.music * 0.5;
    this.buses.effects.gain.value = s.effects;
    this.buses.ambience.gain.value = s.ambience * 0.4;
    this.buses.voice.gain.value = s.voice;
  }

  _caption(text) {
    if (this.settings.captions && this.onCaption) this.onCaption(text);
  }

  /** Short envelope oscillator blip. */
  _blip({ freq = 440, dur = 0.12, type = 'sine', gain = 0.3, bus = 'effects', attack = 0.004, detune = 0 }) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.buses[bus]);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** Filtered noise burst (material impact layer). */
  _thock({ dur = 0.09, freq = 1800, q = 1.2, gain = 0.25, bus = 'effects' }) {
    if (!this.ctx) return;
    if (!this._noiseBuffer) {
      const len = this.ctx.sampleRate * 0.5;
      this._noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this._noiseBuffer.getChannelData(0);
      // Seeded white noise — identical timbre across replays.
      let a = 0x2f6e2b1;
      for (let i = 0; i < len; i++) {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        data[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
      }
    }
    const t0 = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.buses[bus]);
    src.start(t0, this.rand.range(0, 0.3));
    src.stop(t0 + dur + 0.05);
  }

  _chime(step, { gain = 0.22, dur = 0.5, bus = 'effects' } = {}) {
    const semis = PENTATONIC[step % PENTATONIC.length] + 12 * Math.floor(step / PENTATONIC.length);
    const freq = BASE_FREQ * Math.pow(2, semis / 12);
    this._blip({ freq, dur, type: 'sine', gain, bus });
    this._blip({ freq: freq * 2, dur: dur * 0.6, type: 'sine', gain: gain * 0.3, bus });
    this._blip({ freq: freq * 2.99, dur: dur * 0.3, type: 'triangle', gain: gain * 0.12, bus });
  }

  /**
   * Prefer an authored sample for a logical event. Lazily fetches, decodes
   * and caches sfx/<name>.opus on first use (post-unlock); plays the cached
   * buffer through the effects bus (mute/volume apply via applySettings).
   * Variants rotate deterministically without touching the seeded stream.
   * Returns true when a sample actually played; false means the caller
   * should fall back to synthesis (still loading or failed).
   */
  _trySfx(key) {
    if (!this.ctx) return false;
    const names = SFX[key];
    if (!names) return false;
    const turn = (this._sfxTurn[key] = ((this._sfxTurn[key] ?? -1) + 1) % names.length);
    const name = names[turn];
    const entry = this._sfx.get(name);
    if (entry?.state === 'ready') {
      const src = this.ctx.createBufferSource();
      src.buffer = entry.buffer;
      src.connect(this.buses.effects);
      src.start();
      return true;
    }
    if (!entry) {
      this._sfx.set(name, { state: 'loading', buffer: null });
      fetch(`sfx/${name}.opus`)
        .then((res) => {
          if (!res.ok) throw new Error(`sfx ${name}: HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .then((bytes) => this.ctx.decodeAudioData(bytes))
        .then((buffer) => this._sfx.set(name, { state: 'ready', buffer }))
        .catch(() => this._sfx.set(name, { state: 'failed', buffer: null }));
    }
    return false;
  }

  /**
   * Map logical events to sound. Call with session events.
   */
  playEvent(ev, extra = {}) {
    const v = this.rand.range(-30, 30); // seeded pitch variant (cents)
    switch (ev.type) {
      case 'pick':
        if (!this._trySfx('pick')) {
          this._thock({ freq: 1400, gain: 0.22 });
          this._blip({ freq: 520 + v, dur: 0.07, type: 'triangle', gain: 0.12 });
        }
        this._caption('tile picked');
        break;
      case 'triple': {
        if (!this._trySfx('triple')) {
          const base = 4 + Math.min(ev.chain - 1, 4) * 2;
          this._chime(base, { gain: 0.2 });
          setTimeout(() => this._chime(base + 2, { gain: 0.18 }), 70);
          setTimeout(() => this._chime(base + 4, { gain: 0.2 }), 140);
          this._thock({ freq: 900, gain: 0.15, dur: 0.2 });
        }
        this._caption(ev.chain > 1 ? `combo ×${ev.chain}` : 'triple cleared');
        break;
      }
      case 'invalid':
        if (!this._trySfx('invalid')) {
          this._blip({ freq: 140, dur: 0.16, type: 'square', gain: 0.08 });
          this._thock({ freq: 300, gain: 0.12, dur: 0.12 });
        }
        this._caption('not allowed');
        break;
      case 'undo':
        if (!this._trySfx('undo')) {
          this._blip({ freq: 340, dur: 0.09, type: 'triangle', gain: 0.14 });
          setTimeout(() => this._blip({ freq: 260, dur: 0.1, type: 'triangle', gain: 0.12 }), 60);
        }
        this._caption('move undone');
        break;
      case 'hint':
        if (!this._trySfx('hint')) {
          this._chime(7, { gain: 0.12, dur: 0.3 });
        }
        this._caption('hint shown');
        break;
      case 'win':
        if (!this._trySfx('win')) {
          [0, 2, 4, 7, 9, 12].forEach((s, i) => setTimeout(() => this._chime(s, { gain: 0.22, dur: 0.7 }), i * 110));
        }
        this._caption('table cleared — you win');
        break;
      case 'lose':
        if (!this._trySfx('lose')) {
          this._blip({ freq: 196, dur: 0.8, type: 'sine', gain: 0.18 });
          setTimeout(() => this._blip({ freq: 147, dur: 1.0, type: 'sine', gain: 0.16 }), 200);
        }
        this._caption('round over');
        break;
      case 'tick':
        break;
    }
  }

  uiClick() {
    if (this._trySfx('uiClick')) return;
    this._blip({ freq: 660, dur: 0.05, type: 'triangle', gain: 0.1 });
  }

  /** Adaptive intensity 0..1 (tray danger drives music density). */
  setIntensity(x) {
    this._intensity = Math.max(0, Math.min(1, x));
  }

  _startAmbience() {
    if (!this.ctx) return;
    // Quiet filtered-noise wind bed with a slow LFO on the filter.
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    let a2 = 0x1a2b3c4d;
    for (let i = 0; i < len; i++) {
      a2 |= 0;
      a2 = (a2 + 0x6d2b79f5) | 0;
      let t = Math.imul(a2 ^ (a2 >>> 15), 1 | a2);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      const white = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
      last = (last + 0.02 * white) / 1.02; // pinkish
      d[i] = last * 3;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain).connect(f.frequency);
    const g = this.ctx.createGain();
    g.gain.value = 0.5;
    src.connect(f).connect(g).connect(this.buses.ambience);
    src.start();
    lfo.start();
  }

  _startMusic() {
    if (!this.ctx) return;
    // Generative pentatonic plucks on a slow clock; density follows
    // intensity. Lookahead scheduling, drift-safe.
    const stepDur = 0.42;
    let nextTime = this.ctx.currentTime + 0.1;
    const tick = () => {
      if (!this.ctx) return;
      while (nextTime < this.ctx.currentTime + 0.6) {
        const step = this._musicStep++;
        const density = 0.24 + this._intensity * 0.5;
        if (this.rand.next() < density) {
          const deg = [0, 2, 4, 7, 9][Math.floor(this.rand.next() * 5)] + 12 * (this.rand.next() < 0.3 ? 2 : this.rand.next() < 0.6 ? 1 : 0);
          const freq = (BASE_FREQ / 2) * Math.pow(2, deg / 12);
          const t0 = nextTime;
          const osc = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          g.gain.setValueAtTime(0, t0);
          g.gain.linearRampToValueAtTime(0.16, t0 + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6);
          osc.connect(g).connect(this.buses.music);
          osc.start(t0);
          osc.stop(t0 + 1.7);
          if (this._intensity > 0.5 && this.rand.next() < 0.4) {
            const osc2 = this.ctx.createOscillator();
            const g2 = this.ctx.createGain();
            osc2.type = 'triangle';
            osc2.frequency.value = freq * 2;
            g2.gain.setValueAtTime(0, t0);
            g2.gain.linearRampToValueAtTime(0.05, t0 + 0.02);
            g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
            osc2.connect(g2).connect(this.buses.music);
            osc2.start(t0);
            osc2.stop(t0 + 1);
          }
        }
        nextTime += stepDur;
      }
      this._musicTimer = setTimeout(tick, 200);
    };
    tick();
  }

  /** Suspend everything when the tab hides (spec: background behavior). */
  setBackgrounded(hidden) {
    if (!this.ctx) return;
    if (hidden) this.ctx.suspend().catch(() => {});
    else this.ctx.resume().catch(() => {});
  }
}
