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
import { SaveStore } from './session/storage.js';
import { HostPlatform } from './platform/host.js';
import { AudioEngine } from './audio/audio.js';
import { TeaScene } from './render/scene.js';
import { detectTier, FrameMonitor } from './render/quality.js';
import { UI, fmtMs } from './ui/ui.js';

const TICK_MS = 250; // fixed simulation quantum submitted while active
const TAP_MAX_DIST = 12; // px — tap vs camera-drag threshold
const TAP_MAX_MS = 600;
const HOLD_MS = 400; // hold-to-confirm accessibility option

class App {
  constructor() {
    this.phase = 'boot';
    this.store = new SaveStore();
    this.host = new HostPlatform(this.store);
    this.ui = new UI(this._uiActions());
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
    const tierId =
      this.store.settings.graphicsTier === 'auto' ? detectTier() : this.store.settings.graphicsTier;
    this.scene = new TeaScene(document.getElementById('game-canvas'), {
      tier: tierId,
      reducedMotion: this.store.settings.reducedMotion,
      colorblindPalette: this.store.settings.colorblindPalette,
      onContextLost: () => this._onContextLost(),
    });
    this.monitor = new FrameMonitor((change) => {
      if (change.renderScaleFactor) this.scene.setRenderScaleFactor(change.renderScaleFactor);
      if (change.suggestTierDrop) this.ui.caption('Graphics lowered to keep play smooth');
    });
    this._bindInputs();

    this.ui.boot(4, 4, 'Contacting the host…');
    this.host.setTelemetryConsent(!!this.store.settings.telemetryConsent);
    try {
      await this.host.init();
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
      name: this.store.doc.profile.displayName,
      online: this.host.online,
      progressText:
        p.roundsPlayed > 0
          ? `Journey ${journeyDone}/${JOURNEY.length} · ${p.roundsWon} tables cleared · daily streak ${this.store.doc.daily.streak}`
          : 'Fresh table — the kettle is on.',
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
      profileRename: () => this._renameProfile(),
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

  _renameProfile() {
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
    try {
      const res = await fetch(`/api/v1/daily/session?day=${local.day}`, {
        headers: { 'x-player-id': this.host.playerId },
      });
      if (res.ok) {
        const snap = await res.json();
        if (!snap.finished && snap.commands?.length > 0) {
          resumeItem = { id: 'daily:resume', label: 'Resume today’s table', meta: `${snap.commands.length} commands recorded` };
        }
      }
    } catch {
      /* offline — no durable session */
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
      blurb: 'Validated scores only: every entry was replay-verified by the server. Offline? Your local bests stand in.',
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
    const rows = data.entries
      .map(
        (e, i) =>
          `<tr><td>${e.rank ?? i + 1}</td><td>${escapeHtml(e.name ?? 'Guest')}</td><td>${escapeHtml(
            e.contentId ?? '',
          )}</td><td>${e.score}</td><td>${fmtMs(e.elapsedMs ?? 0)}</td></tr>`,
      )
      .join('');
    const source =
      data.source === 'local' ? 'Local bests (offline)' : data.casual ? 'Casual board' : 'Verified board';
    document.getElementById('setup-extra').innerHTML = `
      <h2>${board[0].toUpperCase() + board.slice(1)} — ${source}</h2>
      <label><input type="checkbox" id="board-friends" ${this._boardFriends ? 'checked' : ''}> Friends / my entries only</label>
      <table class="score-table"><thead><tr><th>#</th><th>Player</th><th>Table</th><th>Score</th><th>Time</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No entries yet.</td></tr>'}</tbody></table>`;
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
    if (resume) {
      try {
        const res = await fetch(`/api/v1/daily/session?day=${local.day}`, {
          headers: { 'x-player-id': this.host.playerId },
        });
        if (res.ok) snapshot = await res.json();
      } catch {
        /* offline */
      }
    }
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
      try {
        for (const cmd of snapshot.commands) this.session.submit({ ...cmd, id: cmd.id });
        this.ui.caption('Restored your daily table from the server');
      } catch {
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
    this.scene.applyEvents(events, this.session.state);
    this.audio.setIntensity(this.session.state.tray.length / this.session.state.trayCapacity);
    this.ui.updateHud(this.session.state, this.round.level);
    this._refreshMirror();
    this._refreshAssists();
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

    // Ranked submission with replay envelope (server re-runs the input log).
    let boardLine = mode === 'practice' || mode === 'learn' ? 'Unranked round — not submitted.' : '';
    if (level.config.ranked) {
      const board = mode === 'daily' ? 'daily' : mode === 'challenge' ? 'challenge' : 'journey';
      const sub = await this.host.submitScore(board, { level, result, envelope: this.session.envelope() });
      if (sub.ok) boardLine = sub.duplicate ? 'Score already recorded.' : `Submitted to the ${board} board — rank ${sub.rank}.`;
      else if (sub.queued) boardLine = 'Offline — the score is queued and will submit on the next connection.';
      else boardLine = `Score rejected: ${sub.error}`;
    }

    const breakdown = scoreBreakdown(state);
    const stars = won && level.star ? starsFor(result.score, level.star) : 0;
    const reasonText = won
      ? `${level.name} cleared in ${fmtMs(state.elapsedMs)} with ${state.moves} moves.`
      : reasonTextFor(state.terminalReason);

    // Brief beat so the win/lose scene animation lands before the panel.
    setTimeout(() => {
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
      this._saveDailySnapshot(true);
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
    if (this.round?.mode !== 'daily' || !this.host.online) return;
    const level = this.round.level;
    const commands = this.session.commands;
    const sessionId = this.session.sessionId;
    const done = finished || this.session.finished;
    clearTimeout(this._snapshotTimer);
    this._snapshotTimer = setTimeout(() => {
      fetch('/api/v1/daily/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-player-id': this.host.playerId },
        body: JSON.stringify({ day: level.day, sessionId, commands, finished: done }),
      }).catch(() => {});
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

  _settingsChanged(patch) {
    this.store.updateSettings(patch);
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
      if ('graphicsTier' in patch && s.graphicsTier !== 'auto') this.scene.setTier(s.graphicsTier);
    }
    this.host.track('settings_change', { key: Object.keys(patch)[0] });
  }

  _onContextLost() {
    this.ui.error('Graphics context lost — rebuilding the table.');
    try {
      const canvas = this.scene.canvas;
      const level = this.round?.level;
      const state = this.session?.state;
      this.scene.dispose();
      this.scene = new TeaScene(canvas, {
        tier: this.scene.tier.id,
        reducedMotion: this.store.settings.reducedMotion,
        colorblindPalette: this.store.settings.colorblindPalette,
        onContextLost: () => this._onContextLost(),
      });
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
      this.scene.applyRenderScale();
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

    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.ui.isPauseOpen()) this.resumeGame();
      else if (this.phase === 'active') this.pauseGame();
      else if (this.ui.currentScreen() !== 'title') this._nav('title');
      return;
    }
    if (this.phase !== 'active' || this.ui.isPauseOpen()) return;

    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown':
        e.preventDefault();
        this._moveFocus(e.key);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this._confirmFocus();
        break;
      case 'u':
      case 'U':
        this.doUndo();
        break;
      case 'h':
      case 'H':
        this.doHint();
        break;
      case 'c':
      case 'C':
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
      this.monitor?.frame(dt);
      this.scene?.render(dt, { hidden: false });
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
