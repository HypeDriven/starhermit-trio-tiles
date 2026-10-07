/**
 * Platform adapter — StarHermit integration through the canonical SDK
 * (`starhermit-sdk.js`, global `StarHermit`, initialised from index.html
 * before any module runs). Guest play is fully local and makes no network
 * calls at all.
 *
 * Hosted (launch token present):
 *   - identity: profile nickname (fallback "Player <id prefix>")
 *   - clock: GET /api/v1/time (round-trip adjusted)
 *   - cloud save: the whole SaveStore document in the `game:<slug>` slot,
 *     remote-first on boot (conflicts prefer remote), debounced mirror of
 *     every local save, flushed on pagehide
 *   - settings KV mirror, control bindings, invite share link
 *   - read-only platform leaderboard (clients never submit scores)
 *   - launch-token renewal (SDK); a refused renewal drops to local play
 */

const API = '/api/v1';

export class HostPlatform {
  constructor(store, sh = globalThis.StarHermit ?? null) {
    this.store = store;
    this.sh = sh;
    this.online = false;
    this.clockOffsetMs = 0;
    this.scope = { hosted: !!sh?.token, sub: sh?.userId ?? null, game: sh?.slug ?? null };
    this.slug = this.scope.game;
    this.playerId = null;
    this.nickname = null;
    this.syncState = 'offline'; // offline | saving | synced | error
    this.onSyncChange = null;
    this.onAuthChange = null; // (signedIn) => void
    this._mirrorInstalled = false;
    if (sh) {
      sh.on('saved', (ok) => this.scope.hosted && this._setSync(ok ? 'synced' : 'error'));
      sh.on('auth', (e) => {
        if (e?.signedIn) return;
        this.scope.hosted = false;
        this.online = false;
        this._setSync('offline');
        this.onAuthChange?.(false);
      });
    }
  }

  /** Boot handshake: identity, cloud save and clock — only when hosted. */
  async init() {
    if (this.scope.hosted) {
      this.online = true;
      await this.syncTime();
      await this.loadProfile();
      await this._loadCloud();
    }
    // A fresh guest id is persisted only after the cloud compare: save() stamps
    // updatedAt, which would make a fresh device's empty doc beat a newer cloud save.
    this.playerId = this.store.doc.profile.guestId;
    if (!this.playerId) {
      this.playerId = 'g-' + Math.random().toString(36).slice(2, 14);
      this.store.doc.profile.guestId = this.playerId;
      this.store.save();
    }
    if (this.scope.hosted) this._initCloudMirror();
  }

  // -------------------------------------------------------------------------
  // Identity, sign-in, invites
  // -------------------------------------------------------------------------

  async loadProfile() {
    const p = await this.sh.profile();
    if (p) this.nickname = p.displayName;
    return p;
  }

  /** Display name for the title/profile slot: account nickname when hosted. */
  profileName() {
    if (this.scope.hosted) return this.nickname ?? 'Player ' + String(this.scope.sub ?? '').slice(0, 6);
    return this.store.doc.profile.displayName;
  }

  async nicknameFor(userId) {
    const p = this.scope.hosted ? await this.sh.profile(userId) : null;
    return p?.displayName ?? 'Player ' + String(userId).slice(0, 6);
  }

  canSignIn() {
    return !!this.sh?.canSignIn();
  }

  signIn() {
    return !!this.sh?.signIn();
  }

  inviteLink() {
    return this.scope.hosted ? this.sh.inviteLink() : null;
  }

  // -------------------------------------------------------------------------
  // Settings KV + controls
  // -------------------------------------------------------------------------

  async getSettings() {
    return this.scope.hosted ? this.sh.getSettings() : {};
  }

  patchSettings(patch) {
    if (this.scope.hosted) this.sh.patchSettings(patch);
  }

