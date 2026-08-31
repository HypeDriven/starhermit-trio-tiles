/**
 * Platform adapter — StarHermit host integration with a complete offline
 * fallback. Same-origin `/api` routes are used when hosted; guest practice
 * works fully offline. Launch/account tokens are read from the host shell
 * (query param or global) and are NEVER persisted to storage.
 */

import { hashString } from '../rules/rng.js';

const API = '/api/v1';

export class HostPlatform {
  constructor(store) {
    this.store = store;
    this.online = false;
    this.clockOffsetMs = 0;
    this.launchToken = readLaunchToken();
    this.scope = readScope(this.launchToken);
    this.playerId = null;
    this._presenceTimer = null;
    this._telemetryQueue = [];
    this._telemetryConsent = false;
    this._activityStarted = false;
  }

  /** Boot handshake: probe the host, sync the clock, flush the outbox. */
  async init() {
    this.playerId = this.store.doc.profile.guestId;
    if (!this.playerId) {
      this.playerId = 'g-' + hashString('guest:' + Math.random() + Date.now()).slice(0, 12);
      this.store.doc.profile.guestId = this.playerId;
      this.store.save();
    }
    await this.syncTime();
    if (this.online) this.flushOutbox();
  }

  /** Round-trip-adjusted server time sync (spec §6). */
  async syncTime() {
    const t0 = performance.now();
    try {
      const res = await fetchWithTimeout(`${API}/time`, {}, 3000);
      if (!res.ok) throw new Error('http ' + res.status);
      const t1 = performance.now();
      const data = await res.json();
      const rtt = t1 - t0;
      this.clockOffsetMs = data.epochMs - (Date.now() - rtt / 2) - (t1 - t0) / 2 + rtt / 2;
      this.clockOffsetMs = data.epochMs + rtt / 2 - Date.now();
      this.online = true;
    } catch {
      this.online = false;
      this.clockOffsetMs = 0;
    }
    return this.online;
  }

  /** Authoritative now (falls back to the local clock when offline). */
  now() {
    return new Date(Date.now() + this.clockOffsetMs);
  }

  /** Fetch today's daily descriptor from the host, or compute locally. */
  async dailyInfo(localLevel) {
    try {
      const res = await fetchWithTimeout(`${API}/daily?day=${localLevel.day}`, {}, 3000);
      if (res.ok) {
        const data = await res.json();
        if (data && data.seed && !data.excluded) {
          return { seed: data.seed, excluded: false, source: 'host' };
        }
        if (data?.excluded) return { seed: localLevel.seed, excluded: true, source: 'host' };
      }
    } catch {
      /* offline — local algorithm is identical */
    }
    return { seed: localLevel.seed, excluded: false, source: 'local' };
  }

  /**
   * Submit a result for a board. Ranked boards carry the replay envelope for
   * authoritative validation; if validation is unavailable the board is
   * labeled casual and plausibility checks apply (server-side).
   */
  async submitScore(board, { level, result, envelope }) {
    const payload = {
      board,
      contentId: level.id,
      rulesetId: result.rulesetId,
      contentVersion: level.version,
      seed: level.seed,
      assists: { hintsUsed: result.hintsUsed, undosUsed: result.undosUsed },
      durationMs: result.elapsedMs,
      result,
      envelope,
      name: this.store.doc.profile.displayName,
    };
    try {
      const res = await fetchWithTimeout(`${API}/score`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-player-id': this.playerId },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error ?? 'http ' + res.status, queued: false };
      return { ok: true, ...data };
    } catch {
      this.store.queueOutbox({ type: 'score', payload });
      return { ok: false, queued: true };
    }
  }

  /** Global or friends-filtered board; local boards merge when offline. */
  async leaderboard(board, { friends = false, limit = 20 } = {}) {
    try {
      const res = await fetchWithTimeout(
        `${API}/leaderboard?board=${encodeURIComponent(board)}&friends=${friends ? 1 : 0}&limit=${limit}`,
        { headers: { 'x-player-id': this.playerId } },
        3000,
      );
      if (res.ok) {
        const data = await res.json();
        return { entries: data.entries ?? [], casual: !!data.casual, source: 'host' };
      }
    } catch {
      /* fall through to local */
    }
    const local = this.store.doc.boards[board] ?? [];
    return { entries: local.slice(0, limit), casual: true, source: 'local' };
  }

  /** Durable achievement delivery (idempotent both sides). */
  async reportAchievement(key) {
    try {
      await fetchWithTimeout(
        `${API}/achievements`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-player-id': this.playerId },
          body: JSON.stringify({ key }),
        },
        3000,
      );
    } catch {
      this.store.queueOutbox({ type: 'achievement', payload: { key } });
    }
  }

