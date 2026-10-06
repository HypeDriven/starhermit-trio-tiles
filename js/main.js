/**
 * Trio Tiles bootstrap + application state machine.
 *
 * Phases: boot → title → mode-select → setup → preparing → active ↔ paused
 *         → resolving → results.
 * The rules engine is authoritative: every rules-visible action goes through
 * Session.submit (validated commands). Rendering consumes snapshots; the UI
 * never mutates state. Input sources: pointer/touch (tap vs drag thresholds),
 * keyboard (arrows/Enter/Esc/U/H/C), and gamepad polling.
 */

import {
  legalActions,
  scoreBreakdown,
  INVALID_REASONS,
} from './rules/engine.js';
import {
  JOURNEY,
  JOURNEY_CHAPTERS,
  LESSONS,
  lessonLevel,
  CHALLENGES,
  PRACTICE_DIFFICULTIES,
  practiceLevel,
  dailyLevel,
  todayUTC,
  materializeLevel,
  THEMES,
  ACHIEVEMENTS,
} from './rules/content.js';
import { SYMBOL_NAMES } from './rules/layout.js';
import { suggestMove } from './rules/solver.js';
import { Session } from './session/session.js';
import { SaveStore, DEFAULT_SETTINGS } from './session/storage.js';
import { HostPlatform } from './platform/host.js';
import { platformStrings } from './ui/platform-strings.js';
import { AudioEngine } from './audio/audio.js';
import { TeaScene } from './render/scene.js';
import { fromLegacyTier } from './render/gfx.js';
import { UI, fmtMs } from './ui/ui.js';

const TICK_MS = 250; // fixed simulation quantum submitted while active
const TAP_MAX_DIST = 12; // px — tap vs camera-drag threshold
const TAP_MAX_MS = 600;
const HOLD_MS = 400; // hold-to-confirm accessibility option

// Keyboard actions — mirrored as control.* lines in starhermit.txt.
const DEFAULT_BINDINGS = {
  focus_left: ['ArrowLeft'],
  focus_right: ['ArrowRight'],
  focus_up: ['ArrowUp'],
  focus_down: ['ArrowDown'],
  pick: ['Enter', 'Space', 'NumpadEnter'],
  undo: ['KeyU'],
  hint: ['KeyH'],
  camera: ['KeyC'],
  pause: ['Escape'],
};
const FOCUS_KEYS = { focus_left: 'ArrowLeft', focus_right: 'ArrowRight', focus_up: 'ArrowUp', focus_down: 'ArrowDown' };
const KEY_GLYPHS = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', NumpadEnter: 'Num Enter' };
function keyLabel(code) {
  if (KEY_GLYPHS[code]) return KEY_GLYPHS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}

// Player preferences mirrored to the StarHermit settings KV.
const SYNCED_SETTINGS = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'graphicsTier' && k !== 'tutorialSeen');

class App {
  constructor() {
    this.phase = 'boot';
    this.store = new SaveStore();
    this.host = new HostPlatform(this.store);
    this.ui = new UI(this._uiActions());
    this.pt = platformStrings();
    this.bindings = DEFAULT_BINDINGS;
    this.codeAction = {};
    this.audio = new AudioEngine(this.store.settings);
    this.audio.onCaption = (t) => this.ui.caption(t);
    this.session = null;
    this.round = null; // { mode, level, lesson, stepIndex }
    this.focusIndex = -1;
    this._tickTimer = null;
    this._snapshotTimer = null;
    this._lastFrame = performance.now();
    this._padPrev = [];
    this._pointer = null;
    this._gestureUnlocked = false;
  }

  // -------------------------------------------------------------------------
  // Boot: capability detection, scene, host handshake, settings
  // -------------------------------------------------------------------------

  async boot() {
    this.ui.showScreen('boot');
    this.ui.boot(1, 4, 'Reading the save…');
    this._applySettings();

    this.ui.boot(2, 4, 'Checking WebGL…');
    if (!webglAvailable()) {
      this.ui.showScreen('nogl');
      return;
    }

    this.ui.boot(3, 4, 'Setting the table…');
    this.scene = new TeaScene(document.getElementById('game-canvas'), {
      graphics: this._graphicsSaved(),
      reducedMotion: this.store.settings.reducedMotion,
      colorblindPalette: this.store.settings.colorblindPalette,
      onContextLost: () => this._onContextLost(),
    });
    this._refreshGraphicsPanel();
    this._bindFraming();
    this._bindInputs();

    this.ui.boot(4, 4, 'Contacting the host…');
    this.host.setTelemetryConsent(!!this.store.settings.telemetryConsent);
    this.host.onSyncChange = () => {
      if (this.phase === 'title') this._refreshTitle();
    };
    this.host.onAuthChange = () => {
      this.ui.caption(this.pt('signedOut'));
      this._refreshTitle();
    };
    this._setBindings(DEFAULT_BINDINGS);
    try {
      await this.host.init();
      if (this.host.scope.hosted) {
        this._setBindings(await this.host.loadBindings(DEFAULT_BINDINGS));
        this._applyRemoteSettings(await this.host.getSettings());
      }
    } catch {
      /* offline boot is fully supported */
    }
    this.host.track('start', { hosted: this.host.scope.hosted });

    this._refreshTitle();
    this._setPhase('title');
    this.ui.showScreen('title');
    requestAnimationFrame((t) => this._frame(t));
  }

  _setPhase(phase) {
    this.phase = phase;
  }

