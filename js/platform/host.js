/**
 * Platform adapter — StarHermit host integration with a complete offline
 * fallback. Same-origin `/api` routes are used when hosted; guest practice
 * works fully offline.
 *
 * Launch tokens arrive in the URL fragment (`#game_token=<jwt>`), are read
 * once, and are stripped from the location bar; query param / injected-global
 * fallbacks exist for local dev only. The token (and any refreshed token) is
 * sent as `Authorization: Bearer` on every REST call and is NEVER persisted.
 *
 * Hosted mode calls only documented platform routes:
 *   GET  /api/v1/time                          online probe + clock sync
 *   GET  /api/v1/users/{sub}/profile           account nickname
 *   GET  /api/v1/games/{slug}                  leaderboard id + my stats
 *   GET  /api/v1/leaderboards/{id}/entries     read-only global board
 *   GET/PUT /api/v1/me/cloud-saves/{slug}      zip+base64 save slot
 *   POST /api/v1/games/{slug}/launch-token     45-min token refresh
 * The fabricated own-server routes (score submission, daily session,
 * presence/activity/telemetry) are reached only when running without a token
 * against the game's own dev server (npm start).
 */

import { hashString } from '../rules/rng.js';

const API = '/api/v1';
const TOKEN_REFRESH_MS = 45 * 60 * 1000;
const TOKEN_RETRY_MS = 60 * 1000;
const CLOUD_DEBOUNCE_MS = 2000;

export class HostPlatform {
  constructor(store) {
    this.store = store;
    this.online = false;
    this.clockOffsetMs = 0;
    this.launchToken = readLaunchToken();
    this.scope = readScope(this.launchToken);
    this.slug = this.scope.game;
    this.playerId = null;
    this.nickname = null;
    this.gameInfo = null;
    this.syncState = 'offline'; // offline | saving | synced | error
    this.onSyncChange = null;
    this._nameCache = new Map();
    this._cloudTimer = null;
    this._cloudFlushing = false;
    this._presenceTimer = null;
    this._telemetryQueue = [];
    this._telemetryConsent = false;
    this._activityStarted = false;
  }

  /** Boot handshake: probe the host, load identity/cloud save, sync the clock. */
  async init() {
    this.playerId = this.store.doc.profile.guestId;
    if (!this.playerId) {
      this.playerId = 'g-' + hashString('guest:' + Math.random() + Date.now()).slice(0, 12);
      this.store.doc.profile.guestId = this.playerId;
      this.store.save();
    }
    if (this.scope.hosted) {
      this._initCloudMirror();
      await this.loadProfile();
      await this.loadGameInfo();
      await this._loadCloud();
      this._scheduleTokenRefresh();
    }
    await this.syncTime();
  }