  /** Throttled presence heartbeat while actively playing. */
  startPresence(getStatus) {
    this.stopPresence();
    this._presenceTimer = setInterval(() => {
      if (!this.online) return;
      fetchWithTimeout(
        `${API}/presence`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-player-id': this.playerId },
          body: JSON.stringify({ status: getStatus() }),
        },
        3000,
      ).catch(() => {});
    }, 30000);
  }

  stopPresence() {
    if (this._presenceTimer) clearInterval(this._presenceTimer);
    this._presenceTimer = null;
  }

  /** Activity start/end pairing so host playtime is accurate. */
  activityStart() {
    if (this._activityStarted) return;
    this._activityStarted = true;
    this._postActivity('start');
  }

  activityEnd() {
    if (!this._activityStarted) return;
    this._activityStarted = false;
    this._postActivity('end');
  }

  _postActivity(kind) {
    if (!this.online) return;
    fetchWithTimeout(
      `${API}/activity`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-player-id': this.playerId },
        body: JSON.stringify({ kind, at: Date.now() }),
      },
      3000,
    ).catch(() => {});
  }

  /**
   * Anonymous funnel telemetry — only whitelisted event names, no raw text,
   * no pointers, gated on explicit consent (spec §6/§8).
   */
  setTelemetryConsent(consent) {
    this._telemetryConsent = consent;
  }

  track(event, data = {}) {
    const ALLOWED = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
    if (!this._telemetryConsent || !ALLOWED.includes(event)) return;
    this._telemetryQueue.push({ event, ...data, at: Date.now() });
    if (this._telemetryQueue.length >= 8) this._flushTelemetry();
  }

  _flushTelemetry() {
    if (!this.online || this._telemetryQueue.length === 0) return;
    const batch = this._telemetryQueue.splice(0, this._telemetryQueue.length);
    fetchWithTimeout(
      `${API}/telemetry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-player-id': this.playerId },
        body: JSON.stringify({ batch }),
      },
      3000,
    ).catch(() => {});
  }

  /** Re-send everything queued while offline. */
  async flushOutbox() {
    const items = this.store.drainOutbox();
    for (const item of items) {
      try {
        if (item.type === 'score') {
          await fetchWithTimeout(`${API}/score`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-player-id': this.playerId },
            body: JSON.stringify(item.payload),
          });
        } else if (item.type === 'achievement') {
          await fetchWithTimeout(`${API}/achievements`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-player-id': this.playerId },
            body: JSON.stringify(item.payload),
          });
        }
      } catch {
        this.store.queueOutbox(item); // still offline — keep it
      }
    }
  }
}

function readLaunchToken() {
  try {
    const q = new URLSearchParams(location.search);
    return q.get('launch_token') ?? globalThis.STARHERMIT_LAUNCH ?? null;
  } catch {
    return null;
  }
}

function readScope(token) {
  // Best-effort unverified decode of the scope claim — the host shell is the
  // trust boundary; the game only uses this to label content.
  if (!token) return { game: 'trio-tiles', hosted: false };
  try {
    const parts = token.split('.');
    if (parts.length >= 2) {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return { game: payload.game ?? payload.scope ?? 'trio-tiles', hosted: true };
    }
  } catch {
    /* opaque token — fine */
  }
  return { game: 'trio-tiles', hosted: true };
}

async function fetchWithTimeout(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
