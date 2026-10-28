// Sound, as the browser build's js/audio/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per logical event (pick, triple,
// invalid, undo, hint, win, lose, UI click; variants rotating), the captions
// for sound cues (handed to the screens), the quiet ambience (a pinkish
// filtered-noise wind bed, low-pass 420 Hz breathing with a 0.07 Hz LFO) and
// the generative music (pentatonic sine plucks from A2 on a 0.42 s grid whose
// density follows the tray's fullness, a triangle octave layer above half
// full). The browser build ran these as live oscillators; here the bed is
// rendered once into a seamless loop and each pluck once into a clip (a slice
// a frame: the native interpreter is slow), played on the music bus (the
// runtime has no ambience bus) at the old buses' default balance (music
// 0.7 × 0.5, ambience 0.5 × 0.4). The synthesized stand-ins the old engine
// played while a sample decoded are not ported. The runtime's Options own
// the volumes, the mute and the voice limit. Clips load once the mixer runs
// (natively at once, in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { Rng } from "./game.ts";

const SFX: Record<string, string[]> = {
  pick: ["tile-pick-a", "tile-pick-b"], triple: ["triple-clear-a", "triple-clear-b"], invalid: ["invalid-deny-a", "invalid-deny-b"],
  undo: ["undo-swoop"], hint: ["hint-chime"], win: ["win-fanfare"], lose: ["lose-droop"], uiClick: ["ui-click-a", "ui-click-b"],
};
const CAPTIONS: Record<string, string> = { pick: "capPick", invalid: "capInvalid", undo: "capUndo", hint: "capHint", win: "capWin", lose: "capLose" };
const clips = new Map<string, AudioClip>();
const queue: string[] = Object.values(SFX).flat();
const turn: Record<string, number> = {};
let loading = false;
let suspended = false;
let captionFn: ((key: string, vars?: Record<string, number>) => void) | null = null;
const rand = Rng.audioStream("trio:audio");
/** The screens' caption line (shown when Captions for sound cues is on). */
export function onCaption(fn: (key: string, vars?: Record<string, number>) => void): void { captionFn = fn; }
let captionsOn = false;
export function setCaptions(on: boolean): void { captionsOn = on; }
function caption(key: string, vars?: Record<string, number>): void { if (captionsOn && captionFn) captionFn(key, vars); }

function sfx(key: string): void {
  const names = SFX[key];
  if (!names) return;
  const t = (turn[key] = ((turn[key] ?? -1) + 1) % names.length);
  const clip = clips.get(names[t]!);
  if (!clip || suspended || context.state !== "running") return;
  try { playClip(clip, { bus: key === "uiClick" ? "interface" : "effects" }); } catch { clips.delete(names[t]!); queue.push(names[t]!); }
}
/** audio.js playEvent. */
export function playEvent(ev: { type: string; chain?: number }): void {
  if (ev.type === "tick") return;
  rand.range(-30, 30); // the seeded pitch variant the synth fallback used (keeps the stream as before)
  if (ev.type === "triple") { sfx("triple"); caption((ev.chain ?? 1) > 1 ? "capCombo" : "capTriple", { n: ev.chain ?? 1 }); return; }
  if (!SFX[ev.type]) return;
  sfx(ev.type);
  if (CAPTIONS[ev.type]) caption(CAPTIONS[ev.type]!);
}
export function uiClick(): void { sfx("uiClick"); }
let intensity = 0;
export function setIntensity(x: number): void { intensity = Math.max(0, Math.min(1, x)); }
export function setSuspended(on: boolean): void {
  if (on === suspended) return;
  suspended = on;
  try { bedVoice?.fade(on ? 0 : 1, 0.2); } catch { /* gone */ }
}

