/**
 * Local persistence — a single versioned, checksummed save document.
 * Cloud copies are merged into it (mergeSaveDocs) so neither device's
 * progress is lost (spec §6). No credentials or private data ever enter the
 * save.
 */

import { fnv1a } from '../rules/rng.js';

export const SAVE_VERSION = 1;
const SAVE_KEY = 'trio-tiles/save';

export const DEFAULT_SETTINGS = Object.freeze({
  music: 0.7,
  effects: 0.9,
  ambience: 0.5,
  voice: 0.8,
  muted: false,
  captions: false,
  graphicsTier: 'auto', // legacy single tier (auto | low | medium | high); migrated into `graphics`
  graphics: {}, // { preset: 'auto'|low|balanced|high|ultra, render_scale, adaptive, show_fps, <category>: tier }
  reducedMotion: false,
  highContrast: false,
  colorblindPalette: 'default', // default | deuteranopia | protanopia | tritanopia
  largerText: false,
  leftHanded: false,
  holdToConfirm: false,
  timingAssist: false,
  haptics: true,
  cameraView: 'default', // default | top | low
  telemetryConsent: false,
  themeChoice: 'auto', // auto or a theme id
  tutorialSeen: false,
});

function defaultSave() {
  return {
    version: SAVE_VERSION,
    checksum: 0,
    updatedAt: 0,
    profile: { displayName: 'Guest', guestId: null },
    settings: { ...DEFAULT_SETTINGS },
    progression: {
      journey: {}, // stageId -> { stars, bestScore, plays }
      lessons: {}, // lessonId -> { done }
      unlockedThemes: ['dawn'],
      masteryStars: 0,
      tilesClearedTotal: 0,
      roundsPlayed: 0,
      roundsWon: 0,
    },
    daily: {
      history: {}, // day -> { score, status, ranked, sessionId }
      streak: 0,
      lastDay: null,
    },
    challenges: {}, // challengeId -> { bestScore, done }
    achievements: {}, // key -> { unlockedAt }
    boards: {
      // local fallback boards; host boards merge over these
      daily: [], // [{day, score, sessionId, name}]
      journey: [], // [{contentId, score, sessionId, name}]
      challenge: [], // [{contentId, score, sessionId, name}]
    },
    lastSnapshot: null, // last safe in-round snapshot for resume
  };
}

function checksum(doc) {
  const { checksum: _ignored, ...rest } = doc;
  return fnv1a(JSON.stringify(rest));
}

function migrate(doc) {
  if (!doc || typeof doc !== 'object') return defaultSave();
  const v = doc.version ?? 0;
  if (v > SAVE_VERSION) return defaultSave();
  let out = doc;
  if (v < 1) {
    out = { ...defaultSave(), ...out, version: 1 };
  }
  // Fill any fields introduced after the document was written.
  const base = defaultSave();
  out = {
    ...base,
    ...out,
    profile: { ...base.profile, ...out.profile },
    settings: { ...base.settings, ...out.settings },
    progression: { ...base.progression, ...out.progression },
    daily: { ...base.daily, ...out.daily },
    boards: { ...base.boards, ...out.boards },
    version: SAVE_VERSION,
  };
  return out;
}

