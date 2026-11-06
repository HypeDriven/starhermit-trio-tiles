// Localization: assets/strings.json (generated from the browser build's tables:
// flat keys plus group.id keys for symbols, chapters, themes, difficulties,
// challenges, blurbs, lessons, lesson texts and achievements, the nine locales)
// on the engine's strings, which follow the interface language the runtime
// reports (Options › Language, else the account's preferred language or the
// device's) and own the locale fallback and the account lines (`starhermit.*`).
// Every string is drawn through T() each frame, so a change shows at once and
// never restarts the round (what i18n.js's onLanguage re-rendering did).
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import type { LevelDef } from "./game.ts";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** i18n.js t(). */
export function T(key: string, vars?: Vars | null): string { return strings.t(key, vars ?? undefined); }
/** i18n.js tn(): a content name by its group.id key. */
export function tn(group: string, id: string, fallback: string): string {
  const key = `${group}.${id}`;
  return strings.has(key) ? strings.t(key) : fallback;
}
/** The engine's account strings (signIn, invite, inviteCopied, inviteLink, signedOut, leaderboard…). */
export function S(key: string, vars?: Vars): string { return strings.t(`starhermit.${key}`, vars); }
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