  _refreshTitle() {
    const p = this.store.doc.progression;
    const journeyDone = Object.values(p.journey).filter((s) => s.stars > 0).length;
    this.ui.setTitleInfo({
      name: this.host.profileName(),
      online: this.host.online,
      sync: this.host.syncLabel(),
      progressText:
        p.roundsPlayed > 0
          ? `Journey ${journeyDone}/${JOURNEY.length} · ${p.roundsWon} tables cleared · daily streak ${this.store.doc.daily.streak}`
          : 'Fresh table — the kettle is on.',
    });
    this.ui.setPlatformButtons({
      signIn: this.host.canSignIn(),
      invite: this.host.scope.hosted && !!this.host.inviteLink(),
      t: this.pt,
    });
    this.ui.setModeMeta({
      journey: journeyDone > 0 ? `${journeyDone}/${JOURNEY.length} stages cleared` : '',
      daily: this.store.doc.daily.streak > 0 ? `streak ${this.store.doc.daily.streak}` : '',
    });
  }

  // -------------------------------------------------------------------------
  // UI action map
  // -------------------------------------------------------------------------

  _uiActions() {
    return {
      play: () => {
        this._unlockAudio();
        this._setPhase('mode-select');
        this.ui.showScreen('modes');
      },
      modeSelected: (mode) => this._openMode(mode),
      nav: (target) => this._nav(target),
      setupPicked: (id) => this._setupPicked(id),
      pause: () => this.pauseGame(),
      resume: () => this.resumeGame(),
      leaveRound: () => this.leaveRound(),
      undo: () => this.doUndo(),
      hint: () => this.doHint(),
      cameraReset: () => this.scene?.resetCamera(),
      retry: () => this._retry(),
      next: () => this._next(),
      mirrorSelect: (tileId) => this.selectTile(tileId),
      mirrorFocus: (tileId) => this.scene?.setFocus(tileId),
      settingsChanged: (patch) => this._settingsChanged(patch),
      graphicsChanged: (next) => this._graphicsChanged(next),
      profileRename: () => this._renameProfile(),
      signIn: () => this.host.signIn(),
      invite: () => this._copyInvite(),
      replayTutorial: () => {
        this.ui.closePause();
        this._startLesson(LESSONS[0]);
      },
      pauseHelp: () => {
        this.ui.closePause();
        this._helpReturn = 'pause';
        this.ui.showScreen('help');
      },
    };
  }

  _nav(target) {
    if (target === 'back') {
      if (this._helpReturn === 'pause' && this.phase === 'paused') {
        this._helpReturn = null;
        this.ui.showScreen('play');
        this.ui.openPause();
        return;
      }
      target = 'title';
    }
    if (target === 'modes') this._setPhase('mode-select');
    if (target === 'title') {
      this._setPhase('title');
      this._refreshTitle();
    }
    this.ui.showScreen(target);
  }

