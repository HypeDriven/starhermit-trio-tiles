// Localization: the browser build's tables (js/ui/strings.js: flat keys plus
// per-id maps for symbols, chapters, themes, difficulties, challenges, blurbs,
// lessons, lesson texts and achievements; js/ui/platform-strings.js for the
// StarHermit buttons and the leaderboard line) in the nine locales, in the
// interface language the runtime reports (preferences().language: Options ›
// Language, else the account's preferred language or the device's). Every
// string is drawn through T() each frame, so a change shows at once and never
// restarts the round (what i18n.js's onLanguage re-rendering did).
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { STRINGS } from "../js/ui/strings.js";
import { PLATFORM_STRINGS } from "../js/ui/platform-strings.js";
import { ENGINE_STRINGS } from "../js/ui/engine-strings.js";
import { GFX_STRINGS } from "../js/ui/gfx-strings.js";
import type { LevelDef } from "./game.ts";

type Table = Record<string, unknown>;
const BASE = STRINGS as unknown as Record<string, Table>;
const EXTRA = ENGINE_STRINGS as unknown as Record<string, Table>;
const TABLES: Record<string, Table> = Object.fromEntries(Object.keys(BASE).map((l) => [l, { ...BASE[l], ...(EXTRA[l] ?? EXTRA["en-US"]) }]));
const PLAT = PLATFORM_STRINGS as unknown as Record<string, Record<string, string>>;
const EN = TABLES["en-US"]!;
export const LOCALES = Object.keys(TABLES);
let locale = "";
let dict: Table = EN;

/** The closest shipped locale for a BCP 47 tag (es-MX → es-419, fr-BE → fr-FR, pt → pt-BR …). */
export function matchLocale(tag: string): string {
  const t = String(tag || "en-US");
  const exact = LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.split(/[-_]/)[0]!.toLowerCase();
  const region = (t.split(/[-_]/)[1] ?? "").toUpperCase();
  if (lang === "en") return region === "GB" || region === "IE" || region === "AU" || region === "NZ" ? "en-GB" : "en-US";
  if (lang === "es") return region === "ES" ? "es-ES" : "es-419";
  if (lang === "fr") return region === "CA" ? "fr-CA" : "fr-FR";
  if (lang === "pt") return "pt-BR";
  if (lang === "de") return "de-DE";
  if (lang === "it") return "it-IT";
  return "en-US";
}
function apply(tag: string): void {
  const loc = matchLocale(tag);
  if (loc === locale) return;
  locale = loc;
  dict = TABLES[loc]!;
  try { ui.setLanguage(locale); } catch { /* older hosts */ }
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale; }
export type Vars = Record<string, string | number>;
const fill = (s: string, vars?: Vars | null): string =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m)) : s;
/** i18n.js t(). */
export function T(key: string, vars?: Vars | null): string { return fill(String(dict[key] ?? EN[key] ?? key), vars); }
/** i18n.js tn(): a content name from a nested map. */
export function tn<V>(group: string, id: string, fallback: V): V {
  const own = (dict[group] as Record<string, unknown> | undefined)?.[id];
  if (own != null) return own as V;
  const en = (EN[group] as Record<string, unknown> | undefined)?.[id];
  return (en != null ? en : fallback) as V;
}
/** platform-strings.js: the StarHermit buttons, toasts and the leaderboard line. */
export function S(key: string, vars?: Vars): string {
  const table = PLAT[locale] ?? PLAT["en-US"]!;
  return fill(table[key] ?? PLAT["en-US"]![key] ?? key, vars);
}
export const symbolName = (sym: string): string => tn("symbols", sym, sym);
export const themeName = (id: string, fallback?: string): string => tn("themes", id, fallback ?? id);
export const chapterName = (id: string, fallback?: string): string => tn("chapters", id, fallback ?? id);
/** i18n.js levelName. */
export function levelName(level: LevelDef | null): string {
  if (!level) return "";
  switch (level.kind) {
    case "journey": return T("journeyStage", { chapter: chapterName(level.chapter ?? "", level.chapterName), n: (level.stageIndex ?? 0) + 1 });
    case "daily": return T("dailyName", { day: level.day ?? "" });
    case "challenge": return tn("challenges", level.id, level.name);
    case "learn": return tn("lessons", level.id, level.name);
    case "practice": {
      const m = /^practice-([a-z]+)-/.exec(level.id);
      return m ? T("practiceName", { level: tn("difficulties", m[1]!, m[1]!) }) : level.name;
    }
    default: return level.name;
  }
}
export const lessonText = (id: string, fallback: string): string => tn("lessonText", id, fallback);
/** i18n.js playerName. */
export function playerName(name: string | null | undefined): string {
  if (name == null || name === "Guest" || name === "") return T("guest");
  const m = /^Player (\S+)$/.exec(String(name));
  return m ? T("playerN", { id: m[1]! }) : String(name);
}
export function fmtMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
/** gfx-strings.js: the old Graphics section's heading. */
export function G(key: string): string {
  const t = GFX_STRINGS as unknown as Record<string, Record<string, unknown>>;
  return String((t[locale] ?? t["en-US"]!)[key] ?? key);
}
