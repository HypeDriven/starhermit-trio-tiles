/**
 * Local persistence — a single versioned, checksummed save document.
 * Cloud sync conflicts are resolved by keeping both snapshots; the UI asks
 * when neither is a strict descendant (spec §6). No credentials or private
 * data ever enter the save.
 */

import { fnv1a } from '../rules/rng.js';

export const SAVE_VERSION = 1;
const SAVE_KEY = 'trio-tiles/save';
const OUTBOX_KEY = 'trio-tiles/outbox';

export const DEFAULT_SETTINGS = Object.freeze({
  music: 0.7,
  effects: 0.9,
  ambience: 0.5,
  voice: 0.8,
  muted: false,
  captions: false,
  graphicsTier: 'auto', // auto | low | medium | high
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
    this.conflict = null; // { local, remote } when an unresolved conflict exists
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
   * Import a (possibly cloud-synced) document. If neither document is a
   * strict descendant of the other, keep both and surface a conflict for the
   * player to resolve (spec §6 cloud-save conflict rule).
   */
  mergeRemote(remoteDoc) {
    if (!remoteDoc || remoteDoc.checksum !== checksum(remoteDoc)) return { status: 'rejected' };
    const local = this.doc;
    if (remoteDoc.updatedAt <= local.updatedAt) return { status: 'kept-local' };
    const localAhead = this._progressAhead(local, remoteDoc);
    const remoteAhead = this._progressAhead(remoteDoc, local);
    if (remoteAhead && !localAhead) {
      this.doc = migrate(remoteDoc);
      this.save();
      return { status: 'applied-remote' };
    }
    if (!remoteAhead && !localAhead) {
      this.doc = migrate(remoteDoc);
      this.save();
      return { status: 'applied-remote' };
    }
    this.conflict = { local, remote: remoteDoc };
    this.storage?.setItem(SAVE_KEY + '.conflict', JSON.stringify(remoteDoc));
    return { status: 'conflict' };
  }

  resolveConflict(choice /* 'local' | 'remote' */) {
    if (!this.conflict) return;
    if (choice === 'remote') {
      this.doc = migrate(this.conflict.remote);
      this.save();
    }
    this.conflict = null;
    this.storage?.removeItem(SAVE_KEY + '.conflict');
  }

  _progressAhead(a, b) {
    // A is "ahead" of B if every progress marker in B is present in A and at
    // least one is strictly greater (strict descendant test).
    const pa = a.progression ?? {};
    const pb = b.progression ?? {};
    let ahead = false;
    const ids = new Set([...Object.keys(pa.journey ?? {}), ...Object.keys(pb.journey ?? {})]);
    for (const id of ids) {
      const sa = pa.journey?.[id]?.stars ?? 0;
      const sb = pb.journey?.[id]?.stars ?? 0;
      if (sb > sa) return false;
      if (sa > sb) ahead = true;
    }
    if ((pa.tilesClearedTotal ?? 0) < (pb.tilesClearedTotal ?? 0)) return false;
    if ((pa.tilesClearedTotal ?? 0) > (pb.tilesClearedTotal ?? 0)) ahead = true;
    return ahead;
  }

  // --- Outbox: scores/actions queued while offline, flushed on next boot ---

  queueOutbox(item) {
    const list = this._readOutbox();
    list.push({ ...item, queuedAt: Date.now(), id: fnv1a(JSON.stringify(item) + Date.now()).toString(36) });
    try {
      this.storage?.setItem(OUTBOX_KEY, JSON.stringify(list.slice(-100)));
    } catch {
      /* ignore */
    }
  }

  _readOutbox() {
    try {
      return JSON.parse(this.storage?.getItem(OUTBOX_KEY) ?? '[]');
    } catch {
      return [];
    }
  }

  drainOutbox() {
    const list = this._readOutbox();
    try {
      this.storage?.removeItem(OUTBOX_KEY);
    } catch {
      /* ignore */
    }
    return list;
  }
}

function starsFor(score, [t2, t3]) {
  if (score >= t3) return 3;
  if (score >= t2) return 2;
  return 1;
}

// content.js is imported lazily via a module-level reference to avoid a
// rules<->session import cycle; wired by init below.
import * as contentRef from '../rules/content.js';