  async loadBindings(defaults) {
    if (this.scope.hosted) return this.sh.loadBindings(defaults);
    return Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, v.slice()]));
  }

  // -------------------------------------------------------------------------
  // Clock
  // -------------------------------------------------------------------------

  async syncTime() {
    if (!this.scope.hosted) return false;
    const t0 = performance.now();
    try {
      const data = await this.sh.api(`${API}/time`);
      const rtt = performance.now() - t0;
      const serverMs = Number(data?.epochMs ?? data?.now ?? data?.serverTime);
      if (Number.isFinite(serverMs)) this.clockOffsetMs = serverMs + rtt / 2 - Date.now();
    } catch {
      this.clockOffsetMs = 0;
    }
    return true;
  }

  now() {
    return new Date(Date.now() + this.clockOffsetMs);
  }

  // -------------------------------------------------------------------------
  // Daily challenge — the seed is a deterministic UTC-day algorithm
  // -------------------------------------------------------------------------

  async dailyInfo(localLevel) {
    return { seed: localLevel.seed, excluded: false, source: 'local' };
  }

  /** No platform route keeps daily snapshots; nothing to resume remotely. */
  async dailySessionFetch(_day) {
    return null;
  }

  dailySessionSave(_payload) {}

  // -------------------------------------------------------------------------
  // Leaderboards — platform board reads and the finished-round score post
  // -------------------------------------------------------------------------

  /**
   * Post a finished ranked round's score to the `high-score` board
   * (score-script.js); resolves { posted, rank } — the player's rank there, or
   * null. Not hosted → not posted, no request.
   */
  async submitScore(score) {
    if (!this.scope.hosted || typeof this.sh?.submitScores !== 'function') return { posted: false, rank: null };
    let keys = [];
    try { keys = await this.sh.submitScores({ 'high-score': Math.max(0, Math.round(score)) }); } catch { keys = []; }
    if (!keys.includes('high-score')) return { posted: false, rank: null };
    try {
      const r = await this.sh.leaderboard('high-score', { pageSize: 100 });
      const me = (r.items ?? []).find((i) => i.userId === this.sh.userId);
      return { posted: true, rank: me ? me.rank : null };
    } catch { return { posted: true, rank: null }; }
  }

  async platformEntries({ friends = false, limit = 20 } = {}) {
    if (!this.scope.hosted) return null;
    const r = await this.sh.leaderboard(null, { pageSize: limit, scope: friends ? 'friends' : undefined });
    if (!r.board) return null;
    const entries = [];
    for (const [i, e] of (r.items ?? []).entries()) {
      entries.push({
        rank: e.rank ?? i + 1,
        name: e.nickname ?? (e.userId ? await this.nicknameFor(e.userId) : e.username ?? 'Player'),
        score: e.score ?? 0,
        elapsedMs: e.elapsedMs ?? e.durationMs ?? 0,
      });
    }
    return { entries, me: r.me ?? null };
  }

  /** Hosted: platform entries (read-only) plus local bests; otherwise local. */
  async leaderboard(board, { friends = false, limit = 20 } = {}) {
    const local = (this.store.doc.boards[board] ?? []).slice(0, limit);
    if (this.scope.hosted) {
      const global = await this.platformEntries({ friends, limit });
      return { entries: global?.entries ?? [], me: global?.me ?? null, local, source: global ? 'host' : 'local', casual: false };
    }
    return { entries: local, local, source: 'local', casual: true };
  }

  // -------------------------------------------------------------------------
  // Cloud save — the SaveStore document in the game:<slug> slot
  // -------------------------------------------------------------------------

  _initCloudMirror() {
    if (this._mirrorInstalled) return;
    this._mirrorInstalled = true;
    const origSave = this.store.save.bind(this.store);
    this.store.save = (...args) => {
      origSave(...args);
      if (this.scope.hosted) {
        this._setSync('saving');
        this.sh.saveJSON(this.store.doc, 2000);
      }
    };
    globalThis.addEventListener?.('pagehide', () => this.scope.hosted && this.sh.flushSave(true));
    globalThis.document?.addEventListener('visibilitychange', () => {
      if (document.hidden && this.scope.hosted) this.sh.flushSave(true);
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
    const doc = await this.sh.loadJSON();
    if (doc) {
      const verdict = this.store.mergeRemote(doc);
      // Platform contract: on conflict prefer the remote document.
      if (verdict.status === 'conflict') this.store.resolveConflict('remote');
    }
    this._setSync('synced');
  }

  async _flushCloudSave(keepalive = false) {
    if (this.scope.hosted) return this.sh.flushSave(keepalive);
    return false;
  }

  // -------------------------------------------------------------------------
  // Achievements stay local (part of the cloud-saved doc); the client can
  // never write platform achievements. Presence/activity/telemetry have no
  // route a launch token may reach, so these are deliberate no-ops.
  // -------------------------------------------------------------------------

  reportAchievement(_key) {}
  startPresence(_getStatus) {}
  stopPresence() {}
  activityStart() {}
  activityEnd() {}
  setTelemetryConsent(_consent) {}
  track(_event, _data) {}
}