  /** Every hosted REST call carries the launch token as a Bearer token. */
  _headers(extra = {}) {
    const h = { ...extra };
    if (this.launchToken) h.authorization = `Bearer ${this.launchToken}`;
    return h;
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /**
   * Account nickname for the launch-token subject. NEVER /api/v1/me (403 for
   * launch tokens) and never the username — nickname only, with the
   * "Player "+id8 fallback from the platform contract.
   */
  async loadProfile() {
    if (!this.scope.hosted || !this.scope.sub) return null;
    try {
      const res = await fetchWithTimeout(
        `${API}/users/${encodeURIComponent(this.scope.sub)}/profile`,
        { headers: this._headers() },
        5000,
      );
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      if (data?.nickname) {
        this.nickname = data.nickname;
        return data;
      }
    } catch {
      /* offline — fallback name is used */
    }
    return null;
  }

  /** Display name for the title/profile slot: account nickname when hosted. */
  profileName() {
    if (this.scope.hosted) {
      return this.nickname ?? 'Player ' + String(this.scope.sub ?? '').slice(0, 8);
    }
    return this.store.doc.profile.displayName;
  }

  /** Resolve a leaderboard userId to a nickname (cached, same fallback). */
  async nicknameFor(userId) {
    if (!this._nameCache.has(userId)) {
      let name = null;
      try {
        const res = await fetchWithTimeout(
          `${API}/users/${encodeURIComponent(userId)}/profile`,
          { headers: this._headers() },
          5000,
        );
        const data = res.ok ? await res.json().catch(() => null) : null;
        name = data?.nickname ?? null;
      } catch {
        /* offline — fallback below */
      }
      this._nameCache.set(userId, name ?? 'Player ' + String(userId).slice(0, 8));
    }
    return this._nameCache.get(userId);
  }

  // -------------------------------------------------------------------------
  // Launch token refresh (tokens live 60 min; re-mint every 45)
  // -------------------------------------------------------------------------

  _scheduleTokenRefresh() {
    setInterval(() => this._refreshToken(), TOKEN_REFRESH_MS);
  }

  async _refreshToken() {
    try {
      const res = await fetchWithTimeout(
        `${API}/games/${encodeURIComponent(this.slug)}/launch-token`,
        { method: 'POST', headers: this._headers({ 'content-type': 'application/json' }), body: '{}' },
        8000,
      );
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json().catch(() => null);
      if (data?.token) this.launchToken = data.token;
    } catch {
      setTimeout(() => this._refreshToken(), TOKEN_RETRY_MS);
    }
  }

  // -------------------------------------------------------------------------
  // Clock
  // -------------------------------------------------------------------------

  /** Round-trip-adjusted server time sync (spec §6). */
  async syncTime() {
    const t0 = performance.now();
    try {
      const res = await fetchWithTimeout(`${API}/time`, { headers: this._headers() }, 3000);
      if (!res.ok) throw new Error('http ' + res.status);
      const t1 = performance.now();
      const data = await res.json();
      const rtt = t1 - t0;
      // Server stamp + half the round trip ≈ server time at response arrival.
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

  // -------------------------------------------------------------------------
  // Daily challenge
  // -------------------------------------------------------------------------

  /** Fetch today's daily descriptor from the dev server, or compute locally. */
  async dailyInfo(localLevel) {
    if (!this.scope.hosted) {
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
    }
    // Hosted: the platform publishes no daily route; the local algorithm is
    // the same deterministic UTC-day seed for every player.
    return { seed: localLevel.seed, excluded: false, source: 'local' };
  }

  /** Durable daily session snapshot (dev server only; returns null hosted). */
  async dailySessionFetch(day) {
    if (this.scope.hosted) return null;
    try {
      const res = await fetchWithTimeout(`${API}/daily/session?day=${day}`, {}, 3000);
      if (res.ok) return await res.json();
    } catch {
      /* offline */
    }
    return null;
  }

  /** Throttled durable daily snapshot POST (dev server only). */
  dailySessionSave(payload) {
    if (this.scope.hosted || !this.online) return;
    fetchWithTimeout(
      `${API}/daily/session`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
      3000,
    ).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Leaderboards — read-only on-platform; clients never submit scores
  // -------------------------------------------------------------------------

  /** Hosted game descriptor: leaderboardId + my stats (null when absent). */
  async loadGameInfo() {
    if (!this.scope.hosted) return null;
    try {
      const res = await fetchWithTimeout(
        `${API}/games/${encodeURIComponent(this.slug)}`,
        { headers: this._headers() },
        5000,
      );
      if (!res.ok) return null;
      this.gameInfo = await res.json().catch(() => null);
      return this.gameInfo;
    } catch {
      return null;
    }
  }

  /** Read one page of the platform leaderboard, resolving nicknames. */
  async platformEntries({ friends = false, limit = 20 } = {}) {
    const lbId = this.gameInfo?.leaderboardId;
    if (!this.scope.hosted || !lbId) return null;
    try {
      const res = await fetchWithTimeout(
        `${API}/leaderboards/${encodeURIComponent(lbId)}/entries?friendsOnly=${friends ? 1 : 0}&page=1&pageSize=${limit}`,
        { headers: this._headers() },
        5000,
      );
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      const list = data?.entries ?? (Array.isArray(data) ? data : []);
      const entries = [];
      for (let i = 0; i < list.length; i++) {
        const e = list[i] ?? {};
        const uid = e.userId ?? e.user_id ?? null;
        entries.push({
          rank: e.rank ?? i + 1,
          name: uid ? await this.nicknameFor(uid) : (e.nickname ?? 'Player'),
          score: e.score ?? e.value ?? 0,
          elapsedMs: e.elapsedMs ?? e.durationMs ?? 0,
        });
      }
      return { entries, me: data?.me ?? this.gameInfo?.me ?? null };
    } catch {
      return null;
    }
  }

  /**
   * Board data for one of the game's boards. Hosted: the platform's global
   * entries (read-only) plus local bests. Dev/offline: dev server board or
   * local bests.
   */
  async leaderboard(board, { friends = false, limit = 20 } = {}) {
    const local = (this.store.doc.boards[board] ?? []).slice(0, limit);
    if (this.scope.hosted) {
      const global = await this.platformEntries({ friends, limit });
      return {
        entries: global?.entries ?? [],
        me: global?.me ?? null,
        local,
        source: global ? 'host' : 'local',
        casual: false,
      };
    }
    try {
      const res = await fetchWithTimeout(
        `${API}/leaderboard?board=${encodeURIComponent(board)}&friends=${friends ? 1 : 0}&limit=${limit}`,
        {},
        3000,
      );
      if (res.ok) {
        const data = await res.json();
        return { entries: data.entries ?? [], local, source: 'host', casual: !!data.casual };
      }
    } catch {
      /* fall through to local */
    }
    return { entries: local, local, source: 'local', casual: true };
  }

  // -------------------------------------------------------------------------
  // Cloud save — one zip+base64 slot mirroring the localStorage document
  // -------------------------------------------------------------------------

  _initCloudMirror() {
    // Every store.save() (localStorage cache write) schedules a debounced
    // cloud mirror upload; localStorage remains the offline cache of record.
    const origSave = this.store.save.bind(this.store);
    this.store.save = (...args) => {
      origSave(...args);
      this._scheduleCloudSave();
    };
    window.addEventListener('pagehide', () => this._flushCloudSave(true));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._flushCloudSave(true);
    });
  }

  _setSync(state) {
    this.syncState = state;
    this.onSyncChange?.(state);
  }

  /** Small label for the title screen sync badge (hosted only). */
  syncLabel() {
    if (!this.scope.hosted) return null;
    switch (this.syncState) {
      case 'saving':
        return 'saving…';
      case 'synced':
        return 'cloud synced';
      case 'error':
        return 'sync unavailable';
      default:
        return 'offline';
    }
  }

  async _loadCloud() {
    try {
      const res = await fetchWithTimeout(
        `${API}/me/cloud-saves/${encodeURIComponent(this.slug)}`,
        { headers: this._headers() },
        5000,
      );
      if (res.status === 404) {
        this._setSync('synced');
        return;
      }
      if (!res.ok) throw new Error('http ' + res.status);
      let bytes = null;
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('json')) {
        const data = await res.json().catch(() => null);
        if (data?.dataBase64) bytes = base64ToBytes(data.dataBase64);
      } else {
        bytes = new Uint8Array(await res.arrayBuffer());
      }
      if (!bytes) throw new Error('empty save');
      const doc = JSON.parse(new TextDecoder().decode(unzipFirstEntry(bytes)));
      const verdict = this.store.mergeRemote(doc);
      // Platform contract: on conflict prefer the remote document.
      if (verdict.status === 'conflict') this.store.resolveConflict('remote');
      this._setSync('synced');
    } catch {
      this._setSync('error'); // local save stays authoritative offline
    }
  }

  _scheduleCloudSave() {
    if (!this.scope.hosted) return;
    this._setSync('saving');
    clearTimeout(this._cloudTimer);
    this._cloudTimer = setTimeout(() => this._flushCloudSave(), CLOUD_DEBOUNCE_MS);
  }

  async _flushCloudSave(keepalive = false) {
    if (!this.scope.hosted || this._cloudFlushing) return;
    clearTimeout(this._cloudTimer);
    this._cloudTimer = null;
    this._cloudFlushing = true;
    this._setSync('saving');
    try {
      const dataBytes = new TextEncoder().encode(JSON.stringify(this.store.doc));
      const zip = zipStore('save.json', dataBytes);
      const res = await fetchWithTimeout(
        `${API}/me/cloud-saves/${encodeURIComponent(this.slug)}`,
        {
          method: 'PUT',
          headers: this._headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({ dataBase64: bytesToBase64(zip) }),
          keepalive,
        },
        5000,
      );
      this._setSync(res.ok ? 'synced' : 'error');
    } catch {
      this._setSync('error'); // stays queued in localStorage for next time
    } finally {
      this._cloudFlushing = false;
    }
  }

  // -------------------------------------------------------------------------
  // Local unlock mirroring — achievements stay local (no Jint game script)
  // -------------------------------------------------------------------------

  /** Achievements are part of the cloud-saved doc; nothing to report. */
  reportAchievement(_key) {}

  // -------------------------------------------------------------------------
  // Presence / activity / telemetry — dev server only, never on-platform
  // -------------------------------------------------------------------------

  /** Throttled presence heartbeat while actively playing (dev server only). */
  startPresence(getStatus) {
    this.stopPresence();
    if (this.scope.hosted) return;
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

  /** Activity start/end pairing so dev-server playtime is accurate. */
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
    if (this.scope.hosted || !this.online) return;
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
   * no pointers, gated on explicit consent (spec §6/§8). Dev server only.
   */
  setTelemetryConsent(consent) {
    this._telemetryConsent = consent;
  }

  track(event, data = {}) {
    const ALLOWED = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
    if (this.scope.hosted || !this._telemetryConsent || !ALLOWED.includes(event)) return;
    this._telemetryQueue.push({ event, ...data, at: Date.now() });
    if (this._telemetryQueue.length >= 8) this._flushTelemetry();
  }

  _flushTelemetry() {
    if (this.scope.hosted || !this.online || this._telemetryQueue.length === 0) return;
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
}

// ---------------------------------------------------------------------------
// Launch token
// ---------------------------------------------------------------------------

/**
 * Read the launch token once: the platform delivers it in the URL fragment
 * (`#game_token=<jwt>`), after which it is stripped from the location bar.
 * Query params and the injected global are local-dev fallbacks only. The
 * token is never written to storage.
 */
function readLaunchToken() {
  let token = null;
  try {
    const frag = new URLSearchParams(location.hash.slice(1));
    token = frag.get('game_token');
    if (token) {
      frag.delete('game_token');
      const rest = frag.toString();
      history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
    }
  } catch {
    /* no location — treat as unhosted */
  }
  if (token) return token;
  try {
    const q = new URLSearchParams(location.search);
    return q.get('launch_token') ?? q.get('token') ?? q.get('launch') ?? globalThis.STARHERMIT_LAUNCH ?? null;
  } catch {
    return null;
  }
}

function readScope(token) {
  // Best-effort unverified decode — the host shell is the trust boundary; the
  // game only uses these claims for labeling and API paths.
  if (!token) return { game: 'trio-tiles', hosted: false, sub: null };
  try {
    const parts = token.split('.');
    if (parts.length >= 2) {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return {
        game: payload.game_scope ?? payload.game ?? payload.scope ?? 'trio-tiles',
        hosted: true,
        sub: payload.sub ?? null,
      };
    }
  } catch {
    /* opaque token — still hosted */
  }
  return { game: 'trio-tiles', hosted: true, sub: null };
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer/reader (stored entries only, no compression)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}

function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
