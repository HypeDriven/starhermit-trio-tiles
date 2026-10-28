// Trio Tiles on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content, solver, session and save
// document are the browser build's js/ modules, unchanged; this module is
// what js/main.js did around them — the state machine (title → modes →
// setup → active ⇄ paused → resolving → results → next), the 250 ms rules
// clock on the runtime's fixed steps, every mode (Learn, Journey, the Daily
// Steep, Practice, Challenge, Score Chase), picks by pointer / touch (tap vs
// drag thresholds, hold to confirm), the keyboard's focus cycling over the
// available tiles, pads, undo, hints, the camera reset, the lesson steps,
// results with stars, achievements, the local boards and the score post, and
// the lifecycle (a hidden window pauses the round). Screens are drawn by
// screens.ts (starhermit:ui), the table by render.ts (starhermit:scene).
import { frame, onPreferencesChange, onRender, onResume, onStart, onSuspend, onFixedUpdate, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { clipboard } from "starhermit:engine";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { Content, Engine, SessionClass, type Lesson, type Level, type LevelDef, type RulesEvent, type Session } from "./game.ts";
import * as audio from "./audio.ts";
import * as hints from "./hint.ts";
import { S, T, fmtMs, lessonText, levelName, symbolName, tn } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type Screen = "title" | "modes" | "setup" | "help" | "results" | "pause" | "rename" | null;
export type Phase = "title" | "mode-select" | "setup" | "active" | "paused" | "resolving" | "results";
export interface Round { mode: string; level: Level; lesson: Lesson | null; stepIndex: number }
export interface ResultsSpec {
  won: boolean; reasonText: string; rows: { key: string; count?: number; value: number }[]; total: number; stars: number;
  achievements: { name: string; description: string }[]; board: { key: string; vars?: Record<string, string | number>; platform?: boolean };
  nextLabel: string;
}
export interface BoardView { board: string; loading: boolean; global: platform.Entry[] | null; me: number | null; failed: boolean }

const STEP_RATE = 60;
const TICK_MS = 250;
const TICK_STEPS = 15; // 250 ms at 60 Hz
export const app = {
  phase: "title" as Phase,
  screen: "title" as Screen,
  settingsOnly: false,
  openedFrame: 0,
  focusNext: null as string | null,
  setupMode: null as string | null,
  round: null as Round | null,
  session: null as Session | null,
  focusIndex: -1,
  results: null as ResultsSpec | null,
  helpReturn: null as string | null,
  boardFriends: false,
  boardView: null as BoardView | null,
  tutorial: null as string | null,
  mirrorOpen: false,
  caption: null as { text: string; until: number } | null,
  thinking: false,
  canUndo: false,
  canHint: false,
};
export const fresh = (): boolean => frame().frame !== app.openedFrame;
const now = (): number => frame().time;
export const settings = (): ReturnType<typeof gs> => gs();
const gs = () => platform.store.settings;

// ------------------------------------------------------------------ helpers
const spoken: string[] = [];
/** ui.announce (the old live regions): one announcement a frame, joined. */
export function announce(text: string): void { if (text) spoken.push(text); }
function flushAnnouncements(): void {
  if (!spoken.length) return;
  const text = spoken.splice(0).join(" ").slice(0, 500);
  try { ui.announce(text); } catch { /* busy */ }
}
/** ui.js caption: 2.6 s. */
export function caption(text: string): void { app.caption = { text, until: now() + 2.6 }; announce(text); }
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built. */
export function later(fn: () => void): void { pending.push(fn); }
export function open(s: Screen, focus: string | null = null): void {
  app.screen = s;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
}

// ------------------------------------------------------------------ navigation (main.js _nav, _openMode)
export function goTitle(): void {
  app.phase = "title";
  app.setupMode = null;
  app.round = null;
  app.session = null;
  app.results = null;
  app.tutorial = null;
  app.thinking = false;
  hints.cancel();
  render.clearBoard();
  render.setTheme(themeFor(null));
  open("title", "btn-play");
}
export function nav(target: string): void {
  if (target === "back") {
    if (app.helpReturn === "pause" && app.phase === "paused") { app.helpReturn = null; open("pause", "btn-resume"); return; }
    target = "title";
  }
  app.helpReturn = null;
  if (target === "title") { goTitle(); return; }
  if (target === "modes") { app.phase = "mode-select"; app.setupMode = null; open("modes"); return; }
  if (target === "help") { open("help"); return; }
}
export function play(): void { audio.uiClick(); app.phase = "mode-select"; open("modes"); }
export function openMode(mode: string): void {
  audio.uiClick();
  app.phase = "setup";
  app.setupMode = mode;
  if (mode === "boards") app.boardView = null;
  open("setup");
}
export function openSettings(): void { app.settingsOnly = true; open("pause", "btn-resume"); }
export function openHelpFromPause(): void { app.helpReturn = "pause"; open("help"); }

// ------------------------------------------------------------------ setup picks (main.js _setupPicked)
export function setupPicked(id: string): void {
  audio.uiClick();
  const [kind, rest] = [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)];
  try {
    if (kind === "lesson") { startLesson(Content.LESSONS.find((l) => l.id === rest) ?? null); return; }
    if (kind === "journey") { startLevel(Content.JOURNEY.find((s) => s.id === rest) ?? null, "journey"); return; }
    if (kind === "practice") { startLevel(Content.practiceLevel(rest, "p:" + Date.now()), "practice"); return; }
    if (kind === "challenge") { startLevel(Content.CHALLENGES.find((c) => c.id === rest) ?? null, "challenge"); return; }
    if (kind === "board") { showBoard(rest); return; }
    if (kind === "daily") { startLevel(Content.dailyLevel(Content.todayUTC(platform.now())), "daily"); return; }
  } catch (e) {
    caption(T("setupError", { error: e instanceof Error ? e.message : String(e) }));
  }
}
export function startLesson(lesson: Lesson | null): void {
  if (!lesson) return;
  startRound(Content.lessonLevel(lesson), "learn", lesson);
}
function startLevel(level: LevelDef | null, mode: string): void { if (level) startRound(level, mode, null); }
function themeFor(level: Level | null): string {
  const s = settings();
  const unlocked = platform.store.doc.progression.unlockedThemes;
  if (s.themeChoice !== "auto" && unlocked.includes(s.themeChoice)) return s.themeChoice;
  return level?.theme ?? "dawn";
}
/** main.js _startRound: materialize (validating) content, build the board and session, enter play. */
export function startRound(def: LevelDef, mode: string, lesson: Lesson | null): void {
  const level = (def.tiles ? def : Content.materializeLevel(def)) as Level;
  render.setTheme(themeFor(level));
  const s = settings();
  app.session = new SessionClass(level, { assists: { timingAssist: s.timingAssist } });
  app.round = { mode, level, lesson, stepIndex: 0 };
  app.results = null;
  app.setupMode = null;
  app.focusIndex = -1;
  app.thinking = false;
  hints.cancel();
  render.buildBoard(level, app.session.state);
  tickIn = TICK_STEPS;
  app.screen = null;
  app.openedFrame = frame().frame;
  ui.setFocus(null);
  announce(`${objectiveFor(level, mode)}. ${sublineFor(level, mode)}`);
  refreshAssists();
  tutorialUpdate(false);
  app.phase = "active";
  audio.setIntensity(0);
}
export function objectiveFor(level: Level, mode: string): string {
  const name = levelName(level);
  return mode === "journey" && level.mastery ? T("masteryObjective", { name }) : name;
}
export function sublineFor(level: Level, mode: string): string {
  const parts = [T("clearN", { n: level.tiles.length })];
  if (level.config.timeLimitMs) parts.push(T("clockT", { time: fmtMs(level.config.timeLimitMs) }));
  if (level.config.trayCapacity !== undefined && level.config.trayCapacity !== 7) parts.push(T("trayOfN", { n: level.config.trayCapacity }));
  if (level.config.ranked) parts.push(T("ranked"));
  if (mode === "practice") parts.push(T("undoUnranked"));
  if (level.config.hints === false) parts.push(T("noHints"));
  return T("objectiveLine", { parts: parts.join(" · ") });
}