export class SaveStore {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.doc = this._load();
  }

  _load() {
    try {
      const raw = this.storage?.getItem(SAVE_KEY);
      if (!raw) return defaultSave();
      const parsed = JSON.parse(raw);
      if (parsed.checksum !== checksum(parsed)) {
        // Corrupt documents are quarantined, never silently overwritten.
        this.storage?.setItem(SAVE_KEY + '.corrupt', raw);
        return defaultSave();
      }
      return migrate(parsed);
    } catch {
      return defaultSave();
    }
  }

  save() {
    this.doc.updatedAt = Date.now();
    this.doc.checksum = 0;
    this.doc.checksum = checksum(this.doc);
    try {
      this.storage?.setItem(SAVE_KEY, JSON.stringify(this.doc));
    } catch {
      /* storage full/blocked — play remains possible without persistence */
    }
  }

  get settings() {
    return this.doc.settings;
  }

  updateSettings(patch) {
    Object.assign(this.doc.settings, patch);
    this.save();
  }

  recordRound(result, level) {
    const p = this.doc.progression;
    p.roundsPlayed += 1;
    p.tilesClearedTotal += result.components
      ? result.components.triples * 3
      : 0;
    if (result.status === 'won') p.roundsWon += 1;

    if (level.kind === 'journey') {
      const prev = p.journey[level.id] ?? { stars: 0, bestScore: 0, plays: 0 };
      const stars = result.status === 'won' ? starsFor(result.score, level.star) : 0;
      p.journey[level.id] = {
        stars: Math.max(prev.stars, stars),
        bestScore: Math.max(prev.bestScore, result.score),
        plays: prev.plays + 1,
      };
      p.masteryStars = Object.values(p.journey).reduce((a, s) => a + s.stars, 0);
      // Theme unlocks ride on chapter mastery (cosmetic only).
      const { JOURNEY_CHAPTERS } = contentRef;
      for (const ch of JOURNEY_CHAPTERS) {
        if (!ch.unlockTheme) continue;
        const masteryId = ch.stages[ch.stages.length - 1];
        if (p.journey[masteryId]?.stars > 0 && !p.unlockedThemes.includes(ch.unlockTheme)) {
          p.unlockedThemes.push(ch.unlockTheme);
        }
      }
    } else if (level.kind === 'daily') {
      const day = level.day;
      const prev = this.doc.daily.history[day];
      if (!prev) {
        // First (ranked) attempt of the day.
        this.doc.daily.history[day] = {
          score: result.score,
          status: result.status,
          ranked: true,
          sessionId: result.sessionId,
        };
        this._updateStreak(day);
      } else if (result.score > prev.score) {
        // Later attempts are recorded but flagged unranked.
        this.doc.daily.history[day] = { ...prev, score: result.score, status: result.status };
      }
      this._pushBoard('daily', { day, score: result.score, sessionId: result.sessionId, name: this.doc.profile.displayName });
    } else if (level.kind === 'challenge') {
      const prev = this.doc.challenges[level.id] ?? { bestScore: 0, done: false };
      this.doc.challenges[level.id] = {
        bestScore: Math.max(prev.bestScore, result.score),
        done: prev.done || result.status === 'won',
      };
      this._pushBoard('challenge', { contentId: level.id, score: result.score, sessionId: result.sessionId, name: this.doc.profile.displayName });
    }
    if (level.kind === 'journey') {
      this._pushBoard('journey', { contentId: level.id, score: result.score, sessionId: result.sessionId, name: this.doc.profile.displayName });
    }
    this.save();
  }

  _updateStreak(day) {
    const d = this.doc.daily;
    if (d.lastDay === day) return;
    const prev = new Date(day + 'T00:00:00Z');
    prev.setUTCDate(prev.getUTCDate() - 1);
    const prevStr = prev.toISOString().slice(0, 10);
    d.streak = d.lastDay === prevStr ? d.streak + 1 : 1;
    d.lastDay = day;
  }

  _pushBoard(board, entry) {
    const list = this.doc.boards[board];
    list.push({ ...entry, at: Date.now() });
    list.sort((a, b) => b.score - a.score);
    this.doc.boards[board] = list.slice(0, 50);
  }

  unlockAchievement(key, at = Date.now()) {
    if (this.doc.achievements[key]) return false; // idempotent
    this.doc.achievements[key] = { unlockedAt: at };
    this.save();
    return true;
  }

  /**
   * Fold a cloud-saved document into this device's (boot load and after a
   * refused conditional write): mergeSaveDocs keeps the better progress of
   * both sides. Returns { status: 'merged' | 'rejected', changed } where
   * `changed` says the merged doc differs from the remote one (so it needs
   * writing back).
   */
  mergeCloud(remoteDoc) {
    if (!remoteDoc || typeof remoteDoc !== 'object' || remoteDoc.checksum !== checksum(remoteDoc)) {
      return { status: 'rejected', changed: true };
    }
    this.doc = mergeSaveDocs(remoteDoc, this.doc);
    this.save();
    return { status: 'merged', changed: progressKey(this.doc) !== progressKey(migrate(remoteDoc)) };
  }
}

const progressKey = (d) => JSON.stringify([d.progression, d.daily, d.challenges, d.achievements, d.boards]);

/**
 * Merge two save documents without dropping either side's progress: per
 * journey stage the better stars/best score, unions of lessons, themes,
 * achievements (earliest unlock), daily history (better score per day) and
 * local boards, the larger counters, the streak of the later day. Settings
 * come from the more recently saved side; profile and the in-round snapshot
 * stay this device's (`local`).
 */