  async _copyInvite() {
    const link = this.host.inviteLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      this.ui.caption(this.pt('inviteCopied'));
    } catch {
      this.ui.caption(this.pt('inviteFailed', { link }));
    }
  }

  // Keyboard actions route by event.code through the (platform-overridable)
  // bindings declared as control.* lines in starhermit.txt.
  _setBindings(bindings) {
    this.bindings = bindings;
    this.codeAction = {};
    for (const [action, codes] of Object.entries(bindings)) for (const c of codes) this.codeAction[c] = action;
    const k = (a) => (bindings[a] ?? []).map(keyLabel).join(' / ');
    this.ui.setControlsHelp(
      `Tap or click a tile. ${k('focus_left')} ${k('focus_right')} ${k('focus_up')} ${k('focus_down')} move focus between available tiles, ` +
        `${k('pick')} picks, ${k('undo')} undoes, ${k('hint')} hints, ${k('camera')} resets the camera, ${k('pause')} pauses.`,
    );
  }

  /** Platform settings win over local ones when signed in. */
  _applyRemoteSettings(remote) {
    const patch = {};
    for (const key of SYNCED_SETTINGS) {
      const v = remote?.[key];
      if (v === undefined || v === null) continue;
      if (typeof v === typeof DEFAULT_SETTINGS[key]) patch[key] = v;
    }
    if (!Object.keys(patch).length) return;
    const { graphics, ...rest } = patch;
    if (Object.keys(rest).length) this._settingsChanged(rest, { fromPlatform: true });
    if (graphics) this._graphicsChanged(graphics, { fromPlatform: true });
  }

  _renameProfile() {
    if (this.host.scope.hosted) {
      this.ui.caption('Hosted play shows your StarHermit account name.');
      return;
    }
    const name = prompt('Display name (stored locally):', this.store.doc.profile.displayName);
    if (!name) return;
    this.store.doc.profile.displayName = name.replace(/[<>"]/g, '').trim().slice(0, 24) || 'Guest';
    this.store.save();
    this._refreshTitle();
  }

  // -------------------------------------------------------------------------
  // Modes and setup screens
  // -------------------------------------------------------------------------

  async _openMode(mode) {
    this._unlockAudio();
    this._setPhase('setup');
    switch (mode) {
      case 'learn':
        return this.ui.renderSetup({
          title: 'Learn',
          blurb: 'Five short lessons. Each one asks you to perform the rule yourself. Unranked, untimed.',
          groups: [
            {
              items: LESSONS.map((l) => ({
                id: 'lesson:' + l.id,
                label: l.name,
                meta: this.store.doc.progression.lessons[l.id]?.done ? 'completed' : `${l.steps.length} steps`,
              })),
            },
          ],
        });
      case 'journey':
        return this._journeySetup();
      case 'daily':
        return this._dailySetup();
      case 'practice':
        return this.ui.renderSetup({
          title: 'Practice',
          blurb: 'Choose a difficulty. Undo is allowed and results are never ranked.',
          groups: [
            {
              items: PRACTICE_DIFFICULTIES.map((d) => ({
                id: 'practice:' + d.id,
                label: d.name,
                meta: `${d.config.triples * 3} tiles · ${d.config.maxLayers} layers`,
              })),
            },
          ],
        });
      case 'challenge':
        return this.ui.renderSetup({
          title: 'Challenge',
          blurb: 'Constrained rounds: clocks, narrow trays, no hints. Ranked.',
          groups: [
            {
              items: CHALLENGES.map((c) => {
                const rec = this.store.doc.challenges[c.id];
                return {
                  id: 'challenge:' + c.id,
                  label: c.name,
                  meta:
                    [c.blurb, rec?.done ? `best ${rec.bestScore}` : ''].filter(Boolean).join(' — '),
                };
              }),
            },
          ],
        });
      case 'boards':
        return this._boardsSetup(false);
    }
  }

  _journeySetup() {
    const prog = this.store.doc.progression.journey;
    const groups = JOURNEY_CHAPTERS.map((ch) => ({
      heading: `${ch.name}${ch.unlockTheme ? ` — clears unlock the “${THEMES[ch.unlockTheme].name}” theme` : ''}`,
      items: ch.stages.map((id) => {
        const stage = JOURNEY.find((s) => s.id === id);
        const prev = stage.index > 0 ? prog[JOURNEY[stage.index - 1].id] : { stars: 1 };
        const rec = prog[id];
        const unlocked = (prev?.stars ?? 0) > 0;
        return {
          id: 'journey:' + id,
          label: `${stage.name}${stage.mastery ? ' ◆ mastery' : ''}`,
          stars: rec?.stars > 0 ? '★'.repeat(rec.stars) : '',
          meta: unlocked ? `${stage.config.triples * 3} tiles` : 'locked',
          disabled: !unlocked,
        };
      }),
    }));
    this.ui.renderSetup({
      title: 'Journey',
      blurb: 'Win a stage to unlock the next. Every eighth stage is a mastery test. Ranked, no undo.',
      groups,
    });
  }

  async _dailySetup() {
    const local = dailyLevel(todayUTC(this.host.now()));
    const info = await this.host.dailyInfo(local);
    const history = this.store.doc.daily.history[local.day];
    if (info.excluded) {
      return this.ui.renderSetup({
        title: 'Daily Steep',
        blurb: `Today's table (${local.day}) was marked excluded from ranking due to defective content. Practice is still available.`,
        groups: [{ items: [{ id: 'daily:play', label: `Play unranked — ${local.day}`, meta: 'excluded day' }] }],
      });
    }
    let resumeItem = null;
    const snap = await this.host.dailySessionFetch(local.day);
    if (snap && !snap.finished && snap.commands?.length > 0) {
      resumeItem = { id: 'daily:resume', label: 'Resume today’s table', meta: `${snap.commands.length} commands recorded` };
    }
    const items = [];
    if (resumeItem) items.push(resumeItem);
    items.push({
      id: 'daily:play',
      label: history ? `Play again — ${local.day}` : `Play today’s table — ${local.day}`,
      meta: history ? `best today ${history.score} (${history.status})` : `${local.config.triples * 3} tiles · ranked · first attempt counts`,
    });
    this.ui.renderSetup({
      title: 'Daily Steep',
      blurb: 'One shared table per UTC day, synchronized to server time. Your first attempt of the day is the ranked one.',
      groups: [{ items }],
    });
  }

  async _boardsSetup(friends) {
    this.ui.renderSetup({
      title: 'Score Chase',
      blurb: this.host.scope.hosted
        ? 'The global board is platform-owned and read-only here; your local bests are always kept alongside.'
        : 'Validated scores only: every entry was replay-verified by the server. Offline? Your local bests stand in.',
      groups: [
        {
          items: [
            { id: 'board:daily', label: 'Daily board', meta: 'shared seeds' },
            { id: 'board:journey', label: 'Journey board', meta: 'all stages' },
            { id: 'board:challenge', label: 'Challenge board', meta: 'fixed trials' },
          ],
        },
      ],
      extraHtml: `<p class="dim-line">Pick a board to view entries.</p>`,
    });
    this._boardFriends = friends;
  }

  async _showBoard(board) {
    const data = await this.host.leaderboard(board, { friends: !!this._boardFriends, limit: 20 });
    const row = (e, i) =>
      `<tr><td>${e.rank ?? i + 1}</td><td>${escapeHtml(e.name ?? 'Guest')}</td><td>${escapeHtml(
        e.contentId ?? e.day ?? '',
      )}</td><td>${e.score}</td><td>${fmtMs(e.elapsedMs ?? 0)}</td></tr>`;
    const checkbox = `<label><input type="checkbox" id="board-friends" ${this._boardFriends ? 'checked' : ''}> Friends / my entries only</label>`;
    const table = (rows) =>
      `<table class="score-table"><thead><tr><th>#</th><th>Player</th><th>Table</th><th>Score</th><th>Time</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No entries yet.</td></tr>'}</tbody></table>`;
    let html;
    if (this.host.scope.hosted) {
      // Platform leaderboard is read-only; local bests ride along.
      const meLine =
        data.me?.rank != null ? `<p class="dim-line">Your platform rank: ${escapeHtml(String(data.me.rank))}.</p>` : '';
      const global = data.entries.length
        ? `<h3>Global — platform board</h3>${table(data.entries.map(row).join(''))}${meLine}`
        : '<p class="dim-line">Global board is empty or unavailable — the platform records ranked results server-side.</p>';
      const localRows = data.local.map((e, i) => row({ ...e, rank: i + 1 }, i)).join('');
      html = `
        <h2>${board[0].toUpperCase() + board.slice(1)}</h2>
        ${global}
        <h3>Your local bests</h3>
        ${checkbox}
        ${table(localRows)}`;
    } else {
      const rows = data.entries.map(row).join('');
      const source =
        data.source === 'local' ? 'Local bests (offline)' : data.casual ? 'Casual board' : 'Verified board';
      html = `
        <h2>${board[0].toUpperCase() + board.slice(1)} — ${source}</h2>
        ${checkbox}
        ${table(rows)}`;
    }
    document.getElementById('setup-extra').innerHTML = html;
    document.getElementById('board-friends')?.addEventListener('change', (e) => {
      this._boardFriends = e.target.checked;
      this._showBoard(board);
    });
  }

  // -------------------------------------------------------------------------
  // Round lifecycle
  // -------------------------------------------------------------------------

  async _setupPicked(id) {
    this._unlockAudio();
    const [kind, rest] = id.split(':');
    try {
      if (kind === 'lesson') return this._startLesson(LESSONS.find((l) => l.id === rest));
      if (kind === 'journey') return this._startLevel(JOURNEY.find((s) => s.id === rest), 'journey');
      if (kind === 'practice') return this._startLevel(practiceLevel(rest, 'p:' + Date.now()), 'practice');
      if (kind === 'challenge') return this._startLevel(CHALLENGES.find((c) => c.id === rest), 'challenge');
      if (kind === 'board') return this._showBoard(rest);
      if (kind === 'daily') return this._startDaily(rest === 'resume');
    } catch (err) {
      this.host.track('error', { category: 'content' });
      this.ui.error('That table could not be prepared: ' + err.message);
    }
  }

  _startLesson(lesson) {
    if (!lesson) return;
    this.host.track('tutorial_step', { step: lesson.id + ':enter' });
    this._startRound(lessonLevel(lesson), 'learn', lesson);
  }

  async _startDaily(resume) {
    const local = dailyLevel(todayUTC(this.host.now()));
    let snapshot = null;
    if (resume) snapshot = await this.host.dailySessionFetch(local.day);
    this._startRound(local, 'daily', null, snapshot);
  }

  /** Materialize (validating) content, build scene + session, enter play. */
  _startRound(levelDef, mode, lesson = null, snapshot = null) {
    this._setPhase('preparing');
    const level = levelDef.tiles ? levelDef : materializeLevel(levelDef);
    const s = this.store.settings;
    const themeId =
      s.themeChoice !== 'auto' && this.store.doc.progression.unlockedThemes.includes(s.themeChoice)
        ? s.themeChoice
        : level.theme;
    this.scene.setTheme(themeId);
    this.session = new Session(level, {
      sessionId: snapshot?.sessionId,
      assists: { timingAssist: s.timingAssist },
    });
    // Reconnect: replay the durable daily snapshot through the same commands.
    if (snapshot?.commands?.length) {
      let replayOk = true;
      for (const cmd of snapshot.commands) {
        const r = this.session.submit({ ...cmd, id: cmd.id });
        if (!r.ok && !r.duplicate && r.reason !== 'not_active') {
          replayOk = false;
          break;
        }
      }
      if (replayOk) {
        this.session.syncCommandSeq(); // avoid id collisions with the replayed log
        this.ui.caption('Restored your daily table from the server');
      } else {
        this.session = new Session(level, { assists: { timingAssist: s.timingAssist } });
      }
    }
    this.round = { mode, level, lesson, stepIndex: 0, seed: level.seed };
    this.scene.reducedMotion = s.reducedMotion;
    this.scene.rig.reducedMotion = s.reducedMotion;
    this.scene.buildBoard(level, this.session.state);
    this.focusIndex = -1;

    this.ui.showScreen('play');
    this.ui.setObjective(objectiveFor(level, mode), sublineFor(level, mode));
    this.ui.updateHud(this.session.state, level);
    this._refreshMirror();
    this._refreshAssists();
    this._tutorialUpdate();
    this._setPhase('active');
    this._startClock();
    this.host.startPresence(() => `playing ${level.id}`);
    this.host.activityStart();
  }

  _startClock() {
    this._stopClock();
    this._tickTimer = setInterval(() => {
      if (this.phase !== 'active' || document.hidden || !this.session || this.session.finished) return;
      const res = this.session.submit({ type: 'tick', dt: TICK_MS });
      this._afterSubmit(res);
    }, TICK_MS);
  }

  _stopClock() {
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickTimer = null;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  selectTile(tileId) {
    if (this.phase !== 'active' || !this.session) return;
    this._unlockAudio();
    const res = this.session.submit({ type: 'select', tileId });
    this._afterSubmit(res, tileId);
  }

  doUndo() {
    if (this.phase !== 'active' || !this.session) return;
    const res = this.session.submit({ type: 'undo' });
    if (!res.ok) return this._invalidFeedback(res.reason);
    this._afterSubmit(res);
  }

  doHint() {
    if (this.phase !== 'active' || !this.session) return;
    const res = this.session.submit({ type: 'hint' });
    if (!res.ok) return this._invalidFeedback(res.reason);
    const id = suggestMove(this.session.state);
    if (id) {
      this.scene.showHint(id);
      const t = this.session.state.tiles.find((x) => x.id === id);
      this.ui.announce('objective', `Hint: try the ${SYMBOL_NAMES[t?.sym] ?? ''} tile.`);
    }
    this._afterSubmit(res);
  }

  _afterSubmit(res, tileId = null) {
    if (!this.session) return;
    if (!res.ok) return this._invalidFeedback(res.reason, tileId);
    const events = this.session.drainEvents();
    for (const ev of events) {
      this.audio.playEvent(ev);
      if (ev.type === 'pick' && this.store.settings.haptics && navigator.vibrate) navigator.vibrate(8);
    }
    // Tick-only submissions (the 250 ms clock) never change the board: skip
    // the scene reconcile (a full exposure pass) and the mirror/assist DOM
    // rebuild so keyboard/screen-reader focus is not destroyed 4×/s.
    const boardChanged = events.some((ev) => ev.type !== 'tick');
    if (boardChanged) {
      this.scene.applyEvents(events, this.session.state);
      this._refreshMirror();
      this._refreshAssists();
    }
    this.audio.setIntensity(this.session.state.tray.length / this.session.state.trayCapacity);
    this.ui.updateHud(this.session.state, this.round.level);
    this._tutorialAdvance(events, tileId);
    this._saveDailySnapshot();
    if (this.session.finished) this._resolveRound();
  }

  _invalidFeedback(reason, tileId = null) {
    const msg = INVALID_REASONS[reason] ?? 'Not allowed.';
    this.ui.error(msg);
    this.audio.playEvent({ type: 'invalid' });
    if (tileId) this.scene.applyEvents([{ type: 'invalid', reason, tileId }], this.session.state);
    if (this.round?.lesson) this._tutorialAdvance([{ type: 'invalid', reason, tileId }], tileId);
  }

  // -------------------------------------------------------------------------
  // Tutorial (Learn mode): one rule at a time, action required
  // -------------------------------------------------------------------------

  _tutorialUpdate() {
    const lesson = this.round?.lesson;
    if (!lesson) return this.ui.tutorial(null);
    const step = lesson.steps[this.round.stepIndex];
    if (!step) return this.ui.tutorial(null);
    const prefix = this.round.stepIndex === 0 ? `${lesson.intro} ` : '';
    this.ui.tutorial(prefix + step.text);
    this.ui.announce('objective', `Lesson: ${step.text}`);
  }

  _tutorialAdvance(events, tileId) {
    const lesson = this.round?.lesson;
    if (!lesson) return;
    const step = lesson.steps[this.round.stepIndex];
    if (!step) return;
    const req = step.require ?? {};
    let done = false;
    for (const ev of events) {
      if (req.select && ev.type === 'pick' && ev.tileId === req.select) done = true;
      if (req.selectSym && ev.type === 'pick' && ev.sym === req.selectSym) done = true;
      if (req.event && ev.type === req.event) done = true;
      if (req.invalid && ev.type === 'invalid' && ev.tileId === req.invalid) done = true;
    }
    if (done) {
      this.round.stepIndex++;
      this.host.track('tutorial_step', { step: lesson.id + ':' + this.round.stepIndex });
      this._tutorialUpdate();
    }
  }

  // -------------------------------------------------------------------------
  // Round resolution → results
  // -------------------------------------------------------------------------

  async _resolveRound() {
    const completedSession = this.session;
    this._saveDailySnapshot(true);
    this._setPhase('resolving');
    this._stopClock();
    this.host.activityEnd();
    this.host.startPresence(() => 'in menus');

    const state = this.session.state;
    const level = this.round.level;
    const mode = this.round.mode;
    const won = state.status === 'won';
    const result = this.session.result();

    if (mode === 'learn' && won && this.round.lesson) {
      this.store.doc.progression.lessons[this.round.lesson.id] = { done: true };
      this.store.save();
    }
    this.store.recordRound(result, level);
    const unlocked = this._checkAchievements();
    this.host.track('round_end', { mode, status: result.status });

    // Ranked boards are platform-owned: clients never submit scores. The
    // local best is recorded above; the global board is viewed in Score Chase.
    const boardLine =
      mode === 'practice' || mode === 'learn'
        ? 'Unranked round — local best recorded.'
        : 'Local best recorded — global boards are recorded by the platform (see Score Chase).';

    const breakdown = scoreBreakdown(state);
    const stars = won && level.star ? starsFor(result.score, level.star) : 0;
    const reasonText = won
      ? `${level.name} cleared in ${fmtMs(state.elapsedMs)} with ${state.moves} moves.`
      : reasonTextFor(state.terminalReason);

    // Brief beat so the win/lose scene animation lands before the panel.
    setTimeout(() => {
      if (this.session !== completedSession || this.phase !== 'resolving') return; // user navigated away mid-beat
      this._setPhase('results');
      this.ui.results({
        won,
        reasonText,
        breakdown,
        stars,
        achievements: unlocked,
        boardLine,
        nextLabel: mode === 'journey' && won ? 'Next stage' : 'Continue',
      });
    }, won ? 1200 : 700);
  }

  _checkAchievements() {
    const unlocked = [];
    const grant = (key) => {
      if (this.store.unlockAchievement(key)) {
        unlocked.push(ACHIEVEMENTS.find((a) => a.key === key));
        this.host.reportAchievement(key);
      }
    };
    const p = this.store.doc.progression;
    if (p.roundsWon > 0) grant('first_clear');
    if (LESSONS.every((l) => p.lessons[l.id]?.done)) grant('lesson_master');
    if (this.store.doc.daily.streak >= 7) grant('daily_streak_7');
    if ((p.journey['j6-8']?.stars ?? 0) > 0) grant('summit');
    if (p.tilesClearedTotal >= 1000) grant('thousand_tiles');
    return unlocked;
  }

  _retry() {
    this.host.track('retry', { mode: this.round.mode });
    const { level, mode, lesson } = this.round;
    // Same seed and content — the materialized tiles are cached, so retry is exact.
    this._startRound(mode === 'learn' ? lessonLevel(lesson) : level, mode, lesson);
  }

  _next() {
    const { mode, level } = this.round ?? {};
    if (mode === 'journey' && level) {
      const idx = JOURNEY.findIndex((s) => s.id === level.id);
      if (idx >= 0 && idx + 1 < JOURNEY.length) {
        return this._startLevel(JOURNEY[idx + 1], 'journey');
      }
    }
    this._nav('title');
  }

  _startLevel(level, mode) {
    if (!level) return;
    this._startRound(level, mode);
  }

  pauseGame(auto = false) {
    if (this.phase !== 'active') return;
    this._setPhase('paused');
    this._stopClock();
    this.ui.openPause();
    if (auto) this.ui.announce('objective', 'Paused because the tab was hidden.');
  }

  resumeGame() {
    if (this.ui.isPauseOpen()) this.ui.closePause();
    if (this.phase !== 'paused') {
      // Settings-only overlay from menus.
      if (this.ui.currentScreen() !== 'play') return;
    }
    if (this.session && !this.session.finished) {
      this._setPhase('active');
      this._startClock();
    }
  }

  leaveRound() {
    this.ui.closePause();
    if (this.session && this.phase === 'paused') {
      const res = this.session.submit({ type: 'resign' });
      if (res.ok) {
        this._afterSubmit(res);
        return;
      }
    }
    this._stopClock();
    this._setPhase('title');
    this._refreshTitle();
    this.ui.showScreen('title');
  }

  // -------------------------------------------------------------------------
  // Daily session snapshots (durable reconnect, spec §6)
  // -------------------------------------------------------------------------

  _saveDailySnapshot(finished = false) {
    if (this.round?.mode !== 'daily' || !this.host.online || !this.session) return;
    // Throttle, not debounce: the 250 ms simulation tick re-enters here four
    // times a second, so a resettable debounce would be postponed forever and
    // the snapshot would never reach the server while the round is active.
    if (this._snapshotTimer) return;
    const round = this.round;
    const session = this.session;
    this._snapshotTimer = setTimeout(() => {
      this._snapshotTimer = null;
      const done = finished || session.finished;
      this.host.dailySessionSave({
        day: round.level.day,
        sessionId: session.sessionId,
        commands: session.commands,
        finished: done,
      });
    }, 800);
  }

  // -------------------------------------------------------------------------
  // Mirror / assists
  // -------------------------------------------------------------------------

  _refreshMirror() {
    const la = legalActions(this.session.state);
    this.ui.renderMirror(this.session.state, la.selectable, this.store.settings.colorblindPalette);
  }

  _refreshAssists() {
    const la = legalActions(this.session.state);
    this.ui.setAssistButtons({ canUndo: la.canUndo, canHint: la.canHint });
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  _applySettings() {
    const s = this.store.settings;
    this.ui.applySettings(s, this.store.doc.progression.unlockedThemes, THEMES);
    this.audio.applySettings(s);
  }

  _settingsChanged(patch, opts = {}) {
    this.store.updateSettings(patch);
    if (!opts.fromPlatform) this._pushSettings(patch);
    const s = this.store.settings;
    this._applySettings();
    this.host.setTelemetryConsent(!!s.telemetryConsent);
    if (this.scene) {
      if ('reducedMotion' in patch) {
        this.scene.reducedMotion = s.reducedMotion;
        this.scene.rig.reducedMotion = s.reducedMotion;
      }
      if ('cameraView' in patch) this.scene.setCameraPreference(s.cameraView);
      if ('colorblindPalette' in patch) {
        this.scene.colorblindPalette = s.colorblindPalette;
        this.scene._rebuildTileMaterials();
      }
      if ('themeChoice' in patch && this.round) {
        const themeId =
          s.themeChoice !== 'auto' && this.store.doc.progression.unlockedThemes.includes(s.themeChoice)
            ? s.themeChoice
            : this.round.level.theme;
        this.scene.setTheme(themeId);
      }
    }
    this.host.track('settings_change', { key: Object.keys(patch)[0] });
  }

  /** Saved Graphics settings; a legacy single "graphicsTier" maps onto a preset. */
  _graphicsSaved() {
    const s = this.store.settings;
    if (s.graphics && typeof s.graphics === 'object' && Object.keys(s.graphics).length) return s.graphics;
    const legacy = fromLegacyTier(s.graphicsTier);
    return legacy === 'auto' ? {} : { preset: legacy };
  }

  _graphicsChanged(next, opts = {}) {
    this.store.updateSettings({ graphics: next });
    if (!opts.fromPlatform) this._pushSettings({ graphics: next });
    this.scene?.setGraphics(next);
    this._refreshGraphicsPanel();
    this.host.track('settings_change', { key: 'graphics' });
  }

  /** Mirror player preferences to the StarHermit settings KV (signed in only). */
  _pushSettings(patch) {
    const out = {};
    for (const key of Object.keys(patch)) if (SYNCED_SETTINGS.includes(key)) out[key] = patch[key];
    if (Object.keys(out).length) this.host.patchSettings(out);
  }

  _refreshGraphicsPanel() {
    this.ui.renderGraphics(this._graphicsSaved(), this.scene?.graphicsInfo(this.ui.gfxT.words));
  }

  /** Frame the board + tray in the part of the canvas the play HUD leaves free. */
  _bindFraming() {
    const $ = (id) => document.getElementById(id);
    const play = $('screen-play');
    const parts = [play.querySelector('.hud-top'), play.querySelector('.hud-bottom'), $('board-mirror').querySelector('summary'), $('tutorial-banner')];
    this.scene.setFramingChrome(() => (play.hidden ? null : parts));
    if (!this._framingObserver && typeof ResizeObserver === 'function') {
      // Fires when the HUD appears/disappears or changes size (wrapping, banner).
      this._framingObserver = new ResizeObserver(() => this.scene?.reframe());
      for (const el of [play, ...parts]) this._framingObserver.observe(el);
    }
  }

  _onContextLost() {
    this.ui.error('Graphics context lost — rebuilding the table.');
    try {
      const canvas = this.scene.canvas;
      const level = this.round?.level;
      const state = this.session?.state;
      this.scene.dispose();
      this.scene = new TeaScene(canvas, {
        graphics: this._graphicsSaved(),
        reducedMotion: this.store.settings.reducedMotion,
        colorblindPalette: this.store.settings.colorblindPalette,
        onContextLost: () => this._onContextLost(),
      });
      this._bindFraming();
      if (level && state) this.scene.buildBoard(level, state);
    } catch {
      this.ui.showScreen('nogl');
    }
  }

  _unlockAudio() {
    if (this._gestureUnlocked) return;
    this._gestureUnlocked = true;
    this.audio.unlock();
    this.audio.applySettings(this.store.settings);
  }

  // -------------------------------------------------------------------------
  // Input: pointer/touch, keyboard, gamepad, lifecycle
  // -------------------------------------------------------------------------

  _bindInputs() {
    const canvas = this.scene.canvas;

    canvas.addEventListener('pointerdown', (e) => {
      this._unlockAudio();
      canvas.setPointerCapture?.(e.pointerId);
      this._pointer = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, committed: false };
      if (this.store.settings.holdToConfirm && this.phase === 'active') {
        const tileId = this.scene.pickTile(e.clientX, e.clientY);
        this._pointer.holdTimer = setTimeout(() => {
          if (this._pointer && !this._pointer.committed && tileId) {
            this._pointer.committed = true;
            this.selectTile(tileId);
          }
        }, HOLD_MS);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.phase !== 'active') return;
      if (this._pointer) {
        const dx = e.clientX - this._pointer.x;
        const dy = e.clientY - this._pointer.y;
        if (Math.hypot(dx, dy) > TAP_MAX_DIST) {
          clearTimeout(this._pointer?.holdTimer);
          this._pointer.dragging = true; // camera gesture zone: cancel the tap safely
        }
        if (this._pointer.dragging) return;
      }
      this.scene.setHover(this.scene.pickTile(e.clientX, e.clientY));
    });
    const endPointer = (e, cancelled) => {
      const p = this._pointer;
      this._pointer = null;
      if (!p) return;
      clearTimeout(p.holdTimer);
      if (cancelled || p.dragging || p.committed) return;
      const dt = performance.now() - p.t;
      const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      if (dist <= TAP_MAX_DIST && dt <= TAP_MAX_MS && this.phase === 'active') {
        const tileId = this.scene.pickTile(e.clientX, e.clientY);
        if (tileId) {
          if (!this.store.settings.holdToConfirm) this.selectTile(tileId);
        } else {
          this.scene.setHover(null);
        }
      }
    };
    canvas.addEventListener('pointerup', (e) => endPointer(e, false));
    canvas.addEventListener('pointercancel', (e) => endPointer(e, true));

    window.addEventListener('keydown', (e) => this._onKey(e));
    window.addEventListener('resize', () => {
      this.scene.resize();
    });
    document.addEventListener('visibilitychange', () => {
      this.audio.setBackgrounded(document.hidden);
      if (document.hidden) this.pauseGame(true);
      else if (this.phase === 'active') this.scene?.resize();
    });
  }

  _onKey(e) {
    if (e.defaultPrevented) return;
    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');
    if (inField) return;

    const action = this.codeAction[e.code];
    if (action === 'pause') {
      e.preventDefault();
      if (this.ui.isPauseOpen()) this.resumeGame();
      else if (this.phase === 'active') this.pauseGame();
      else if (this.ui.currentScreen() !== 'title') this._nav('title');
      return;
    }
    if (this.phase !== 'active' || this.ui.isPauseOpen()) return;

    // A focused DOM control (mirror button, summary, link) keeps its native
    // Enter/Space activation; the canvas-level shortcuts only apply when the
    // body/canvas itself has focus.
    const el = document.activeElement;
    const onControl = /^(BUTTON|A|SUMMARY)$/.test(el?.tagName ?? '');

    switch (action) {
      case 'focus_left':
      case 'focus_right':
      case 'focus_up':
      case 'focus_down':
        e.preventDefault();
        this._moveFocus(FOCUS_KEYS[action]);
        break;
      case 'pick':
        if (onControl) break;
        e.preventDefault();
        this._confirmFocus();
        break;
      case 'undo':
        this.doUndo();
        break;
      case 'hint':
        this.doHint();
        break;
      case 'camera':
        this.scene.resetCamera();
        break;
    }
  }

  _focusTargets() {
    if (!this.session) return [];
    const la = legalActions(this.session.state);
    const byId = new Map(this.session.state.tiles.map((t) => [t.id, t]));
    // Spatial order: top layer first, then reading order.
    return la.selectable
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => b.z - a.z || a.gy - b.gy || a.gx - b.gx);
  }

  _moveFocus(key) {
    const targets = this._focusTargets();
    if (targets.length === 0) return;
    if (this.focusIndex < 0) {
      this.focusIndex = 0;
    } else {
      const dir = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
      this.focusIndex = (this.focusIndex + dir + targets.length) % targets.length;
    }
    const t = targets[this.focusIndex];
    this.scene.setFocus(t.id);
    this.scene.setHover(t.id);
    this.ui.announce(
      'objective',
      `${SYMBOL_NAMES[t.sym] ?? t.sym} tile, layer ${t.z + 1}, ${this.focusIndex + 1} of ${targets.length}. Enter to pick.`,
    );
  }

  _confirmFocus() {
    const targets = this._focusTargets();
    if (this.focusIndex >= 0 && targets[this.focusIndex]) {
      const id = targets[this.focusIndex].id;
      this.focusIndex = -1;
      this.scene.setFocus(null);
      this.selectTile(id);
    } else if (targets.length > 0) {
      this.focusIndex = 0;
      this._moveFocus('ArrowRight');
    }
  }

  /** Gamepad polling: focus nav, confirm, pause (spec §3). */
  _pollGamepad() {
    const pads = navigator.getGamepads?.();
    const pad = pads && [...pads].find(Boolean);
    if (!pad) return;
    const pressed = pad.buttons.map((b) => b.pressed);
    const axisX = pad.axes[0] ?? 0;
    const axisY = pad.axes[1] ?? 0;
    const just = (i) => pressed[i] && !this._padPrev[i];

    if (this.phase === 'active' && !this.ui.isPauseOpen()) {
      if (just(14) || (axisX < -0.6 && !this._padAxisX)) this._moveFocus('ArrowLeft');
      if (just(15) || (axisX > 0.6 && !this._padAxisX)) this._moveFocus('ArrowRight');
      if (just(12) || (axisY < -0.6 && !this._padAxisY)) this._moveFocus('ArrowUp');
      if (just(13) || (axisY > 0.6 && !this._padAxisY)) this._moveFocus('ArrowDown');
      if (just(0)) this._confirmFocus(); // A / cross
      if (just(2)) this.doHint(); // X / square
      if (just(3)) this.doUndo(); // Y / triangle
    }
    if (just(9) || just(1)) {
      // Start or B / circle
      if (this.ui.isPauseOpen()) this.resumeGame();
      else if (this.phase === 'active') this.pauseGame();
    }
    this._padAxisX = Math.abs(axisX) > 0.6;
    this._padAxisY = Math.abs(axisY) > 0.6;
    this._padPrev = pressed;
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  _frame(now) {
    if (this._destroyed) return;
    const dt = now - this._lastFrame;
    this._lastFrame = now;
    const hidden = document.hidden;
    if (!hidden) {
      this.scene?.render(dt, { hidden: false });
      // Keep the Graphics summary (pixels, post note) current while settings are open.
      if (this.scene && this.ui.isPauseOpen() && now - (this._gfxInfoAt ?? 0) > 1000) {
        this._gfxInfoAt = now;
        this.ui.updateGraphicsInfo(this.scene.graphicsInfo(this.ui.gfxT.words));
      }
    }
    this._pollGamepad();
    requestAnimationFrame((t) => this._frame(t));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

function objectiveFor(level, mode) {
  switch (mode) {
    case 'learn':
      return level.name;
    case 'journey':
      return `${level.name}${level.mastery ? ' — mastery' : ''}`;
    case 'daily':
      return `Daily Steep — ${level.day}`;
    case 'challenge':
      return level.name;
    default:
      return level.name;
  }
}

function sublineFor(level, mode) {
  const parts = [`clear ${level.tiles.length} tiles`];
  if (level.config.timeLimitMs) parts.push(`clock ${fmtMs(level.config.timeLimitMs)}`);
  if (level.config.trayCapacity !== 7) parts.push(`tray of ${level.config.trayCapacity}`);
  if (level.config.ranked) parts.push('ranked');
  if (mode === 'practice') parts.push('undo allowed · unranked');
  if (level.config.hints === false) parts.push('no hints');
  return 'Objective: ' + parts.join(' · ');
}

function reasonTextFor(reason) {
  switch (reason) {
    case 'tray_full':
      return 'The tray filled with no triple. Watch the gauge and complete sets sooner.';
    case 'move_limit':
      return 'The move limit ran out.';
    case 'time_limit':
      return 'The clock ran out.';
    case 'resigned':
      return 'You left the round.';
    default:
      return 'The round has ended.';
  }
}

function starsFor(score, [t2, t3]) {
  if (score >= t3) return 3;
  if (score >= t2) return 2;
  return 1;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------------------

const app = new App();
app.boot();