// ------------------------------------------------------------------ commands (main.js selectTile / doUndo / doHint)
export function selectTile(tileId: string): void {
  if (app.phase !== "active" || !app.session) return;
  afterSubmit(app.session.submit({ type: "select", tileId }), tileId);
}
export function doUndo(): void {
  if (app.phase !== "active" || !app.session) return;
  const res = app.session.submit({ type: "undo" });
  if (!res.ok) { invalidFeedback(res.reason ?? ""); return; }
  afterSubmit(res);
}
export function doHint(): void {
  if (app.phase !== "active" || !app.session || app.thinking) return;
  const s = app.session;
  const res = s.submit({ type: "hint" });
  if (!res.ok) { invalidFeedback(res.reason ?? ""); return; }
  afterSubmit(res);
  // the solver may search for a while natively: on a worker, with a "Thinking…" line after 300 ms
  const asked = now();
  thinkingSince = asked;
  app.thinking = true;
  hints.request(s.state, (id) => {
    if (app.session !== s) return;
    app.thinking = false;
    if (!id) return;
    render.showHint(id);
    const tile = s.state.tiles.find((x) => x.id === id);
    announce(T("hintTry", { symbol: tile ? symbolName(tile.sym) : "" }));
  });
  thinkingSince = asked;
}
let thinkingSince = 0;
export function thinkingVisible(): boolean { return app.thinking && now() - thinkingSince > 0.3; }
const REASON_KEYS: Record<string, string> = {
  not_active: "rsnNotActive", malformed: "rsnMalformed", tile_not_found: "rsnTileNotFound", tile_blocked: "rsnTileBlocked",
  limit_exceeded: "rsnLimitExceeded", undo_disabled: "rsnUndoDisabled", undo_empty: "rsnUndoEmpty", hint_disabled: "rsnHintDisabled",
};
function afterSubmit(res: { ok: boolean; reason?: string }, tileId: string | null = null): void {
  const s = app.session;
  if (!s) return;
  if (!res.ok) { invalidFeedback(res.reason ?? "", tileId); return; }
  const events = s.drainEvents();
  for (const ev of events) {
    audio.playEvent(ev);
    if (ev.type === "pick") { try { vibrate(8); } catch { /* none */ } }
  }
  if (events.some((e) => e.type !== "tick")) {
    render.applyEvents(events, s.state);
    refreshAssists();
    if (app.focusIndex >= focusTargets().length) app.focusIndex = -1;
  }
  audio.setIntensity(s.state.tray.length / s.state.trayCapacity);
  announceScore();
  tutorialAdvance(events, tileId);
  if (s.finished) resolveRound();
}
let lastScoreMsg = "";
function announceScore(): void {
  const st = app.session!.state;
  const msg = T("scoreAnnounce", { score: st.score.total, tiles: st.tiles.length, tray: st.tray.length, cap: st.trayCapacity });
  if (msg !== lastScoreMsg) { lastScoreMsg = msg; announce(msg); }
}
function invalidFeedback(reason: string, tileId: string | null = null): void {
  announce(REASON_KEYS[reason] ? T(REASON_KEYS[reason]!) : T("notAllowed"));
  audio.playEvent({ type: "invalid" });
  if (tileId && app.session) render.applyEvents([{ type: "invalid", reason, tileId }], app.session.state);
  if (app.round?.lesson) tutorialAdvance([{ type: "invalid", reason, tileId: tileId ?? undefined }], tileId);
}
function refreshAssists(): void {
  const la = Engine.legalActions(app.session!.state);
  app.canUndo = la.canUndo;
  app.canHint = la.canHint;
}

