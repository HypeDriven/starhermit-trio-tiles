// Sound, as the browser build's js/audio/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per logical event (pick, triple,
// invalid, undo, hint, win, lose, UI click; variants rotating), the captions
// for sound cues (handed to the screens), the quiet ambience (a pinkish
// filtered-noise wind bed, low-pass 420 Hz breathing with a 0.07 Hz LFO) and
// the generative music (pentatonic sine plucks from A2 on a 0.42 s grid whose
// density follows the tray's fullness, a triangle octave layer above half
// full). The browser build ran these as live oscillators; here the bed is
// rendered once into a seamless loop and each pluck once into a clip
// (OfflineAudioContext), played on the music bus (the runtime has no ambience
// bus) at the old buses' default balance (music 0.7 × 0.5, ambience 0.5 × 0.4).
// The synthesized stand-ins the old engine played while a sample decoded are not
// ported. The runtime's Options own the volumes, the mute and the voice limit.
// Clips load and the renders run in onStart; only starting the bed and the music
// waits for the mixer (in a browser, the first press).
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, SoundBank, type AudioClip, type Sound } from "starhermit:audio";
import { Rng } from "./game.ts";

const SFX: Record<string, string[]> = {
  pick: ["tile-pick-a", "tile-pick-b"], triple: ["triple-clear-a", "triple-clear-b"], invalid: ["invalid-deny-a", "invalid-deny-b"],
  undo: ["undo-swoop"], hint: ["hint-chime"], win: ["win-fanfare"], lose: ["lose-droop"], uiClick: ["ui-click-a", "ui-click-b"],
};
const CAPTIONS: Record<string, string> = { pick: "capPick", invalid: "capInvalid", undo: "capUndo", hint: "capHint", win: "capWin", lose: "capLose" };
const banks = new Map<string, SoundBank>();
let suspended = false;
let captionFn: ((key: string, vars?: Record<string, number>) => void) | null = null;
const rand = Rng.audioStream("trio:audio");
/** The screens' caption line (shown when Captions for sound cues is on). */
export function onCaption(fn: (key: string, vars?: Record<string, number>) => void): void { captionFn = fn; }
let captionsOn = false;
export function setCaptions(on: boolean): void { captionsOn = on; }
function caption(key: string, vars?: Record<string, number>): void { if (captionsOn && captionFn) captionFn(key, vars); }

function sfx(key: string): void {
  if (suspended || context.state !== "running") return;
  try { banks.get(key)?.play(); } catch { /* the mixer is full this frame: skip it */ }
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
const MUSIC = 0.7 * 0.5, AMB = 0.5 * 0.4 * 0.5;
// The bed: white noise through a two-pole low-pass close to the old leaky integrator (pink ×3, one pole at 71 Hz:
// within 1 dB up to 250 Hz), then a 420 Hz low-pass (Q 0.707 linear, −3 dB as this filter's Q reads) whose cutoff
// breathes ±160 Hz at 0.07 Hz, over one LFO period (~14.3 s). Filtered periodic noise is periodic once settled.
const BED_N = Math.round(RATE / 0.07);
const BED_MAKEUP = 2.8; // measured: rms .01604 as the old bed
async function renderBed(): Promise<AudioClip> {
  const settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + BED_N, RATE);
  const noise = off.createNoise({ seed: 0x1a2b3c4d, seconds: BED_N / RATE });
  const tilt = off.createBiquadFilter(); tilt.type = "lowpass"; tilt.frequency.value = 141; tilt.Q.value = -6.02;
  const lp = off.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 420; lp.Q.value = -3.01;
  const lfo = off.createOscillator(); lfo.frequency.value = 0.07;
  const depth = off.createGain(); depth.gain.value = 160;
  lfo.connect(depth).connect(lp.frequency); lfo.start();
  const gain = off.createGain(); gain.gain.value = AMB * BED_MAKEUP;
  noise.connect(tilt).connect(lp).connect(gain).connect(off.destination); noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}
// Plucks: gain 0→0.16 in 10 ms, exponential to 0.0001 at 1.6 s; the layer a triangle an octave up at 0.05 for 0.9 s.
const DEG = [0, 2, 4, 7, 9];
const freqOf = (deg: number, oct: number): number => (220 / 2) * Math.pow(2, (deg + 12 * oct) / 12);
/** The fifteen notes end to end in one context, sliced (at most 16 contexts). */
async function renderPlucks(tri: boolean): Promise<AudioClip[]> {
  const dur = tri ? 1.0 : 1.7, peak = (tri ? 0.05 : 0.16) * MUSIC, decay = tri ? 0.9 : 1.6, att = tri ? 0.02 : 0.01;
  const n = Math.round(RATE * dur);
  const off = new OfflineAudioContext(1, n * 15, RATE);
  for (let i = 0; i < 15; i++) {
    const at = (i * n) / RATE;
    const osc = off.createOscillator(); osc.type = tri ? "triangle" : "sine";
    osc.frequency.value = freqOf(DEG[i % 5]!, Math.floor(i / 5)) * (tri ? 2 : 1);
    const g = off.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + att);
    g.gain.exponentialRampToValueAtTime(0.0001 * MUSIC, at + decay);
    osc.connect(g).connect(off.destination);
    osc.start(at); osc.stop(at + dur);
  }
  const d = (await off.startRendering()).getChannelData(0);
  return Array.from({ length: 15 }, (_, i) => createClip([d.slice(i * n, (i + 1) * n)], RATE));
}
let plucks: AudioClip[] = [];
let layers: AudioClip[] = [];
let bedClip: AudioClip | null = null;
let bedVoice: Sound | null = null;
let music = false;
let nextIn = 0;
export function startMusic(): void { music = true; }
export function stopMusic(): void { music = false; }

const warn = (e: unknown): void => { console.warn(`audio: ${String(e)}`); };
/** Loads every clip at once and renders the bed and the plucks (onStart). */
export function loadSfx(): void {
  for (const [key, names] of Object.entries(SFX)) {
    void Promise.all(names.map((n) => loadClip(`sfx/${n}.opus`).catch((e: unknown) => { console.warn(`sfx ${n}: ${e instanceof Error ? e.message : String(e)}`); return null; }))).then((loaded) => {
      const list = loaded.filter((c) => c !== null);
      if (list.length) banks.set(key, new SoundBank({ clips: list, order: "sequence", bus: key === "uiClick" ? "interface" : "effects" }));
    });
  }
  renderBed().then((c) => { bedClip = c; }, warn);
  renderPlucks(false).then((c) => { plucks = c; }, warn);
  renderPlucks(true).then((c) => { layers = c; }, warn);
}

/** Each frame, once the mixer runs: the bed and the generative plucks. */
export function update(dt: number): void {
  if (context.state !== "running") return;
  if (bedClip && !bedVoice) {
    try { bedVoice = playClip(bedClip, { bus: "music", gain: suspended ? 0 : 1, loop: true }); } catch { bedVoice = null; }
  }
  if (!plucks.length || !layers.length) return;
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
