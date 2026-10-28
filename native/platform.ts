// The game's data and the StarHermit platform on the runtime's modules (what
// js/platform/host.js and js/session/storage.js did over localStorage and the
// JS SDK):
// - the save document (js/session/storage.js SaveStore: profile, the game's own
//   options, Journey stars, lessons, themes, the Daily history and streak,
//   challenges, achievements, the local boards; versioned and checksummed) is
//   the game's save (starhermit:storage `saves`, on the device and, signed in,
//   in the player's cloud slot): SaveStore reads and writes it through a
//   one-key storage shim. Two devices' copies merge on a conflict
//   (mergeSaveDocs, the browser build's saveconflict merge). The slot the
//   browser build wrote (the JS SDK's saveJSON of the same document under
//   game:<slug>) shows as foreign: it is merged in (SaveStore.mergeCloud, as at
//   the old boot) and replaced once;
// - the browser build's settings KV mirror (one key per setting) is read once:
//   the game's own options (captions, symbol palette, left-handed layout, hold
//   to confirm, timing assistance, camera view, table theme) carry over unless
//   set here since; then its keys go. Volumes, mute, graphics, reduced motion,
//   high contrast, larger text, haptics and the language are the runtime's
//   Options now; telemetry had no route and is gone;
// - the player and the invite link, the platform's clock for the Daily Steep,
//   the high-score board for Score Chase, and posting a finished ranked round's
//   score through score-script.js (a practice session whose socket carries
//   { type: 'result', scores }, as the JS SDK's submitScores did) with the rank.
import type { JsonValue } from "starhermit:engine";
import { connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions, type Leaderboard } from "starhermit:platform";
import { saves, settings as kv } from "starhermit:storage";
import { Storage, type SaveDoc, type SaveStore, type StorageLike } from "./game.ts";
import * as MigrateJs from "../js/migrate.js";

const Migrate = MigrateJs as unknown as { pickLegacy(kv: Record<string, unknown>): Record<string, unknown> };

const SAVE_KEY = "trio-tiles/save";
/** Every key the browser build wrote to the account's settings KV. */
export const LEGACY_KEYS = [...Object.keys(Storage.DEFAULT_SETTINGS), "ui.language", "audio.options"];

// --- the save -----------------------------------------------------------------------------
let lastSavedAt = 0;
let writing = false;
/** SaveStore's localStorage: the save key is the engine save's data; anything else is dropped. */
const shim: StorageLike = {
  getItem(k) {
    if (k !== SAVE_KEY) return null;
    try { const cur = saves.load(); return cur && cur.data && typeof cur.data === "object" ? JSON.stringify(cur.data) : null; } catch { return null; }
  },
  setItem(k, v) {
    if (k !== SAVE_KEY || writing) return;
    try { saves.save(JSON.parse(v) as JsonValue, { schema: 1 }); lastSavedAt = saves.load()?.savedAt ?? lastSavedAt; }
    catch (e) { console.warn(`save: ${String(e)}`); }
  },
};
export let store: SaveStore = new Storage.SaveStore({ getItem: () => null, setItem: () => undefined });

/** A merged document with a fresh checksum (SaveStore.save stamps it), without writing it anywhere. */
export function sealed(doc: SaveDoc): SaveDoc {
  let out = "";
  const s = new Storage.SaveStore({ getItem: () => null, setItem: (_k, v) => { out = v; } });
  s.doc = doc;
  s.save();
  return JSON.parse(out) as SaveDoc;
}
const listeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onMerged(fn: () => void): void { listeners.add(fn); }
function merged(): void { for (const fn of listeners) fn(); }
const progressKey = (d: SaveDoc): string => JSON.stringify([d.progression, d.daily, d.challenges, d.achievements, d.boards]);

saves.onConflict((mine, remote) => ({
  merged: sealed(Storage.mergeSaveDocs(remote.data, mine?.data ?? store.doc)) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    const before = progressKey(store.doc);
    const r = store.mergeCloud(cur.data);
    if (r.status === "merged" && progressKey(store.doc) !== before) merged();
  }
});
/** The browser build's cloud slot (the SaveStore document as JSON): merged in, then saved over once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const before = progressKey(store.doc);
  let doc: unknown = null;
  try { doc = old.text != null ? JSON.parse(old.text) : null; } catch { doc = null; }
  if (doc && typeof doc === "object") {
    writing = true;
    try { store.mergeCloud(doc); } finally { writing = false; }
  }
  try { saves.save(sealed(store.doc) as unknown as JsonValue, { schema: 1, replaceForeign: true }); lastSavedAt = saves.load()?.savedAt ?? lastSavedAt; }
  catch (e) { console.warn(`save: ${String(e)}`); }
  if (progressKey(store.doc) !== before) merged();
}

/** host.js syncLabel: null for a guest, else saving | synced | error | offline. */
export function syncState(): "saving" | "synced" | "error" | "offline" | null {
  if (!player()) return null;
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the browser build's settings KV -------------------------------------------------------
function importLegacy(): void {
  const keys = kv.legacyKeys();
  if (!keys || !keys.length) return;
  const old: Record<string, unknown> = {};
  for (const k of keys) old[k] = kv.legacy(k);
  let migrated = false;
  try { migrated = kv.get("legacyImported") === true; } catch { migrated = true; }
  if (!migrated) {
    const patch = Migrate.pickLegacy(old);
    if (Object.keys(patch).length) store.updateSettings(patch);
    try { kv.set("legacyImported", true); } catch { /* next time */ }
  }
  for (const k of keys) if (LEGACY_KEYS.includes(k) || k.startsWith("ui.")) kv.removeLegacy(k);
}

/** Reads the device's save (from onStart). */
export function initPlatform(): void {
  lastSavedAt = saves.load()?.savedAt ?? 0;
  store = new Storage.SaveStore(shim);
  if (!store.doc.profile.guestId) {
    store.doc.profile.guestId = "g-" + Math.floor(Math.random() * 2 ** 48).toString(36);
    store.save();
  }
  kv.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  refreshPlayer();
  void serverTime().then(() => undefined, () => undefined);
}

// --- the player and the clock --------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string | null { return player()?.displayName ?? null; }
let invite: string | null = null;
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(); });
/** host.js now(): the platform's clock when it answered, else the device's. */
export function now(): Date { try { return new Date(serverNow() ?? Date.now()); } catch { return new Date(); } }

// --- the high-score board ------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface Entry { rank: number; name: string; score: number }
/** host.js platformEntries: the top 20 (friends only on request); null when there is none. */
export async function fetchBoard(friends: boolean): Promise<{ entries: Entry[]; me: number | null } | null> {
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    if (friends && !player()) return null;
    const r = await leaderboards.entries(b.id, { pageSize: 20, ...(friends ? { friendsOnly: true } : {}) });
    const meId = player()?.userId;
    const mine = r.items.find((e) => e.userId === meId);
    return {
      entries: r.items.slice(0, 20).map((e, i) => ({ rank: e.rank ?? i + 1, name: e.displayName || e.username || "", score: e.score ?? 0 })),
      me: mine ? mine.rank : null,
    };
  } catch { return null; }
}
export interface Posted { posted: boolean; rank: number | null }
/** host.js submitScore: signed in only, through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (d) => {
        const m = d as { type?: string; accepted?: string[] } | null;
        if (m && m.type === "result-ack") finish(Array.isArray(m.accepted) ? m.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