// ------------------------------------------------------------------ lessons (main.js _tutorialUpdate / _tutorialAdvance)
function tutorialUpdate(speak: boolean): void {
  const r = app.round;
  const lesson = r?.lesson;
  const step = lesson?.steps[r!.stepIndex];
  if (!lesson || !step) { app.tutorial = null; return; }
  const text = lessonText(step.id, step.text);
  app.tutorial = (r!.stepIndex === 0 ? `${lessonText(lesson.id, lesson.intro)} ` : "") + text;
  if (speak || r!.stepIndex === 0) announce(T("lessonAnnounce", { text }));
}
/** The lesson banner in the current language. */
export function tutorialText(): string | null {
  const r = app.round;
  const lesson = r?.lesson;
  const step = lesson?.steps[r!.stepIndex];
  if (!lesson || !step) return null;
  return (r!.stepIndex === 0 ? `${lessonText(lesson.id, lesson.intro)} ` : "") + lessonText(step.id, step.text);
}
function tutorialAdvance(events: RulesEvent[], _tileId: string | null): void {
  const r = app.round;
  const step = r?.lesson?.steps[r.stepIndex];
  if (!step) return;
  const req = step.require ?? {};
  let done = false;
  for (const ev of events) {
    if (req.select && ev.type === "pick" && ev.tileId === req.select) done = true;
    if (req.selectSym && ev.type === "pick" && ev.sym === req.selectSym) done = true;
    if (req.event && ev.type === req.event) done = true;
    if (req.invalid && ev.type === "invalid" && ev.tileId === req.invalid) done = true;
  }
  if (done) { r!.stepIndex++; tutorialUpdate(true); }
}

