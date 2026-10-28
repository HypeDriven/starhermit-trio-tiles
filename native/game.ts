// The browser build's pure game modules, imported unchanged (allowJs): the
// deterministic rules (js/rules/engine.js: exposure, legal actions, the tray,
// triples, combos, scoring, terminal reasons), the content (js/rules/content.js:
// lessons, the 48-stage Journey, the Daily Steep, practice, challenges, themes,
// achievements), the solver behind hints (js/rules/solver.js), the seeded
// streams (js/rules/rng.js), the session (js/session/session.js: the command
// log, undo stack and state hashes) and the checksummed save document
// (js/session/storage.js). Typed here with the shapes this client reads.
import * as EngineJs from "../js/rules/engine.js";
import * as ContentJs from "../js/rules/content.js";
import * as SolverJs from "../js/rules/solver.js";
import * as RngJs from "../js/rules/rng.js";
import * as SessionJs from "../js/session/session.js";
import * as StorageJs from "../js/session/storage.js";

export interface Tile { id: string; sym: string; gx: number; gy: number; z: number }
export interface TrayEntry { id: string; sym: string }
export interface ScoreParts { triples: number; base: number; comboBonus: number; slotBonus: number; timeBonus: number; total: number }
export interface State {
  tiles: Tile[]; tray: TrayEntry[]; trayCapacity: number; turn: number; moves: number; elapsedMs: number;
  status: "active" | "won" | "lost"; terminalReason: string | null; score: ScoreParts;
  limits: { moveLimit: number | null; timeLimitMs: number | null }; parMs: number | null;
  assists: { undo: boolean; hint: boolean; timingAssist: boolean };
}
export interface RulesEvent { type: string; tileId?: string; sym?: string; insertAt?: number; tileIds?: string[]; chain?: number; reason?: string }
export interface LevelConfig { triples: number; maxLayers: number; trayCapacity?: number; timeLimitMs?: number | null; moveLimit?: number | null; undo?: boolean; hints?: boolean; ranked?: boolean }
export interface LevelDef {
  id: string; kind: string; name: string; theme: string; seed: string; config: LevelConfig;
  chapter?: string; chapterName?: string; stageIndex?: number; index: number; mastery?: boolean; day?: string; blurb?: string;
  tiles?: Tile[];
}
export interface Level extends LevelDef { tiles: Tile[]; symbolIds: string[]; parMs: number | null; star: [number, number] }
export interface LessonStep { id: string; text: string; require?: { select?: string; selectSym?: string; event?: string; invalid?: string } }
export interface Lesson { id: string; name: string; intro: string; theme: string; steps: LessonStep[]; tiles: Tile[] }
export interface Theme {
  id: string; name: string; sky: [string, string, string]; fog: string; tile: number | string; tableTrim: number | string; petal: number | string;
  key: { color: number | string; intensity: number }; fill: { color: number | string; intensity: number };
}
export interface Result { sessionId: string; status: string; score: number; components: ScoreParts; elapsedMs: number }
export interface Session {
  state: State; finished: boolean; sessionId: string; commands: unknown[];
  submit(cmd: Record<string, unknown>): { ok: boolean; reason?: string; duplicate?: boolean; events: RulesEvent[] };
  drainEvents(): RulesEvent[]; result(): Result;
}
export interface BoardEntry { day?: string; contentId?: string; score: number; sessionId: string; name: string; at: number }
export interface SaveDoc {
  version: number; checksum: number; updatedAt: number;
  profile: { displayName: string; guestId: string | null };
  settings: Record<string, unknown> & GameSettings;
  progression: {
    journey: Record<string, { stars: number; bestScore: number; plays: number }>; lessons: Record<string, { done: boolean }>;
    unlockedThemes: string[]; masteryStars: number; tilesClearedTotal: number; roundsPlayed: number; roundsWon: number;
  };
  daily: { history: Record<string, { score: number; status: string; ranked: boolean; sessionId: string }>; streak: number; lastDay: string | null };
  challenges: Record<string, { bestScore: number; done: boolean }>;
  achievements: Record<string, { unlockedAt: number }>;
  boards: Record<string, BoardEntry[]>;
}
/** The game's own options kept in the save (volumes, graphics, motion, contrast, text size and haptics are the runtime's). */
export interface GameSettings {
  captions: boolean; colorblindPalette: string; leftHanded: boolean; holdToConfirm: boolean; timingAssist: boolean;
  cameraView: string; themeChoice: string;
}
export interface SaveStore {
  doc: SaveDoc; settings: SaveDoc["settings"];
  save(): void; updateSettings(patch: Record<string, unknown>): void; recordRound(r: Result, level: Level): void;
  unlockAchievement(key: string): boolean; mergeCloud(remote: unknown): { status: string; changed: boolean };
}
export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem?(k: string): void }

interface EngineApi {
  legalActions(s: State): { selectable: string[]; canUndo: boolean; canHint: boolean };
  computeExposure(s: State): { exposed: string[]; blockers: Map<string, string[]> };
  projectSelect(s: State, id: string): { insertAt: number; wouldClear: boolean; trayAfter: number } | null;
  scoreBreakdown(s: State): { rows: { key: string; label: string; count?: number; value: number }[]; total: number };
  INVALID_REASONS: Record<string, string>;
}
interface ContentApi {
  JOURNEY: LevelDef[]; JOURNEY_CHAPTERS: { id: string; name: string; stages: string[]; unlockTheme?: string }[];
  LESSONS: Lesson[]; CHALLENGES: LevelDef[]; PRACTICE_DIFFICULTIES: { id: string; name: string; config: LevelConfig }[];
  THEMES: Record<string, Theme>; ACHIEVEMENTS: { key: string; name: string; description: string }[];
  practiceLevel(id: string, seed: string): LevelDef; dailyLevel(d: Date): LevelDef; todayUTC(d: Date): Date;
  materializeLevel(l: LevelDef): Level; lessonLevel(l: Lesson): Level;
}
export interface Stream { range(a: number, b: number): number; next(): number }
interface RngApi { decorStream(seed: string): Stream; audioStream(seed: string): Stream }

export const Engine = EngineJs as unknown as EngineApi;
export const Content = ContentJs as unknown as ContentApi;
export const Solver = SolverJs as unknown as { suggestMove(s: State): string | null };
export const Rng = RngJs as unknown as RngApi;
export const SessionClass = (SessionJs as unknown as { Session: new (level: Level, opts?: Record<string, unknown>) => Session }).Session;
export const Storage = StorageJs as unknown as {
  SaveStore: new (storage: StorageLike) => SaveStore; DEFAULT_SETTINGS: Record<string, unknown>;
  mergeSaveDocs(remote: unknown, local: unknown): SaveDoc;
};
