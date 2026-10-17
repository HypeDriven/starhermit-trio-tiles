/**
 * UI — the semantic HTML shell over the Three.js canvas.
 *
 * Owns every screen, overlay, live region, and DOM-equivalent control. It
 * renders from rules snapshots and content data only; all game decisions are
 * delegated back to main.js through a single callback map, so the DOM can
 * never mutate rules state (spec §5 module rule).
 */

import { symbolColor } from '../render/materials.js';
import { CATEGORIES, PRESETS, presetTier, choosePreset } from '../render/gfx.js';
import { gfxStrings } from './gfx-strings.js';
import { t, locale, symbolName, themeName } from './i18n.js';

const $ = (id) => document.getElementById(id);

export class UI {
  /**
   * @param {object} actions callback map supplied by main.js:
   *   play(), modeSelected(mode), nav(target), setupPicked(id), pause(),
   *   resume(), leaveRound(), undo(), hint(), cameraReset(), retry(), next(),
   *   mirrorSelect(tileId), settingsChanged(patch), profileRename(),
   *   replayTutorial(), pauseHelp(), graphicsChanged(savedGraphics)
   */
  constructor(actions) {
    this.a = actions;
    this.el = {
      bootStatus: $('boot-status'),
      bootProgress: $('boot-progress'),
      titleName: $('btn-profile-name'),
      btnSignIn: $('btn-signin'),
      btnInvite: $('btn-invite'),
      titleOnline: $('title-online'),
      titleOffline: $('title-offline'),
      titleSync: $('title-sync'),
      titleProgress: $('title-progress'),
      journeyMeta: $('mode-journey-meta'),
      dailyMeta: $('mode-daily-meta'),
      setupH: $('setup-h'),
      setupBlurb: $('setup-blurb'),
      setupList: $('setup-list'),
      setupExtra: $('setup-extra'),
      hudObjective: $('hud-objective'),
      hudSub: $('hud-sub'),
      hudProgress: $('hud-progress'),
      hudScore: $('hud-score'),
      hudTimer: $('hud-timer'),
      hudMoves: $('hud-moves'),
      trayGauge: $('tray-gauge'),
      btnUndo: $('btn-undo'),
      btnHint: $('btn-hint'),
      tutorialBanner: $('tutorial-banner'),
      tutorialText: $('tutorial-text'),
      mirror: $('board-mirror'),
      mirrorSummary: $('mirror-summary'),
      mirrorList: $('mirror-list'),
      resultsH: $('results-h'),
      resultsSub: $('results-sub'),
      resultsRows: $('results-rows'),
      resultsTotal: $('results-total'),
      resultsStars: $('results-stars'),
      resultsAchievements: $('results-achievements'),
      resultsBoard: $('results-board'),
      btnNext: $('btn-results-next'),
      pauseOverlay: $('overlay-pause'),
      settingsForm: $('settings-form'),
      settingsTheme: $('settings-theme'),
      captions: $('captions'),
      liveObjective: $('live-objective'),
      liveScore: $('live-score'),
      liveErrors: $('live-errors'),
      liveResults: $('live-results'),
    };
    this._captionTimer = null;
    this.gfxT = gfxStrings(locale());
    this._gfxSaved = {};
    this._buildGraphics();
    this._bind();
  }

  /**
   * Language changed: static markup was re-applied by i18n.js; relabel the
   * Graphics controls and the text this class builds from state. Main re-renders
   * the screens it composes (title, setup, HUD objective, results).
   */
  relocalize() {
    this.gfxT = gfxStrings(locale());
    this._labelGraphics();
    if (this.isPauseOpen()) this._labelPause();
    if (this._lastState) this.updateHud(this._lastState, this._lastLevel);
  }

  // -------------------------------------------------------------------------
  // Graphics section (quality preset, render scale, per-category overrides)
  // -------------------------------------------------------------------------

  /** Graphics labels and tier names in the current locale (controls are built once). */
  _labelGraphics() {
    const t = this.gfxT;
    $('gfx-legend').textContent = t.graphics;
    $('gfx-l-quality').textContent = t.quality;
    $('gfx-l-scale').textContent = t.renderScale;
    $('gfx-l-adaptive').textContent = t.adaptive;
    $('gfx-l-fps').textContent = t.showFps;
    for (const [cat, sel] of Object.entries(this._gfxCatSelects ?? {})) {
      sel.previousElementSibling.textContent = t.categories[cat];
      for (const o of sel.options) if (o.value !== 'preset') o.textContent = t.tiers[o.value];
    }
  }