// ------------------------------------------------------------------ resolving → results (main.js _resolveRound)
let resolveIn = 0;
let resolved: (() => ResultsSpec) | null = null;
function resolveRound(): void {
  const s = app.session!, r = app.round!;
  app.phase = "resolving";
  const state = s.state, level = r.level, mode = r.mode;
  const won = state.status === "won";
  const result = s.result();
  const store = platform.store;
  if (mode === "learn" && won && r.lesson) { store.doc.progression.lessons[r.lesson.id] = { done: true }; store.save(); }
  store.recordRound(result, level);
  const unlocked = checkAchievements();
  const ranked = mode !== "practice" && mode !== "learn";
  const postLb = ranked && platform.signedIn();
  const board: ResultsSpec["board"] = postLb ? { key: "lbPosting", platform: true } : { key: ranked ? "localBestDevice" : "unrankedLocal" };
  const breakdown = Engine.scoreBreakdown(state);
  const stars = won && level.star ? starsFor(result.score, level.star) : 0;
  const spec = (): ResultsSpec => ({
    won,
    reasonText: won ? T("clearedIn", { level: levelName(level), time: fmtMs(state.elapsedMs), moves: state.moves }) : reasonTextFor(state.terminalReason),
    rows: breakdown.rows, total: breakdown.total, stars,
    achievements: unlocked.map((a) => { const [name, description] = tn<[string, string]>("achievements", a.key, [a.name, a.description]); return { name, description }; }),
    board, nextLabel: mode === "journey" && won ? T("nextStage") : T("continue"),
  });
  resolved = spec;
  if (postLb) {
    void platform.postScore(result.score).then((p) => {
      const next = !p.posted ? { key: "lbNotPosted", platform: true } : p.rank ? { key: "lbRank", vars: { rank: p.rank }, platform: true } : { key: "lbPosted", platform: true };
      Object.assign(board, next);
      if (app.session === s && app.phase === "results") announce(S(board.key, board.vars));
    });
  }
  resolveIn = Math.round((won ? 1.2 : 0.7) * STEP_RATE);
}
function showResults(): void {
  if (!resolved) return;
  app.phase = "results";
  app.results = resolved();
  app.caption = null;
  const r = app.results;
  announce(T("resultsAnnounce", { heading: r.won ? T("tableCleared") : T("roundOver"), total: r.total, reason: r.reasonText }));
  open("results", r.won && app.round?.mode === "journey" ? "btn-results-next" : "btn-results-retry");
}
/** The results spec in the current language (rebuilt each frame). */
export function resultsSpec(): ResultsSpec | null { return resolved && app.results ? resolved() : app.results; }
function checkAchievements(): { key: string; name: string; description: string }[] {
  const out: { key: string; name: string; description: string }[] = [];
  const store = platform.store;
  const grant = (key: string): void => { if (store.unlockAchievement(key)) { const a = Content.ACHIEVEMENTS.find((x) => x.key === key); if (a) out.push(a); } };
  const p = store.doc.progression;
  if (p.roundsWon > 0) grant("first_clear");
  if (Content.LESSONS.every((l) => p.lessons[l.id]?.done)) grant("lesson_master");
  if (store.doc.daily.streak >= 7) grant("daily_streak_7");
  if ((p.journey["j6-8"]?.stars ?? 0) > 0) grant("summit");
  if (p.tilesClearedTotal >= 1000) grant("thousand_tiles");
  return out;
}
const END_KEYS: Record<string, string> = { tray_full: "endTrayFull", move_limit: "endMoveLimit", time_limit: "endTimeLimit", resigned: "endResigned" };
const reasonTextFor = (reason: string | null): string => T(END_KEYS[reason ?? ""] ?? "endOther");
function starsFor(score: number, [t2, t3]: [number, number]): number { return score >= t3 ? 3 : score >= t2 ? 2 : 1; }
export function retry(): void {
  const r = app.round;
  if (!r) return;
  startRound(r.mode === "learn" && r.lesson ? Content.lessonLevel(r.lesson) : r.level, r.mode, r.lesson);
}
export function next(): void {
  const r = app.round;
  if (r && r.mode === "journey") {
    const idx = Content.JOURNEY.findIndex((s) => s.id === r.level.id);
    if (idx >= 0 && idx + 1 < Content.JOURNEY.length) { startRound(Content.JOURNEY[idx + 1]!, "journey", null); return; }
  }
  goTitle();
}

