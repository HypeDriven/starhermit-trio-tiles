/**
 * UI — the semantic HTML shell over the Three.js canvas.
 *
 * Owns every screen, overlay, live region, and DOM-equivalent control. It
 * renders from rules snapshots and content data only; all game decisions are
 * delegated back to main.js through a single callback map, so the DOM can
 * never mutate rules state (spec §5 module rule).
 */

import { SYMBOL_NAMES } from '../rules/layout.js';
import { symbolColor } from '../render/materials.js';

const $ = (id) => document.getElementById(id);

export class UI {
  /**
   * @param {object} actions callback map supplied by main.js:
   *   play(), modeSelected(mode), nav(target), setupPicked(id), pause(),
   *   resume(), leaveRound(), undo(), hint(), cameraReset(), retry(), next(),
   *   mirrorSelect(tileId), settingsChanged(patch), profileRename(),
   *   replayTutorial(), pauseHelp()
   */
  constructor(actions) {
    this.a = actions;
    this.el = {
      bootStatus: $('boot-status'),
      bootProgress: $('boot-progress'),
      titleName: $('btn-profile-name'),
      titleOnline: $('title-online'),
      titleOffline: $('title-offline'),
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
    this._bind();
  }

  _bind() {
    $('btn-play').addEventListener('click', () => this.a.play());
    $('btn-title-daily').addEventListener('click', () => this.a.modeSelected('daily'));
    $('btn-title-journey').addEventListener('click', () => this.a.modeSelected('journey'));
    $('btn-title-help').addEventListener('click', () => this.showScreen('help'));
    $('btn-title-settings').addEventListener('click', () => this.openPause({ settingsOnly: true }));
    this.el.titleName.addEventListener('click', () => this.a.profileRename());
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

  setTitleInfo({ name, online, progressText }) {
    this.el.titleName.textContent = name;
    this.el.titleOnline.hidden = !online;
    this.el.titleOffline.hidden = online;
    this.el.titleProgress.textContent = progressText;
  }

  setModeMeta({ journey, daily }) {
    this.el.journeyMeta.textContent = journey ?? '';
    this.el.dailyMeta.textContent = daily ?? '';
  }

  /**
   * Render a mode-setup list.
   * @param {object} spec { title, blurb, groups: [{heading?, items:[{id,label,meta?,stars?,disabled?,detail?}]}], extraHtml? }
   */
  renderSetup(spec) {
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
    this.showScreen('setup');
  }

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------

  setObjective(text, sub = '') {
    this.el.hudObjective.textContent = text;
    this.el.hudSub.textContent = sub;
    this.announce('objective', sub ? `${text}. ${sub}` : text);
  }

  updateHud(state, level) {
    this.el.hudProgress.textContent = `${state.tiles.length} tile${state.tiles.length === 1 ? '' : 's'}`;
    this.el.hudScore.textContent = String(state.score.total);
    this.announce('score', `Score ${state.score.total}, ${state.tiles.length} tiles left, tray ${state.tray.length} of ${state.trayCapacity}`);
    const hasClock = state.limits.timeLimitMs != null;
    this.el.hudTimer.hidden = !hasClock && !level?.parMs;
    if (hasClock) {
      const left = Math.max(0, state.limits.timeLimitMs - state.elapsedMs);
      this.el.hudTimer.textContent = '⌛ ' + fmtMs(left);
      this.el.hudTimer.setAttribute('aria-label', `time remaining ${fmtMs(left)}`);
    } else {
      this.el.hudTimer.textContent = fmtMs(state.elapsedMs);
      this.el.hudTimer.setAttribute('aria-label', `elapsed ${fmtMs(state.elapsedMs)}`);
    }
    const hasMoves = state.limits.moveLimit != null;
    this.el.hudMoves.hidden = !hasMoves;
    if (hasMoves) this.el.hudMoves.textContent = `${state.moves}/${state.limits.moveLimit} moves`;
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
        slot.textContent = (SYMBOL_NAMES[entry.sym] ?? entry.sym).slice(0, 2);
        slot.style.color = symbolColor(entry.sym, this._palette ?? 'default');
        slot.title = SYMBOL_NAMES[entry.sym] ?? entry.sym;
      }
      g.appendChild(slot);
    }
    g.setAttribute(
      'aria-label',
      `Tray ${state.tray.length} of ${state.trayCapacity}: ` +
        (state.tray.map((e) => SYMBOL_NAMES[e.sym] ?? e.sym).join(', ') || 'empty'),
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
    this.el.mirrorSummary.textContent =
      `${exposed.length} of ${state.tiles.length} tiles available. Tray ${state.tray.length}/${state.trayCapacity}.`;
    const tileById = new Map(state.tiles.map((t) => [t.id, t]));
    exposed.forEach((id, i) => {
      const t = tileById.get(id);
      if (!t) return;
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      const name = SYMBOL_NAMES[t.sym] ?? t.sym;
      btn.textContent = name;
      btn.style.borderLeft = `6px solid ${symbolColor(t.sym, palette ?? 'default')}`;
      btn.setAttribute('aria-label', `${name} tile, available, ${i + 1} of ${exposed.length}`);
      btn.addEventListener('click', () => this.a.mirrorSelect(id));
      btn.addEventListener('focus', () => this.a.mirrorFocus?.(id));
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  // -------------------------------------------------------------------------
  // Results / help
  // -------------------------------------------------------------------------

  results({ won, reasonText, breakdown, stars, achievements, boardLine, nextLabel }) {
    this.el.resultsH.textContent = won ? 'Table cleared' : 'Round over';
    this.el.resultsSub.textContent = reasonText;
    const rows = this.el.resultsRows;
    rows.textContent = '';
    for (const r of breakdown.rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = r.label;
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
      li.textContent = `Achievement: ${a.name} — ${a.description}`;
      al.appendChild(li);
    }
    this.el.resultsBoard.textContent = boardLine ?? '';
    this.el.btnNext.textContent = nextLabel ?? 'Next';
    this.showScreen('results');
    this.announce(
      'results',
      `${won ? 'Table cleared' : 'Round over'}. Total score ${breakdown.total}. ${reasonText}`,
    );
  }

  // -------------------------------------------------------------------------
  // Pause / settings
  // -------------------------------------------------------------------------

  openPause({ settingsOnly = false } = {}) {
    this.el.pauseOverlay.hidden = false;
    this._settingsOnly = settingsOnly;
    $('btn-resume').textContent = settingsOnly ? 'Done' : 'Resume';
    $('btn-leave').hidden = settingsOnly;
    $('btn-pause-help').hidden = settingsOnly;
    (settingsOnly ? this.el.settingsForm.querySelector('input,select') : $('btn-resume')).focus();
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
    auto.textContent = 'Auto (from the round)';
    sel.appendChild(auto);
    for (const id of unlockedThemes) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = allThemes[id]?.name ?? id;
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

  caption(text) {
    const c = this.el.captions;
    c.textContent = text;
    clearTimeout(this._captionTimer);
    this._captionTimer = setTimeout(() => {
      c.textContent = '';
    }, 2600);
  }
}

export function fmtMs(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