export function mergeSaveDocs(remoteDoc, localDoc) {
  const r = migrate(JSON.parse(JSON.stringify(remoteDoc)));
  const l = migrate(JSON.parse(JSON.stringify(localDoc)));
  const remoteNewer = (r.updatedAt ?? 0) > (l.updatedAt ?? 0);
  const out = { ...l };
  out.settings = { ...(remoteNewer ? r.settings : l.settings) };
  out.profile = { ...r.profile, ...l.profile, guestId: l.profile.guestId ?? r.profile.guestId };
  out.lastSnapshot = l.lastSnapshot ?? r.lastSnapshot ?? null;
  out.updatedAt = Math.max(r.updatedAt ?? 0, l.updatedAt ?? 0);

  const rp = r.progression, lp = l.progression;
  const journey = {};
  for (const id of new Set([...Object.keys(rp.journey ?? {}), ...Object.keys(lp.journey ?? {})])) {
    const a = rp.journey?.[id] ?? {}, b = lp.journey?.[id] ?? {};
    journey[id] = {
      stars: Math.max(a.stars ?? 0, b.stars ?? 0),
      bestScore: Math.max(a.bestScore ?? 0, b.bestScore ?? 0),
      plays: Math.max(a.plays ?? 0, b.plays ?? 0),
    };
  }
  const lessons = {};
  for (const id of new Set([...Object.keys(rp.lessons ?? {}), ...Object.keys(lp.lessons ?? {})])) {
    lessons[id] = { done: !!(rp.lessons?.[id]?.done || lp.lessons?.[id]?.done) };
  }
  out.progression = {
    ...lp,
    journey,
    lessons,
    unlockedThemes: [...new Set([...(lp.unlockedThemes ?? []), ...(rp.unlockedThemes ?? [])])],
    masteryStars: Object.values(journey).reduce((n, s) => n + s.stars, 0),
    tilesClearedTotal: Math.max(rp.tilesClearedTotal ?? 0, lp.tilesClearedTotal ?? 0),
    roundsPlayed: Math.max(rp.roundsPlayed ?? 0, lp.roundsPlayed ?? 0),
    roundsWon: Math.max(rp.roundsWon ?? 0, lp.roundsWon ?? 0),
  };

  const history = { ...r.daily.history };
  for (const [day, e] of Object.entries(l.daily.history ?? {})) {
    const o = history[day];
    history[day] = !o ? e : { ...(o.ranked ? o : e), score: Math.max(o.score ?? 0, e.score ?? 0), status: (e.score ?? 0) > (o.score ?? 0) ? e.status : o.status };
  }
  const later = (r.daily.lastDay ?? '') > (l.daily.lastDay ?? '') ? r.daily : (l.daily.lastDay ?? '') > (r.daily.lastDay ?? '') ? l.daily
    : (r.daily.streak ?? 0) > (l.daily.streak ?? 0) ? r.daily : l.daily;
  out.daily = { history, streak: later.streak ?? 0, lastDay: later.lastDay ?? null };

  const challenges = {};
  for (const id of new Set([...Object.keys(r.challenges ?? {}), ...Object.keys(l.challenges ?? {})])) {
    const a = r.challenges?.[id] ?? {}, b = l.challenges?.[id] ?? {};
    challenges[id] = { bestScore: Math.max(a.bestScore ?? 0, b.bestScore ?? 0), done: !!(a.done || b.done) };
  }
  out.challenges = challenges;

  const achievements = { ...r.achievements };
  for (const [k, v] of Object.entries(l.achievements ?? {})) {
    const o = achievements[k];
    achievements[k] = !o || (v.unlockedAt ?? Infinity) < (o.unlockedAt ?? Infinity) ? v : o;
  }
  out.achievements = achievements;

  const boards = {};
  for (const name of new Set([...Object.keys(r.boards ?? {}), ...Object.keys(l.boards ?? {})])) {
    const seen = new Set();
    boards[name] = [...(l.boards?.[name] ?? []), ...(r.boards?.[name] ?? [])]
      .filter((e) => {
        const key = [e.sessionId, e.contentId ?? e.day, e.score, e.at].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
  }
  out.boards = boards;
  return out;
}

function starsFor(score, [t2, t3]) {
  if (score >= t3) return 3;
  if (score >= t2) return 2;
  return 1;
}

// content.js is imported lazily via a module-level reference to avoid a
// rules<->session import cycle; wired by init below.
import * as contentRef from '../rules/content.js';