// ------------------------------------------------------------------ pause (main.js pauseGame / resumeGame / leaveRound)
export function pauseGame(auto = false): void {
  if (app.phase !== "active") return;
  app.phase = "paused";
  app.settingsOnly = false;
  open("pause", "btn-resume");
  announce(auto ? T("pausedHidden") : T("paused"));
}
export function resumeGame(): void {
  if (app.settingsOnly) { app.settingsOnly = false; open(app.phase === "setup" ? "setup" : app.phase === "mode-select" ? "modes" : app.phase === "results" ? "results" : "title"); return; }
  if (app.phase !== "paused") return;
  app.phase = "active";
  app.screen = null;
  app.openedFrame = frame().frame;
  ui.setFocus(null);
}
export function leaveRound(): void {
  const s = app.session;
  if (s && app.phase === "paused") {
    app.screen = null;
    app.phase = "active";
    const res = s.submit({ type: "resign" });
    if (res.ok) { afterSubmit(res); return; }
  }
  goTitle();
}
export function replayTutorial(): void { app.settingsOnly = false; startLesson(Content.LESSONS[0]!); }

// ------------------------------------------------------------------ settings (main.js _settingsChanged)
export function setSetting(patch: Record<string, unknown>): void {
  platform.store.updateSettings(patch);
  applySettings();
  if ("cameraView" in patch) render.setCameraPreference(settings().cameraView);
  if ("themeChoice" in patch && app.round) render.setTheme(themeFor(app.round.level));
  else if ("themeChoice" in patch) render.setTheme(themeFor(null));
}
function applySettings(): void {
  const s = settings();
  render.setPalette(s.colorblindPalette);
  audio.setCaptions(!!s.captions);
}
export function renameProfile(name: string): void {
  const clean = name.replace(/[<>"]/g, "").trim().slice(0, 24);
  if (!clean) return;
  platform.store.doc.profile.displayName = clean;
  platform.store.save();
}

// ------------------------------------------------------------------ score chase (main.js _showBoard)
export function showBoard(board: string): void {
  const view: BoardView = { board, loading: platform.signedIn(), global: null, me: null, failed: false };
  app.boardView = view;
  if (!platform.signedIn()) return;
  void platform.fetchBoard(app.boardFriends).then((r) => {
    view.loading = false;
    if (!r) { view.failed = true; return; }
    view.global = r.entries;
    view.me = r.me;
  });
}
export function setBoardFriends(on: boolean): void { app.boardFriends = on; if (app.boardView) showBoard(app.boardView.board); }

// ------------------------------------------------------------------ account
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function invite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); caption(S("inviteCopied")); } catch { caption(S("inviteFailed", { link })); }
}

// ------------------------------------------------------------------ keyboard focus (main.js _focusTargets / _moveFocus / _confirmFocus)
export function focusTargets(): { id: string; sym: string; z: number; gx: number; gy: number }[] {
  const s = app.session;
  if (!s) return [];
  const la = Engine.legalActions(s.state);
  const byId = new Map(s.state.tiles.map((t) => [t.id, t]));
  return la.selectable.map((id) => byId.get(id)!).filter(Boolean).sort((a, b) => b.z - a.z || a.gy - b.gy || a.gx - b.gx);
}
export function moveFocus(dir: number): void {
  const targets = focusTargets();
  if (!targets.length) return;
  if (app.focusIndex < 0) app.focusIndex = 0;
  else app.focusIndex = (app.focusIndex + dir + targets.length) % targets.length;
  const t = targets[app.focusIndex]!;
  render.setFocus(t.id);
  render.setHover(t.id);
  announce(T("focusAnnounce", { symbol: symbolName(t.sym), layer: t.z + 1, i: app.focusIndex + 1, n: targets.length }));
}
function confirmFocus(): void {
  const targets = focusTargets();
  if (app.focusIndex >= 0 && targets[app.focusIndex]) {
    const id = targets[app.focusIndex]!.id;
    app.focusIndex = -1;
    render.setFocus(null);
    selectTile(id);
  } else if (targets.length) {
    app.focusIndex = 0;
    moveFocus(1);
  }
}
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  if (a === "pause") {
    if (!fresh()) return;
    if (app.phase === "active" && app.screen === null) later(() => pauseGame());
    return;
  }
  if (app.phase !== "active" || app.screen !== null) return;
  switch (a) {
    case "focus_left": case "focus_up": ui.setFocus(null); later(() => moveFocus(-1)); break;
    case "focus_right": case "focus_down": ui.setFocus(null); later(() => moveFocus(1)); break;
    // a focused button keeps its own Enter / Space
    case "pick": if (ui.focused() === null) later(confirmFocus); break;
    case "undo": later(doUndo); break;
    case "hint": later(doHint); break;
    case "camera": later(() => render.resetCamera()); break;
  }
});