// -- synthesis into clips --------------------------------------------------------------------
const RATE = 22050;
const SINE_N = 4096;
const SINE = new Float32Array(SINE_N + 1);
for (let i = 0; i <= SINE_N; i++) SINE[i] = Math.sin((2 * Math.PI * i) / SINE_N);
const sin1 = (phase: number): number => { const p = (phase - Math.floor(phase)) * SINE_N, i = p | 0, f = p - i; return SINE[i]! + (SINE[i + 1]! - SINE[i]!) * f; };
const tri1 = (phase: number): number => { const p = phase - Math.floor(phase); return p < 0.25 ? p * 4 : p < 0.75 ? 2 - p * 4 : p * 4 - 4; };
const MUSIC = 0.7 * 0.5, AMB = 0.5 * 0.4 * 0.5;
// The bed: 2 s of seeded pink-ish noise (×3), through a 420 Hz low-pass whose cutoff breathes ±160 Hz at 0.07 Hz;
// rendered over one LFO period (~14.3 s) so it loops seamlessly.
const BED_N = Math.round(RATE / 0.07);
const bed = new Float32Array(BED_N);
let bedPos = 0;
let nState = 0x1a2b3c4d, pink = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
function white(): number {
  nState |= 0; nState = (nState + 0x6d2b79f5) | 0;
  let t = Math.imul(nState ^ (nState >>> 15), 1 | nState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
}
function renderBed(count: number): boolean {
  const end = Math.min(BED_N, bedPos + count);
  for (; bedPos < end; bedPos++) {
    pink = (pink + 0.02 * white()) / 1.02;
    const x = pink * 3;
    const fc = 420 + 160 * Math.sin((2 * Math.PI * 0.07 * bedPos) / RATE);
    const w = (2 * Math.PI * fc) / RATE, al = Math.sin(w) / (2 * Math.SQRT1_2), c = Math.cos(w), a0 = 1 + al;
    const y = ((1 - c) / 2 / a0) * x + ((1 - c) / a0) * x1 + ((1 - c) / 2 / a0) * x2 - ((-2 * c) / a0) * y1 - ((1 - al) / a0) * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    bed[bedPos] = y * AMB;
  }
  return bedPos >= BED_N;
}
// Plucks: gain 0→0.16 in 10 ms, exponential to 0.0001 at 1.6 s; the layer a triangle an octave up at 0.05 for 0.9 s.
const DEG = [0, 2, 4, 7, 9];
const freqOf = (deg: number, oct: number): number => (220 / 2) * Math.pow(2, (deg + 12 * oct) / 12);
function renderPluck(f: number, tri: boolean): Float32Array {
  const dur = tri ? 1.0 : 1.7, peak = tri ? 0.05 : 0.16, decay = tri ? 0.9 : 1.6, att = tri ? 0.02 : 0.01;
  const out = new Float32Array(Math.round(RATE * dur));
  const k = Math.log(0.0001 / peak) / (decay - att);
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const g = t < att ? (peak * t) / att : peak * Math.exp(k * Math.min(t - att, decay - att));
    out[i] = (tri ? tri1(f * t) : sin1(f * t)) * g * MUSIC;
  }
  return out;
}
const plucks: AudioClip[] = [];
const layers: AudioClip[] = [];
let bedClip: AudioClip | null = null;
let bedVoice: Sound | null = null;
let music = false;
let nextIn = 0;
export function startMusic(): void { music = true; }
export function stopMusic(): void { music = false; }

/** Each frame: clips one at a time once the mixer runs, then the bed and the generative plucks. */
export function update(dt: number): void {
  if (context.state !== "running") return;
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => {
        console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`);
        loading = false;
      });
    }
    return;
  }
  if (loading) return;
  if (!bedClip) {
    if (!renderBed(9000)) return;
    try { bedClip = createClip([bed], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); bedPos = 0; }
    return;
  }
  if (plucks.length < 15) {
    const i = plucks.length;
    try { plucks.push(createClip([renderPluck(freqOf(DEG[i % 5]!, Math.floor(i / 5)), false)], RATE)); } catch (e) { console.warn(`audio: ${String(e)}`); }
    return;
  }
  if (layers.length < 15) {
    const i = layers.length;
    try { layers.push(createClip([renderPluck(freqOf(DEG[i % 5]!, Math.floor(i / 5)) * 2, true)], RATE)); } catch (e) { console.warn(`audio: ${String(e)}`); }
    return;
  }
  if (!bedVoice) {
    try { bedVoice = playClip(bedClip, { bus: "music", gain: suspended ? 0 : 1, loop: true }); } catch { bedVoice = null; }
    return;
  }
  // audio.js _startMusic: a step every 0.42 s
  nextIn -= dt;
  if (nextIn > 0) return;
  nextIn += 0.42;
  if (nextIn < 0) nextIn = 0.42;
  if (!music || suspended) return;
  const density = 0.24 + intensity * 0.5;
  if (rand.next() >= density) return;
  const deg = Math.floor(rand.next() * 5);
  const oct = rand.next() < 0.3 ? 2 : rand.next() < 0.6 ? 1 : 0;
  try { playClip(plucks[oct * 5 + deg]!, { bus: "music" }); } catch { /* busy */ }
  if (intensity > 0.5 && rand.next() < 0.4) { try { playClip(layers[oct * 5 + deg]!, { bus: "music" }); } catch { /* busy */ } }
}