  _buildGraphics() {
    const t = this.gfxT;
    const wrap = $('gfx-categories');
    wrap.textContent = '';
    this._gfxCatSelects = {};
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      const label = document.createElement('label');
      label.htmlFor = `gfx-cat-${cat}`;
      label.className = 'gfx-row';
      const span = document.createElement('span');
      span.textContent = t.categories[cat];
      const sel = document.createElement('select');
      sel.id = `gfx-cat-${cat}`;
      sel.dataset.gfxCat = cat;
      for (const v of ['preset', ...tiers]) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v === 'preset' ? '' : t.tiers[v];
        sel.appendChild(o);
      }
      label.append(span, sel);
      wrap.appendChild(label);
      this._gfxCatSelects[cat] = sel;
    }
    this._labelGraphics();
    const section = $('gfx-section');
    section.addEventListener('input', (e) => this._onGraphicsInput(e.target));
  }

  _onGraphicsInput(el) {
    const saved = { ...this._gfxSaved };
    let next = null;
    if (el.id === 'gfx-preset') {
      next = choosePreset(saved, el.value);
    } else if (el.dataset.gfxCat) {
      next = saved;
      if (el.value === 'preset') delete next[el.dataset.gfxCat];
      else next[el.dataset.gfxCat] = el.value;
    } else if (el.id === 'gfx-scale') {
      next = saved;
      next.render_scale = Number(el.value) / 100;
      $('gfx-scale-value').textContent = `${el.value}%`;
    } else if (el.id === 'gfx-adaptive' || el.id === 'gfx-fps') {
      next = saved;
      next[el.dataset.gfx] = el.checked;
    }
    if (next) this.a.graphicsChanged?.(next);
  }

  /** Reflect saved graphics settings + renderer info into the Graphics section. */
  renderGraphics(saved, info) {
    const t = this.gfxT;
    this._gfxSaved = { ...(saved ?? {}) };
    const s = this._gfxSaved;
    const detected = info?.detected ?? 'balanced';
    const presetSel = $('gfx-preset');
    presetSel.textContent = '';
    for (const v of ['auto', ...PRESETS]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === 'auto' ? t.auto(t.presets[detected]) : t.presets[v];
      presetSel.appendChild(o);
    }
    presetSel.value = PRESETS.includes(s.preset) ? s.preset : 'auto';
    const active = info?.resolved?.preset ?? (PRESETS.includes(s.preset) ? s.preset : detected);
    for (const [cat, sel] of Object.entries(this._gfxCatSelects)) {
      sel.options[0].textContent = t.fromPreset(t.tiers[presetTier(active, cat)]);
      sel.value = CATEGORIES[cat].includes(s[cat]) ? s[cat] : 'preset';
    }
    const pct = Math.round((Number(s.render_scale) || 1) * 100);
    $('gfx-scale').value = String(pct);
    $('gfx-scale-value').textContent = `${pct}%`;
    $('gfx-adaptive').checked = s.adaptive !== false;
    $('gfx-fps').checked = !!s.show_fps;
    this.updateGraphicsInfo(info);
  }

  updateGraphicsInfo(info) {
    if (!info) return;
    $('gfx-summary').textContent = `${info.gpu} · ${info.summary}`;
    const note = $('gfx-post-note');
    note.hidden = !info.postFailed;
    note.textContent = info.postFailed ? this.gfxT.postUnavailable : '';
  }

  _bind() {
    $('btn-play').addEventListener('click', () => this.a.play());
    $('btn-title-daily').addEventListener('click', () => this.a.modeSelected('daily'));
    $('btn-title-journey').addEventListener('click', () => this.a.modeSelected('journey'));
    $('btn-title-help').addEventListener('click', () => this.showScreen('help'));
    $('btn-title-settings').addEventListener('click', () => this.openPause({ settingsOnly: true }));
    this.el.titleName.addEventListener('click', () => this.a.profileRename());
    this.el.btnSignIn.addEventListener('click', () => this.a.signIn());
    this.el.btnInvite.addEventListener('click', () => this.a.invite());
    document.querySelectorAll('#mode-cards .card').forEach((card) => {
      card.addEventListener('click', () => this.a.modeSelected(card.dataset.mode));
    });
    document.querySelectorAll('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => this.a.nav(btn.dataset.nav));
    });
    $('btn-pause').addEventListener('click', () => this.a.pause());
    $('btn-resume').addEventListener('click', () => this.a.resume());
    $('btn-leave').addEventListener('click', () => this.a.leaveRound());
    $('btn-pause-help').addEventListener('click', () => this.a.pauseHelp());
    this.el.btnUndo.addEventListener('click', () => this.a.undo());
    this.el.btnHint.addEventListener('click', () => this.a.hint());
    $('btn-camera').addEventListener('click', () => this.a.cameraReset());
    $('btn-results-retry').addEventListener('click', () => this.a.retry());
    this.el.btnNext.addEventListener('click', () => this.a.next());
    $('btn-results-menu').addEventListener('click', () => this.a.nav('title'));
    $('btn-replay-tutorial').addEventListener('click', () => this.a.replayTutorial());
    this.el.settingsForm.addEventListener('input', (e) => {
      const patch = this._readSettingsField(e.target);
      if (patch) this.a.settingsChanged(patch);
    });
  }

  _readSettingsField(target) {
    const name = target.name;
    if (!name) return null;
    if (target.type === 'checkbox') return { [name]: target.checked };
    if (target.type === 'range') return { [name]: Number(target.value) };
    return { [name]: target.value };
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => {
      s.hidden = s.dataset.screen !== name;
    });
    if (name !== 'play') this.closePause();
    const first = document.querySelector(`.screen[data-screen="${name}"] button, .screen[data-screen="${name}"] summary`);
    if (first && name !== 'play') first.focus({ preventScroll: true });
  }

  currentScreen() {
    const s = document.querySelector('.screen:not([hidden])');
    return s?.dataset.screen ?? null;
  }

  boot(step, total, text) {
    this.el.bootProgress.max = total;
    this.el.bootProgress.value = step;
    this.el.bootStatus.textContent = text;
  }

  setTitleInfo({ name, online, sync, progressText }) {
    this.el.titleName.textContent = name;
    this.el.titleOnline.hidden = !online;
    this.el.titleOffline.hidden = online;
    this.el.titleSync.hidden = !sync;
    this.el.titleSync.textContent = sync ?? '';
    this.el.titleProgress.textContent = progressText;
  }

  /** StarHermit buttons: sign-in (platform host, no token) and invite (signed in). */
  setPlatformButtons({ signIn, invite, t: pt }) {
    this.el.btnSignIn.hidden = !signIn;
    this.el.btnInvite.hidden = !invite;
    this.el.btnSignIn.textContent = pt('signIn');
    this.el.btnInvite.textContent = pt('invite');
  }

  setControlsHelp(text) {
    const node = document.getElementById('help-controls');
    if (node) node.textContent = text;
  }

  setModeMeta({ journey, daily }) {
    this.el.journeyMeta.textContent = journey ?? '';
    this.el.dailyMeta.textContent = daily ?? '';
  }

  /**
   * Render a mode-setup list.
   * @param {object} spec { title, blurb, groups: [{heading?, items:[{id,label,meta?,stars?,disabled?,detail?}]}], extraHtml? }
   */
  renderSetup(spec, { rerender = false } = {}) {
    this.el.setupH.textContent = spec.title;
    this.el.setupBlurb.textContent = spec.blurb ?? '';
    const list = this.el.setupList;
    list.textContent = '';
    for (const group of spec.groups) {
      if (group.heading) {
        const h = document.createElement('p');
        h.className = 'setup-chapter';
        h.textContent = group.heading;
        h.setAttribute('role', 'listitem');
        list.appendChild(h);
      }
      for (const item of group.items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'setup-item';
        btn.disabled = !!item.disabled;
        btn.setAttribute('role', 'listitem');
        const label = document.createElement('span');
        label.textContent = item.label;
        btn.appendChild(label);
        const right = document.createElement('span');
        right.className = 'meta';
        right.textContent = [item.stars, item.meta].filter(Boolean).join(' · ');
        btn.appendChild(right);
        if (!item.disabled) btn.addEventListener('click', () => this.a.setupPicked(item.id));
        list.appendChild(btn);
      }
    }
    this.el.setupExtra.innerHTML = spec.extraHtml ?? '';
    if (!rerender) this.showScreen('setup');
  }

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------

  setObjective(text, sub = '', { quiet = false } = {}) {
    this.el.hudObjective.textContent = text;
    this.el.hudSub.textContent = sub;
    if (!quiet) this.announce('objective', sub ? `${text}. ${sub}` : text);
  }

  updateHud(state, level) {
    this._lastState = state;
    this._lastLevel = level;
    const n = state.tiles.length;
    this.el.hudProgress.textContent = n === 1 ? t('tilesOne') : t('tilesMany', { n });
    this.el.hudScore.textContent = String(state.score.total);
    // The 250 ms clock re-enters here constantly; announce only real changes
    // so screen readers are not spammed with identical score text.
    const scoreMsg = t('scoreAnnounce', { score: state.score.total, tiles: n, tray: state.tray.length, cap: state.trayCapacity });
    if (scoreMsg !== this._lastScoreMsg) {
      this._lastScoreMsg = scoreMsg;
      this.announce('score', scoreMsg);
    }
    const hasClock = state.limits.timeLimitMs != null;
    this.el.hudTimer.hidden = !hasClock && !level?.parMs;
    if (hasClock) {
      const left = Math.max(0, state.limits.timeLimitMs - state.elapsedMs);
      this.el.hudTimer.textContent = '⌛ ' + fmtMs(left);
      this.el.hudTimer.setAttribute('aria-label', t('timeRemaining', { time: fmtMs(left) }));
    } else {
      this.el.hudTimer.textContent = fmtMs(state.elapsedMs);
      this.el.hudTimer.setAttribute('aria-label', t('elapsed', { time: fmtMs(state.elapsedMs) }));
    }
    const hasMoves = state.limits.moveLimit != null;
    this.el.hudMoves.hidden = !hasMoves;
    if (hasMoves) this.el.hudMoves.textContent = t('movesOf', { n: state.moves, max: state.limits.moveLimit });
    this.renderTray(state);
  }

  renderTray(state) {
    const g = this.el.trayGauge;
    g.textContent = '';
    const danger = state.tray.length >= state.trayCapacity - 2;
    for (let i = 0; i < state.trayCapacity; i++) {
      const slot = document.createElement('span');
      const entry = state.tray[i];
      slot.className = 'tray-slot' + (entry ? ' filled' : '') + (danger && !entry ? ' danger' : '');
      if (entry) {
        slot.textContent = symbolName(entry.sym).slice(0, 2);
        slot.style.color = symbolColor(entry.sym, this._palette ?? 'default');
        slot.title = symbolName(entry.sym);
      }
      g.appendChild(slot);
    }
    g.setAttribute(
      'aria-label',
      t('trayAria', { n: state.tray.length, cap: state.trayCapacity, list: state.tray.map((e) => symbolName(e.sym)).join(', ') || t('trayEmpty') }),
    );
  }

  setAssistButtons({ canUndo, canHint }) {
    this.el.btnUndo.disabled = !canUndo;
    this.el.btnHint.disabled = !canHint;
  }

  tutorial(text) {
    this.el.tutorialBanner.hidden = !text;
    this.el.tutorialText.textContent = text ?? '';
  }

  /** Accessibility mirror: a button per exposed tile (DOM equivalents). */
  renderMirror(state, exposed, palette) {
    this._palette = palette;
    const list = this.el.mirrorList;
    list.textContent = '';
    this.el.mirrorSummary.textContent = t('mirrorSummary', { n: exposed.length, total: state.tiles.length, tray: state.tray.length, cap: state.trayCapacity });
    const tileById = new Map(state.tiles.map((t) => [t.id, t]));
    exposed.forEach((id, i) => {
      const tile = tileById.get(id);
      if (!tile) return;
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      const name = symbolName(tile.sym);
      btn.textContent = name;
      btn.style.borderLeft = `6px solid ${symbolColor(tile.sym, palette ?? 'default')}`;
      btn.setAttribute('aria-label', t('mirrorTile', { name, i: i + 1, n: exposed.length }));
      btn.addEventListener('click', () => this.a.mirrorSelect(id));
      btn.addEventListener('focus', () => this.a.mirrorFocus?.(id));
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  // -------------------------------------------------------------------------
  // Results / help
  // -------------------------------------------------------------------------

  results({ won, reasonText, breakdown, stars, achievements, boardLine, nextLabel }, { rerender = false } = {}) {
    // The round-end cue caption ("table cleared — you win") is now the panel
    // heading; drop it so it never sits over the score table or buttons.
    if (!rerender) this.clearCaption();
    const heading = won ? t('tableCleared') : t('roundOver');
    this.el.resultsH.textContent = heading;
    this.el.resultsSub.textContent = reasonText;
    const rows = this.el.resultsRows;
    rows.textContent = '';
    for (const r of breakdown.rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = scoreRowLabel(r);
      const td = document.createElement('td');
      td.textContent = String(r.value);
      tr.append(th, td);
      rows.appendChild(tr);
    }
    this.el.resultsTotal.textContent = String(breakdown.total);
    this.el.resultsStars.textContent = stars > 0 ? '★'.repeat(stars) + '☆'.repeat(3 - stars) : '';
    const al = this.el.resultsAchievements;
    al.textContent = '';
    for (const a of achievements ?? []) {
      const li = document.createElement('li');
      li.textContent = t('achievementLine', { name: a.name, desc: a.description });
      al.appendChild(li);
    }
    this.el.resultsBoard.textContent = boardLine ?? '';
    this.el.btnNext.textContent = nextLabel ?? t('next');
    if (rerender) return;
    this.showScreen('results');
    this.announce('results', t('resultsAnnounce', { heading, total: breakdown.total, reason: reasonText }));
  }

  // -------------------------------------------------------------------------
  // Pause / settings
  // -------------------------------------------------------------------------

  openPause({ settingsOnly = false } = {}) {
    this.el.pauseOverlay.hidden = false;
    this._settingsOnly = settingsOnly;
    this._labelPause();
    $('btn-leave').hidden = settingsOnly;
    $('btn-pause-help').hidden = settingsOnly;
    (settingsOnly ? this.el.settingsForm.querySelector('input,select') : $('btn-resume')).focus({ preventScroll: true });
  }

  // Opened from the title it is a settings sheet, not a pause screen.
  _labelPause() {
    $('pause-h').textContent = this._settingsOnly ? t('settings') : t('paused');
    $('btn-resume').textContent = this._settingsOnly ? t('done') : t('resume');
  }

  closePause() {
    this.el.pauseOverlay.hidden = true;
  }

  isPauseOpen() {
    return !this.el.pauseOverlay.hidden;
  }

  /** Reflect persisted settings into form controls and body classes. */
  applySettings(settings, unlockedThemes, allThemes) {
    const f = this.el.settingsForm;
    for (const el of f.elements) {
      if (!el.name || !(el.name in settings)) continue;
      if (el.type === 'checkbox') el.checked = !!settings[el.name];
      else el.value = String(settings[el.name]);
    }
    // Theme picker: auto + unlocked themes only (cosmetic unlocks).
    const sel = this.el.settingsTheme;
    sel.textContent = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = t('themeAuto');
    sel.appendChild(auto);
    for (const id of unlockedThemes) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = themeName(id, allThemes[id]?.name);
      sel.appendChild(opt);
    }
    sel.value = settings.themeChoice;
    document.body.classList.toggle('larger-text', !!settings.largerText);
    document.body.classList.toggle('high-contrast', !!settings.highContrast);
    document.body.classList.toggle('reduced-motion', !!settings.reducedMotion);
    document.body.classList.toggle('left-handed', !!settings.leftHanded);
  }

  // -------------------------------------------------------------------------
  // Live regions + captions
  // -------------------------------------------------------------------------

  announce(region, text) {
    const el = this.el['live' + region[0].toUpperCase() + region.slice(1)];
    if (!el) return;
    el.textContent = '';
    // Re-set on the next frame so repeated identical messages are announced.
    requestAnimationFrame(() => {
      el.textContent = text;
    });
  }

  error(text) {
    this.announce('errors', text);
  }

  clearCaption() {
    clearTimeout(this._captionTimer);
    this.el.captions.textContent = '';
  }

  caption(text) {
    const c = this.el.captions;
    c.textContent = text;
    clearTimeout(this._captionTimer);
    this._captionTimer = setTimeout(() => {
      c.textContent = '';
    }, 2600);
  }
}

/** Score breakdown row label (rows carry a stable key; triples also a count). */
function scoreRowLabel(r) {
  switch (r.key) {
    case 'triples': return t('scoreTriples', { n: r.count ?? '' });
    case 'combo': return t('scoreCombo');
    case 'slots': return t('scoreSlots');
    case 'time': return t('scoreTime');
    default: return r.label;
  }
}

export function fmtMs(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