// ------------------------------------------------------------------ pointer and touch on the table (main.js _bindInputs)
const TAP_MAX_DIST = 12, TAP_MAX_S = 0.6, HOLD_S = 0.4;
type PEv = { kind: "down" | "move" | "up" | "cancel"; x: number; y: number; ui: boolean; touch: boolean };
const queue: PEv[] = [];
let down: { x: number; y: number; t: number; dragging: boolean; committed: boolean; holdTile: string | null } | null = null;
let lastTouch = -1e9;
onTouch((e) => {
  lastTouch = now();
  if (e.control || !e.primary) return;
  if (e.phase === "start") queue.push({ kind: "down", x: e.x, y: e.y, ui: ui.pointerCaptured(), touch: true });
  else if (e.phase === "move") queue.push({ kind: "move", x: e.x, y: e.y, ui: false, touch: true });
  else queue.push({ kind: e.phase === "cancel" ? "cancel" : "up", x: e.x, y: e.y, ui: false, touch: true });
});
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  queue.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y, ui: e.pressed && ui.pointerCaptured(), touch: false });
});
onPointerMove((x, y) => { if (now() - lastTouch >= 0.6) queue.push({ kind: "move", x, y, ui: false, touch: false }); });
function pointerInput(wasActive: boolean): void {
  for (const p of queue.splice(0)) {
    const active = wasActive && app.phase === "active" && app.screen === null && !!app.session;
    if (!active) { down = null; continue; }
    const sc = ui.preferences().scale;
    if (p.kind === "down") {
      down = null;
      if (p.ui) continue;
      const hold = settings().holdToConfirm ? render.pickTile(p.x, p.y) : null;
      down = { x: p.x, y: p.y, t: now(), dragging: false, committed: false, holdTile: hold };
    } else if (p.kind === "move") {
      if (down) {
        if (Math.hypot(p.x - down.x, p.y - down.y) / sc > TAP_MAX_DIST) down.dragging = true;
        if (down.dragging) continue;
      }
      if (!p.touch) render.setHover(render.pickTile(p.x, p.y));
    } else {
      const d = down;
      down = null;
      if (!d || p.kind === "cancel" || d.dragging || d.committed) continue;
      if (Math.hypot(p.x - d.x, p.y - d.y) / sc <= TAP_MAX_DIST && now() - d.t <= TAP_MAX_S) {
        const id = render.pickTile(p.x, p.y);
        if (id) { if (!settings().holdToConfirm) { ui.setFocus(null); selectTile(id); } }
        else render.setHover(null);
      }
    }
  }
  // hold to confirm: the tile under the press picks after 400 ms
  if (down && !down.committed && !down.dragging && down.holdTile && now() - down.t >= HOLD_S) {
    down.committed = true;
    selectTile(down.holdTile);
  }
}

// ------------------------------------------------------------------ the rules clock
let tickIn = TICK_STEPS;
onFixedUpdate(() => {
  if (app.phase === "resolving") { if (--resolveIn <= 0) showResults(); return; }
  if (app.phase !== "active" || !app.session || app.session.finished) return;
  if (--tickIn > 0) return;
  tickIn = TICK_STEPS;
  afterSubmit(app.session.submit({ type: "tick", dt: TICK_MS }));
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
onStart(() => {
  setFixedRate(STEP_RATE);
  initStyles();
  platform.initPlatform();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  applySettings();
  render.setCameraPreference(settings().cameraView);
  audio.onCaption((key, vars) => caption(T(key, vars)));
  audio.startMusic();
  hints.warm();
  goTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onMerged(() => applySettings());
onSessionEnded(() => caption(S("signedOut")));
onSuspend(() => {
  if (app.phase === "active") pauseGame(true);
  audio.setSuspended(true);
  platform.flush();
});
onResume(() => audio.setSuspended(false));

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(ui.preferences().highContrast);
  audio.update(dt);
  if (app.caption && app.caption.until < now()) app.caption = null;
});
onRender(() => {
  const wasActive = app.phase === "active" && app.screen === null;
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput(wasActive);
  render.update(frameDt);
  flushAnnouncements();
});
