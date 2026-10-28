// The browser build's DOM shell (index.html + js/ui/ui.js over css/main.css)
// as starhermit:ui, built every frame: the screens (title, mode cards, the
// per-mode setup lists with Score Chase's boards, How to Play, results, the
// rename field) as centred panels over the table, the pause / settings
// overlay (a dialog), and the play HUD — the objective and stat pills on the
// top gradient, the lesson banner, the tray gauge and the Undo / Hint /
// Camera / Pause buttons on the bottom gradient, the board mirror drawer (a
// button per available tile), the sound captions and the "Thinking…" line.
// The old media queries are layouts picked by the window's logical size:
// wide (≥ 1024 px: the bottom bar one row), portrait phone (< 640 px wide:
// the top bar stacked, the actions a 2 × 2 thumb grid, the mirror above
// them), short landscape (≤ 500 px tall: the actions a column at the right
// below the stats, the mirror a bottom-left drawer). The HUD's rectangles go
// to render.ts, which frames board + tray in what they leave free.
import { frame, openMenu } from "starhermit:engine";
import { bindings, primaryPointer, requestRebind } from "starhermit:input";
import * as ui from "starhermit:ui";
import { Content, Engine, type State } from "./game.ts";
import { G, S, T, chapterName, fmtMs, levelName, playerName, symbolName, themeName, tn } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  app, doHint, doUndo, focusTargets, fresh, goTitle, invite, later, leaveRound, nav, next, objectiveFor, open, openHelpFromPause, openMode,
  openSettings, pauseGame, play, renameProfile, replayTutorial, resultsSpec, resumeGame, retry, selectTile, setBoardFriends, setSetting,
  settings, setupPicked, signIn, sublineFor, thinkingVisible, tutorialText, type Screen,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; wide: boolean; phone: boolean; short: boolean }
const lastSize = new Map<string, ui.Rect>();
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const short = lh <= 500 && lw > lh;
  return { lw, lh, sc, ox: sa.left, oy: sa.top, wide: lw >= 1024 && !short, phone: lw < 640 && lh >= lw, short };
}
function textWidth(text: string, style: string, kind?: "button"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string, color?: string): void {
  if (!text) return;
  const st = color ? ui.style(cls, { text: { color } }) : ui.style(cls);
  const u = id ? st.id(id) : st;
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn { id: string; text: string; style?: string; act: () => void; disabled?: boolean; width?: number; name?: string }
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 2;
function button(b: Btn): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const s: ui.Style = {};
  if (b.width != null) {
    s.width = b.width;
    if (buttonWidth(b.text, style) > b.width) opts.content = () => { ui.style("wrap").paragraph(b.text, Math.max(20, b.width! - 36)); };
  }
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) later(b.act);
}
/** .row-actions: buttons at their widths in rows that wrap at `width`. */
function flow(label: string, list: Btn[], width: number, gap = 6, align: ui.Align = "center"): ui.Rect {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  return ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => { for (const b of row) button({ ...b, width: bw(b) }); }, { spacing: gap }));
  }, { spacing: gap, width, align });
}
/** A wrapping check box (ui.checkbox labels do not wrap on phones). */
function toggleRow(id: string, label: string, on: boolean, w: number, set: (v: boolean) => void): void {
  ui.row(`${id}-row`, () => {
    const res = ui.id(id).widget(label, {
      role: "checkbox", checked: on, size: { width: 36, height: 36 },
      draw: (r, st) => {
        const s = st.scale, box = 20 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        ui.preferences();
        drawBox(bx, by, box, on);
        if (st.focused) drawRing(bx - 4 * s, by - 4 * s, box + 8 * s);
      },
    });
    para(label, w - 48, "text", `${id}-label`);
    if (res.activated && fresh()) later(() => set(!on));
  }, { width: w, align: "center", spacing: 10 });
}
import * as draw from "starhermit:draw";
import { token } from "./style.ts";
function drawBox(x: number, y: number, s: number, on: boolean): void {
  draw.roundRect(x, y, s, s, 4, on ? token("accent") : "#33241a");
  draw.strokeRoundRect(x, y, s, s, 4, token("edge"), 1);
  if (on) draw.text("✓", x + s / 2, y + s * 0.05, { size: s * 0.85, color: "#241608", align: "center", weight: "bold" });
}
function drawRing(x: number, y: number, s: number): void { draw.strokeRoundRect(x, y, s, s, 6, token("focus"), 3); }
function selectRow(id: string, label: string, index: number, options: string[], w: number, set: (i: number) => void): void {
  const narrow = w < 420;
  const build = (): void => {
    para(label, narrow ? w : w * 0.45, "text", `${id}-label`);
    if (!narrow) ui.spacer();
    const pick = ui.style("select", { width: narrow ? w : Math.min(w * 0.5, 260) }).id(id).select(label, index, options);
    if (pick !== index && fresh()) later(() => set(pick));
  };
  if (narrow) ui.column(`${id}-row`, build, { width: w, spacing: 4 });
  else ui.row(`${id}-row`, build, { width: w, align: "center", spacing: 10 });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  const inPlay = !!app.session && (app.phase === "active" || app.phase === "paused" || app.phase === "resolving");
  const parts: render.Rect[] = [];
  if (inPlay) hud(L, parts);
  render.setView(f.width, f.height, inPlay ? parts : null);
  if (app.screen && app.screen !== "pause") menu(L, app.screen);
  if (app.screen === "pause") pauseOverlay(L);
  if (app.caption) captionLine(L, app.caption.text);
  if (app.focusNext && primaryPointer() !== "coarse") {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  } else app.focusNext = null;
}

// ------------------------------------------------------------------ HUD
function hud(L: Layout, parts: render.Rect[]): void {
  const s = app.session!, r = app.round!, st = s.state;
  const pad = L.wide ? 32 : 12;
  const statPills = (): void => {
    const pill = (id: string, text: string): void => {
      ui.column(`${id}-pill`, () => { ui.style("stat-text").id(id).label(text); }, { style: "stat" });
    };
    const list: [string, string][] = [["hud-progress", st.tiles.length === 1 ? T("tilesOne") : T("tilesMany", { n: st.tiles.length })], ["hud-score", String(st.score.total)]];
    if (st.limits.timeLimitMs != null) list.push(["hud-timer", "⌛ " + fmtMs(Math.max(0, st.limits.timeLimitMs - st.elapsedMs))]);
    else if (r.level.parMs) list.push(["hud-timer", fmtMs(st.elapsedMs)]);
    if (st.limits.moveLimit != null) list.push(["hud-moves", T("movesOf", { n: st.moves, max: st.limits.moveLimit })]);
    ui.row("hud-stats", () => { for (const [id, t] of list) pill(id, t); }, { spacing: 8 });
  };
  const objective = objectiveFor(r.level, r.mode), sub = sublineFor(r.level, r.mode);
  const topW = L.lw;
  const top = ui.place("hud-top", { x: 0, y: 0 }, () => {
    const inner = topW - 2 * pad;
    const body = (w: number): void => {
      ui.column("hud-obj", () => {
        para(objective, w, "hud-h", "hud-objective");
        para(sub, w, "hud-sub", "hud-sub");
      }, { spacing: 2, width: w });
    };
    if (L.phone) ui.column("hud-top-col", () => { body(inner); statPills(); }, { style: "hud-top", width: topW, spacing: 5, padding: { top: 8, bottom: 8, start: pad, end: pad } });
    else ui.row("hud-top-row", () => { body(Math.max(120, inner - (lastSize.get("stats")?.width ?? 200) / L.sc - 16)); ui.spacer(); lastSize.set("stats", ui.column("stats-box", statPills)); },
      { style: "hud-top", width: topW, spacing: 16, padding: { top: 8, bottom: 14, start: pad, end: pad } });
  });
  parts.push(top);
  const topH = top.height / L.sc;
  // the lesson banner hugs the top HUD
  const banner = tutorialText();
  if (banner && app.phase !== "resolving") {
    const w = Math.min(L.lw - 24, L.short ? Math.min(480, L.lw * 0.6) : 544);
    const b = ui.place("banner", { anchor: "top", y: topH + (L.short ? 3 : 8) }, () => {
      ui.column("banner-col", () => para(banner, w - 36, "banner-text", "tutorial-text"), { style: "banner", width: w });
    });
    parts.push(b);
  }
  // the bottom bar: tray gauge and actions
  const gauge = (): void => trayGauge(st, L.short ? 25.6 : 33.6, L.short ? 4 : 6, L.short ? 144 : L.lw - 24);
  const left = !!settings().leftHanded;
  const acts: { id: string; text: string; act: () => void; disabled?: boolean }[] = [
    { id: "btn-undo", text: T("undo"), act: doUndo, disabled: !app.canUndo },
    { id: "btn-hint", text: T("hint"), act: doHint, disabled: !app.canHint || app.thinking },
    { id: "btn-camera", text: T("camera"), act: () => render.resetCamera() },
    { id: "btn-pause", text: T("pause"), act: () => pauseGame() },
  ];
  if (left) acts.reverse();
  const actionsOn = app.phase === "active";
  let bottom: ui.Rect;
  if (L.short) {
    const w = 144;
    bottom = ui.place("hud-bottom", { anchor: "top-end", x: 6, y: 64 }, () => {
      ui.column("hud-bottom-col", () => {
        gauge();
        for (const a of acts) button({ ...a, style: "btn-hud", width: w, disabled: a.disabled || !actionsOn });
      }, { width: w, spacing: 4, align: "center" });
    });
  } else if (L.wide) {
    bottom = ui.place("hud-bottom", { anchor: "bottom", y: 0 }, () => {
      ui.row("hud-bottom-row", () => {
        gauge();
        ui.spacer();
        ui.row("hud-actions", () => { for (const a of acts) button({ ...a, style: "btn-hud", disabled: a.disabled || !actionsOn }); }, { spacing: 5 });
      }, { style: "hud-bottom", width: L.lw, align: "end", padding: { top: 20, bottom: 10, start: pad, end: pad } });
    });
  } else {
    const w = Math.min(L.lw - 24, 560);
    bottom = ui.place("hud-bottom", { anchor: "bottom", y: 0 }, () => {
      ui.column("hud-bottom-col", () => {
        gauge();
        if (L.phone) {
          const bw = (w - 8) / 2;
          for (let i = 0; i < 4; i += 2) ui.row(`hud-act-r${i}`, () => { for (const a of acts.slice(i, i + 2)) button({ ...a, style: "btn-hud", width: bw, disabled: a.disabled || !actionsOn }); }, { spacing: 8 });
        } else flow("hud-actions", acts.map((a) => ({ ...a, style: "btn-hud", disabled: a.disabled || !actionsOn })), w, 5);
      }, { style: "hud-bottom", width: L.lw, spacing: 8, align: "center", padding: { top: 20, bottom: 10, start: 12, end: 12 } });
    });
  }
  parts.push(bottom);
  const bottomH = bottom.height / L.sc;
  // the available tiles as named areas over the table (screen readers, play scripts, browser checks)
  if (app.phase === "active" && !app.screen) {
    const list = focusTargets();
    list.forEach((t, i) => {
      const rc = render.tileRect(t.id);
      if (rc) ui.target(T("focusAnnounce", { symbol: symbolName(t.sym), layer: t.z + 1, i: i + 1, n: list.length }), rc, { role: "label" });
    });
  }
  mirror(L, st, topH, bottomH, parts);
  if (thinkingVisible()) captionLine(L, T("thinking"), "thinking");
}
function trayGauge(st: State, size: number, gap: number, maxW: number): void {
  // .tray-gauge wraps (flex-wrap) when the rail is narrower than the slots
  const cols = Math.max(1, Math.min(st.trayCapacity, Math.floor((maxW + gap) / (size + gap))));
  const rows = Math.ceil(st.trayCapacity / cols);
  const danger = st.tray.length >= st.trayCapacity - 2;
  const pal = settings().colorblindPalette;
  const list = st.tray.map((e) => symbolName(e.sym)).join(", ") || T("trayEmpty");
  ui.id("tray-gauge").widget(T("trayAria", { n: st.tray.length, cap: st.trayCapacity, list }), {
    role: "image", size: { width: cols * size + (cols - 1) * gap, height: rows * size + (rows - 1) * gap },
    draw: (r, ws) => {
      const s = ws.scale, sz = size * s, g = gap * s;
      for (let i = 0; i < st.trayCapacity; i++) {
        const row = Math.floor(i / cols), inRow = Math.min(cols, st.trayCapacity - row * cols);
        const x = r.x + (r.width - (inRow * sz + (inRow - 1) * g)) / 2 + (i % cols) * (sz + g), y = r.y + row * (sz + g), e = st.tray[i];
        draw.roundRect(x, y, sz, sz, 8, e ? "#3a2c1e" : "#00000073");
        draw.strokeRoundRect(x, y, sz, sz, 8, danger && !e ? token("danger") : token("edge"), 1);
        if (e) draw.text(symbolName(e.sym).slice(0, 2), x + sz / 2, y + sz * 0.2, { size: sz * 0.45, color: render.symbolColor(e.sym, pal), align: "center", weight: "bold" });
      }
    },
  });
}
function mirror(L: Layout, st: State, topH: number, bottomH: number, parts: render.Rect[]): void {
  const avail = Engine.legalActions(st).selectable;
  const w = L.phone ? L.lw - 24 : L.short ? Math.min(L.lw * 0.4, 280) : L.wide ? 320 : L.lw >= 640 ? 240 : 256;
  const where = L.phone ? { anchor: "bottom" as const, y: bottomH + 6 }
    : L.short ? { anchor: "bottom-start" as const, x: 6, y: 6 }
    : { anchor: "top-end" as const, x: 8, y: Math.max(topH + 8, L.lh * 0.3) };
  const maxListH = L.short ? L.lh * 0.5 - 60 : L.phone ? Math.max(120, L.lh - topH - bottomH - 160) : L.lh * 0.4;
  const byId = new Map(st.tiles.map((t) => [t.id, t]));
  const pal = settings().colorblindPalette;
  const focusId = (() => { const t = focusTargets()[app.focusIndex]; return app.focusIndex >= 0 && t ? t.id : null; })();
  let headRect: ui.Rect | null = null;
  const rect = ui.place("mirror", where, () => {
    ui.column("mirror-col", () => {
      const head = T("mirrorTitle");
      headRect = ui.column("mirror-head", () => { if (ui.style("btn-link", { width: w - 24 }).id("btn-mirror").button(head, { selected: app.mirrorOpen, content: () => { ui.style("link-text").paragraph((app.mirrorOpen ? "▾ " : "▸ ") + head, w - 30); } }) && fresh()) {
        later(() => { app.mirrorOpen = !app.mirrorOpen; });
      } });
      if (!app.mirrorOpen) return;
      para(T("mirrorSummary", { n: avail.length, total: st.tiles.length, tray: st.tray.length, cap: st.trayCapacity }), w - 24, "dim", "mirror-summary");
      const bw = (w - 24 - 4) / 2;
      const list = (): void => {
        for (let i = 0; i < avail.length; i += 2) {
          ui.row(`mirror-r${i}`, () => {
            for (const id of avail.slice(i, i + 2)) {
              const tile = byId.get(id);
              if (!tile) continue;
              const name = symbolName(tile.sym);
              const n = avail.indexOf(id);
              const color = render.symbolColor(tile.sym, pal);
              const label = T("mirrorTile", { name, i: n + 1, n: avail.length });
              if (ui.style("mirror-btn", { width: bw, border: { width: { top: 1, bottom: 1, end: 1, start: 6 }, color: { top: token("edge"), bottom: token("edge"), end: token("edge"), start: color } } }).id(`mirror-${id}`).button(label, {
                selected: focusId === id, content: () => { ui.style("wrap", { text: { size: 14.4 } }).label(name); },
              }) && fresh()) later(() => selectTile(id));
            }
          }, { spacing: 4 });
        }
      };
      const inner = lastSize.get("mirror-list");
      if (inner && inner.height / L.sc > maxListH) ui.scrollArea("mirror-scroll", { width: w - 24, height: maxListH }, () => { lastSize.set("mirror-list-in", ui.column("mirror-list-col", list, { spacing: 4 })); });
      else lastSize.set("mirror-list", ui.column("mirror-list-col", list, { spacing: 4 }));
    }, { style: "mirror", width: w, spacing: 6 });
  });
  // as the old <summary>: only the drawer's head counts for the framing
  parts.push(app.mirrorOpen && headRect ? headRect : rect);
}
function captionLine(L: Layout, text: string, id = "caption"): void {
  const w = Math.min(L.lw - 32, textWidth(text, "caption-text") + 30);
  const inPlay = !!app.session && app.screen === null;
  ui.place(id, { anchor: "bottom", y: id === "thinking" ? 148 : inPlay && L.phone ? 210 : 104 }, () => {
    ui.column(`${id}-col`, () => para(text, w - 26, "caption-text", `${id}-text`), { style: "caption", width: w });
  });
}

// ------------------------------------------------------------------ menu screens (centred panels over the table)
function menu(L: Layout, o: NonNullable<Screen>): void {
  const wideScreen = o === "modes" || o === "setup" || o === "help";
  const maxW = wideScreen ? (L.lw >= 640 && L.lw < 1024 ? 704 : 832) : L.wide ? 608 : 544;
  const w = Math.min(L.lw - (L.phone ? 16 : 32), maxW);
  const padX = L.phone ? 16 : 24;
  const inner = w - 2 * padX;
  const maxH = L.lh - (L.phone ? 16 : 32);
  const key = `screen-${o}`;
  const prev = lastSize.get(key);
  const scroll = !!prev && prev.height / L.sc + 42 > maxH;
  const opening = frame().frame - app.openedFrame <= 6;
  ui.place("screen", "center", () => {
    ui.column("screen-panel", () => {
      const iw = inner - (scroll ? 14 : 0);
      const body = (): void => { lastSize.set(key, ui.column(`${key}-in`, () => buildScreen(o, iw, L), { spacing: 12, width: iw, align: "center" })); };
      if (scroll) ui.scrollArea(`${key}-scroll`, { width: inner + 6, height: maxH - 42 }, body, opening && !app.focusNext ? { scrollTo: { top: 0 } } : undefined);
      else body();
    }, { style: "panel", width: w, spacing: 0, padding: { top: 20, bottom: 20, start: padX, end: padX } });
  });
  // Escape / back: up one level, as main.js's Escape (title stays)
  if (ui.back() && fresh() && o !== "title") {
    if (o === "setup") later(() => nav("modes"));
    else if (o === "rename") later(() => open("title", "btn-profile-name"));
    else later(() => nav(o === "help" ? "back" : "title"));
  }
}
function buildScreen(o: NonNullable<Screen>, w: number, L: Layout): void {
  switch (o) {
    case "title": titleScreen(w); break;
    case "modes": modesScreen(w); break;
    case "setup": setupScreen(w, L); break;
    case "help": helpScreen(w); break;
    case "results": resultsScreen(w); break;
    case "rename": renameScreen(w); break;
    case "pause": break;
  }
}
function journeyDone(): number { return Object.values(platform.store.doc.progression.journey).filter((s) => s.stars > 0).length; }
function titleScreen(w: number): void {
  const doc = platform.store.doc;
  ui.style("h1").id("title-h").label("Trio Tiles");
  para(T("tagline"), w, "tagline", "tagline");
  button({ id: "btn-play", text: T("play"), style: "btn-big", act: play });
  const sec: Btn[] = [
    { id: "btn-title-daily", text: T("dailySteep"), act: () => openMode("daily") },
    { id: "btn-title-journey", text: T("journey"), act: () => openMode("journey") },
    { id: "btn-title-help", text: T("howToPlay"), act: () => { app.helpReturn = null; open("help"); } },
    { id: "btn-title-settings", text: T("settings"), act: openSettings },
  ];
  if (!platform.signedIn()) sec.push({ id: "btn-signin", text: S("signIn"), act: signIn });
  else if (platform.inviteLink()) sec.push({ id: "btn-invite", text: S("invite"), act: invite });
  flow("title-secondary", sec, w);
  const signed = platform.signedIn();
  const name = signed ? playerName(platform.displayName() ?? "") : playerName(doc.profile.displayName);
  const sync = platform.syncState();
  const syncKey = sync === "saving" ? "syncSaving" : sync === "synced" ? "syncSynced" : sync === "error" ? "syncError" : sync === "offline" ? "syncOffline" : null;
  ui.row("profile-line", () => {
    ui.style("dim").label(T("playingAs"));
    if (signed) ui.style("link-text").id("profile-name").label(name);
    else button({ id: "btn-profile-name", text: name, style: "btn-link", act: () => { renameDraft = doc.profile.displayName === "Guest" ? "" : doc.profile.displayName; open("rename", "rename-field"); } });
    ui.column("badge-on", () => ui.style(signed ? "badge-text" : "badge-dim-text").label(signed ? T("online") : T("offline")), { style: signed ? "badge" : "badge-dim" });
    if (syncKey) ui.column("badge-sync", () => ui.style("badge-dim-text").label(T(syncKey)), { style: "badge-dim" });
  }, { spacing: 6, align: "center" });
  const p = doc.progression;
  para(p.roundsPlayed > 0 ? T("progressLine", { done: journeyDone(), total: Content.JOURNEY.length, won: p.roundsWon, streak: doc.daily.streak }) : T("freshTable"), w, "dim", "title-progress");
}
let renameDraft = "";
function renameScreen(w: number): void {
  ui.style("h1").id("rename-h").label(T("changeName"));
  para(T("promptName"), w, "dim", "rename-sub");
  renameDraft = ui.style("field", { width: Math.min(w, 360) }).textField("rename-field", renameDraft, { maxChars: 24, placeholder: T("guest") });
  const save = (): void => { renameProfile(renameDraft); open("title", "btn-profile-name"); };
  if (ui.submitted("rename-field") && fresh()) later(save);
  flow("rename-actions", [
    { id: "btn-rename-save", text: T("save"), style: "btn-primary", act: save },
    { id: "btn-rename-cancel", text: T("cancel"), act: () => open("title", "btn-profile-name") },
  ], w);
}
interface Card { id: string; title: string; desc: string; meta?: string; act?: () => void }
function cardGrid(label: string, items: Card[], width: number, min = 208, gap = 11.2): void {
  const cols = Math.max(1, Math.min(items.length, Math.floor((width + gap) / (min + gap))));
  const cw = (width - (cols - 1) * gap) / cols, faceW = cw - 34;
  const sc = ui.preferences().scale;
  ui.column(label, () => {
    for (let r = 0; r * cols < items.length; r++) {
      const row = items.slice(r * cols, (r + 1) * cols);
      const h = Math.max(44, ...row.map((c) => (lastSize.get(`${c.id}-face`)?.height ?? 0) / sc + 30));
      ui.row(`${label}-r${r}`, () => {
        for (const c of row) {
          const face = (): void => {
            lastSize.set(`${c.id}-face`, ui.column(`${c.id}-face`, () => {
              para(c.title, faceW, "card-title", `${c.id}-t`);
              para(c.desc, faceW, "card-desc", `${c.id}-d`);
              if (c.meta) para(c.meta, faceW, "card-meta", `${c.id}-m`);
            }, { spacing: 4, width: faceW }));
          };
          if (c.act) {
            if (ui.style("card", { width: cw, height: h }).id(c.id).button(c.title, { content: face }) && fresh()) later(c.act);
          } else ui.column(`${c.id}-box`, face, { style: "card-static", width: cw, height: h });
        }
      }, { spacing: gap });
    }
  }, { spacing: gap, width });
}
function modesScreen(w: number): void {
  ui.style("h1").id("modes-h").label(T("modesH"));
  const n = journeyDone(), streak = platform.store.doc.daily.streak;
  cardGrid("mode-cards", [
    { id: "mode-learn", title: T("learn"), desc: T("learnDesc"), act: () => openMode("learn") },
    { id: "mode-journey", title: T("journey"), desc: T("journeyDesc"), meta: n > 0 ? T("metaJourney", { n, total: Content.JOURNEY.length }) : "", act: () => openMode("journey") },
    { id: "mode-daily", title: T("dailySteep"), desc: T("dailyDesc"), meta: streak > 0 ? T("metaStreak", { n: streak }) : "", act: () => openMode("daily") },
    { id: "mode-practice", title: T("practice"), desc: T("practiceDesc"), act: () => openMode("practice") },
    { id: "mode-challenge", title: T("challenge"), desc: T("challengeDesc"), act: () => openMode("challenge") },
    { id: "mode-boards", title: T("scoreChase"), desc: T("scoreChaseDesc"), act: () => openMode("boards") },
  ], w);
  button({ id: "btn-modes-back", text: T("back"), act: () => nav("title") });
}

// -- setup lists (main.js _openMode)
interface Item { id: string; label: string; meta?: string; stars?: string; disabled?: boolean }
interface Group { heading?: string; items: Item[] }
function setupSpec(mode: string): { title: string; blurb: string; groups: Group[] } {
  const doc = platform.store.doc;
  switch (mode) {
    case "learn": return { title: T("learn"), blurb: T("learnBlurb"), groups: [{ items: Content.LESSONS.map((l) => ({
      id: "lesson:" + l.id, label: tn("lessons", l.id, l.name), meta: doc.progression.lessons[l.id]?.done ? T("completed") : T("nSteps", { n: l.steps.length }),
    })) }] };
    case "journey": {
      const prog = doc.progression.journey;
      return { title: T("journey"), blurb: T("journeyBlurb"), groups: Content.JOURNEY_CHAPTERS.map((ch) => ({
        heading: ch.unlockTheme ? T("chapterUnlock", { chapter: chapterName(ch.id, ch.name), theme: themeName(ch.unlockTheme, Content.THEMES[ch.unlockTheme]?.name) }) : chapterName(ch.id, ch.name),
        items: ch.stages.map((id) => {
          const stage = Content.JOURNEY.find((s) => s.id === id)!;
          const prev = stage.index > 0 ? prog[Content.JOURNEY[stage.index - 1]!.id] : { stars: 1 };
          const rec = prog[id];
          const unlocked = (prev?.stars ?? 0) > 0;
          return {
            id: "journey:" + id, label: `${levelName(stage)}${stage.mastery ? T("masteryTag") : ""}`,
            stars: rec && rec.stars > 0 ? "★".repeat(rec.stars) : "", meta: unlocked ? T("nTiles", { n: stage.config.triples * 3 }) : T("locked"), disabled: !unlocked,
          };
        }),
      })) };
    }
    case "daily": {
      const local = Content.dailyLevel(Content.todayUTC(platform.now()));
      const day = local.day ?? "";
      const h = doc.daily.history[day];
      return { title: T("dailySteep"), blurb: T("dailyBlurb"), groups: [{ items: [{
        id: "daily:play", label: h ? T("playAgain", { day }) : T("playToday", { day }),
        meta: h ? T("bestToday", { score: h.score, status: h.status === "won" ? T("statusWon") : T("statusLost") }) : T("dailyMeta", { n: local.config.triples * 3 }),
      }] }] };
    }
    case "practice": return { title: T("practice"), blurb: T("practiceBlurb"), groups: [{ items: Content.PRACTICE_DIFFICULTIES.map((d) => ({
      id: "practice:" + d.id, label: tn("difficulties", d.id, d.name), meta: T("tilesLayers", { tiles: d.config.triples * 3, layers: d.config.maxLayers }),
    })) }] };
    case "challenge": return { title: T("challenge"), blurb: T("challengeBlurb"), groups: [{ items: Content.CHALLENGES.map((c) => {
      const rec = doc.challenges[c.id];
      return { id: "challenge:" + c.id, label: tn("challenges", c.id, c.name), meta: [tn("blurbs", c.id, c.blurb ?? ""), rec?.done ? T("bestN", { n: rec.bestScore }) : ""].filter(Boolean).join(" — ") };
    }) }] };
    default: return { title: T("scoreChase"), blurb: platform.signedIn() ? T("boardsHosted") : T("boardsLocal"), groups: [{ items: [
      { id: "board:daily", label: T("boardDaily"), meta: T("sharedSeeds") },
      { id: "board:journey", label: T("boardJourney"), meta: T("allStages") },
      { id: "board:challenge", label: T("boardChallenge"), meta: T("fixedTrials") },
    ] }] };
  }
}
function setupScreen(w: number, L: Layout): void {
  const mode = app.setupMode ?? "learn";
  const spec = setupSpec(mode);
  ui.style("h1").id("setup-h").label(spec.title);
  para(spec.blurb, w, "dim", "setup-blurb");
  const list = (lw: number): void => {
    ui.column("setup-list", () => {
      for (const [gi, g] of spec.groups.entries()) {
        if (g.heading) para(g.heading, lw, "chapter", `setup-ch-${gi}`);
        for (const it of g.items) {
          const meta = [it.stars, it.meta].filter(Boolean).join(" · ");
          const metaW = Math.min(lw * 0.5, textWidth(meta, "meta") + 2);
          const labW = lw - 30 - metaW - 10;
          if (ui.style("item", { width: lw }).id(it.id).button(`${it.label}${meta ? ", " + meta : ""}`, {
            disabled: !!it.disabled,
            content: () => {
              ui.row(`${it.id}-in`, () => {
                para(it.label, labW, it.disabled ? "item-label-off" : "item-label");
                ui.spacer();
                if (meta) para(meta, metaW, "meta");
              }, { width: lw - 30, align: "center", spacing: 10 });
            },
          }) && fresh() && !it.disabled) later(() => setupPicked(it.id));
        }
      }
    }, { spacing: 6.4, width: lw });
  };
  const maxH = L.lh * 0.55;
  const listKey = `setup-list-${mode}`;
  const prev = lastSize.get(listKey);
  if (prev && prev.height / L.sc > maxH) ui.scrollArea("setup-scroll", { width: w, height: maxH }, () => { list(w - 14); });
  else lastSize.set(listKey, ui.column("setup-list-box", () => list(w)));
  if (mode === "boards") boardsExtra(w);
  button({ id: "btn-setup-back", text: T("back"), act: () => nav("modes") });
}
function boardsExtra(w: number): void {
  const v = app.boardView;
  if (!v) { para(T("pickBoard"), w, "dim", "pick-board"); return; }
  const doc = platform.store.doc;
  const title = T({ daily: "nameDaily", journey: "nameJourney", challenge: "nameChallenge" }[v.board] ?? "scoreChase");
  type Row = { rank: number; name: string; table: string; score: number; time: string };
  const table = (id: string, rows: Row[]): void => {
    const cols = [0.1, 0.36, 0.24, 0.15, 0.15].map((k) => k * w);
    const head = ["#", T("colPlayer"), T("colTable"), T("colScore"), T("colTime")];
    const line = (rid: string, cells: string[], cls: string): void => {
      ui.row(rid, () => { cells.forEach((c, i) => ui.column(`${rid}-c${i}`, () => para(c, cols[i]! - 6, cls), { width: cols[i]! })); }, { style: "score-row", width: w });
    };
    ui.column(id, () => {
      line(`${id}-head`, head, "dim");
      if (!rows.length) para(T("noEntries"), w, "dim", `${id}-empty`);
      rows.forEach((r, i) => line(`${id}-r${i}`, [String(r.rank), r.name, r.table, String(r.score), r.time], "text"));
    }, { width: w });
  };
  const local = (doc.boards[v.board] ?? []).slice(0, 20).map((e, i) => ({ rank: i + 1, name: playerName(e.name), table: e.contentId ?? e.day ?? "", score: e.score, time: fmtMs(0) }));
  if (platform.signedIn()) {
    para(title, w, "h3", "board-title");
    if (v.loading) para(T("thinking"), w, "dim", "board-loading");
    else if (v.global && v.global.length) {
      para(T("globalBoard"), w, "text", "global-h");
      table("global-table", v.global.map((e) => ({ rank: e.rank, name: playerName(e.name), table: "", score: e.score, time: "" })));
      if (v.me != null) para(T("platformRank", { rank: v.me }), w, "dim", "me-rank");
    } else para(T("globalEmpty"), w, "dim", "global-empty");
    para(T("localBests"), w, "text", "local-h");
    toggleRow("chk-friends", T("friendsOnly"), app.boardFriends, w, setBoardFriends);
    table("local-table", local);
  } else {
    para(`${title} — ${T("sourceLocal")}`, w, "h3", "board-title");
    table("local-table", local);
  }
}
function keysFor(action: string): string {
  const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc", "Numpad Enter": "Num Enter" };
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join(" / ") || "—";
}
function helpScreen(w: number): void {
  ui.style("h1").id("help-h").label(T("howToPlayH"));
  const controls = T("controlsText", {
    left: keysFor("focus_left"), right: keysFor("focus_right"), up: keysFor("focus_up"), down: keysFor("focus_down"),
    pick: keysFor("pick"), undo: keysFor("undo"), hint: keysFor("hint"), camera: keysFor("camera"), pause: keysFor("pause"),
  });
  cardGrid("help-grid", [
    { id: "help-idea", title: T("helpIdea"), desc: T("helpIdeaText") },
    { id: "help-tray", title: T("helpTray"), desc: T("helpTrayText") },
    { id: "help-covered", title: T("helpCovered"), desc: T("helpCoveredText") },
    { id: "help-combos", title: T("helpCombos"), desc: T("helpCombosText") },
    { id: "help-controls", title: T("helpControls"), desc: controls },
    { id: "help-fair", title: T("helpFair"), desc: T("helpFairText") },
  ], w);
  button({ id: "btn-help-back", text: T("back"), act: () => nav("back") });
}
const ROW_KEYS: Record<string, string> = { triples: "scoreTriples", combo: "scoreCombo", slots: "scoreSlots", time: "scoreTime" };
function resultsScreen(w: number): void {
  const r = resultsSpec();
  if (!r) return;
  ui.style("h1").id("results-h").label(r.won ? T("tableCleared") : T("roundOver"));
  para(r.reasonText, w, "dim", "results-sub");
  const tw = Math.min(w, 360);
  ui.column("results-table", () => {
    for (const row of r.rows) {
      ui.row(`res-${row.key}`, () => {
        para(T(ROW_KEYS[row.key] ?? row.key, { n: row.count ?? "" }), tw * 0.7, "score-k");
        ui.spacer();
        ui.style("score-v").label(String(row.value));
      }, { style: "score-row", width: tw });
    }
    ui.row("res-total", () => { ui.style("total-k").label(T("total")); ui.spacer(); ui.style("total-v").id("results-total").label(String(r.total)); }, { style: "total-row", width: tw });
  }, { width: tw });
  if (r.stars > 0) ui.style("stars").id("results-stars").label("★".repeat(r.stars) + "☆".repeat(3 - r.stars));
  for (const [i, a] of r.achievements.entries()) {
    ui.column(`ach-${i}`, () => para(T("achievementLine", { name: a.name, desc: a.description }), w - 30, "ach-text"), { style: "ach" });
  }
  para(r.board.platform ? S(r.board.key, r.board.vars) : T(r.board.key), w, "dim", "results-board");
  flow("results-actions", [
    { id: "btn-results-retry", text: T("retry"), act: retry },
    { id: "btn-results-next", text: r.nextLabel, style: "btn-primary", act: next },
    { id: "btn-results-menu", text: T("menu"), act: goTitle },
  ], w);
}

// ------------------------------------------------------------------ pause / settings overlay
function pauseOverlay(L: Layout): void {
  const only = app.settingsOnly;
  const w = Math.min(L.lw - (L.phone ? 16 : 32), 544);
  const padX = L.phone ? 16 : 24;
  const inner = w - 2 * padX;
  const maxH = L.lh - 32;
  const prev = lastSize.get("pause-in");
  const scroll = !!prev && prev.height / L.sc + 42 > maxH;
  const opening = frame().frame - app.openedFrame <= 6;
  const isOpen = ui.dialog(only ? T("settings") : T("paused"), "", true, () => {
    ui.column("pause-panel", () => {
      const iw = inner - (scroll ? 14 : 0);
      const body = (): void => { lastSize.set("pause-in", ui.column("pause-body", () => pauseBody(iw, only), { spacing: 10, width: iw, align: "center" })); };
      if (scroll) ui.scrollArea("pause-scroll", { width: inner + 6, height: maxH - 42 }, body, opening ? { scrollTo: { top: 0 } } : undefined);
      else body();
    }, { style: "panel-solid", width: w, spacing: 0, padding: { top: 20, bottom: 20, start: padX, end: padX } });
  });
  if (!isOpen && fresh()) later(resumeGame);
}
function pauseBody(w: number, only: boolean): void {
  ui.style("h1").id("pause-h").label(only ? T("settings") : T("paused"));
  button({ id: "btn-resume", text: only ? T("done") : T("resume"), style: "btn-primary", act: resumeGame });
  if (!only) flow("pause-actions", [
    { id: "btn-pause-help", text: T("help"), act: openHelpFromPause },
    { id: "btn-leave", text: T("leaveRound"), style: "btn-danger", act: leaveRound },
  ], w);
  const s = settings();
  const fw = w - 26;
  ui.column("fs-display", () => {
    ui.style("legend").label(G("graphics"));
    const cams = ["default", "top", "low"];
    selectRow("sel-camera", T("cameraView"), Math.max(0, cams.indexOf(s.cameraView)), [T("camDefault"), T("camTop"), T("camLow")], fw, (i) => setSetting({ cameraView: cams[i] }));
    const themes = ["auto", ...platform.store.doc.progression.unlockedThemes];
    selectRow("sel-theme", T("tableTheme"), Math.max(0, themes.indexOf(s.themeChoice)),
      themes.map((id) => (id === "auto" ? T("themeAuto") : themeName(id, Content.THEMES[id]?.name))), fw, (i) => setSetting({ themeChoice: themes[i] }));
  }, { style: "fieldset", width: w, spacing: 7 });
  ui.column("fs-access", () => {
    ui.style("legend").label(T("accessibility"));
    const pals = ["default", "deuteranopia", "protanopia", "tritanopia"];
    selectRow("sel-palette", T("symbolPalette"), Math.max(0, pals.indexOf(s.colorblindPalette)), [T("palDefault"), T("palDeut"), T("palProt"), T("palTrit")], fw,
      (i) => setSetting({ colorblindPalette: pals[i] }));
    toggleRow("chk-captions", T("captions"), !!s.captions, fw, (v) => setSetting({ captions: v }));
    toggleRow("chk-left", T("leftHanded"), !!s.leftHanded, fw, (v) => setSetting({ leftHanded: v }));
    toggleRow("chk-hold", T("holdToConfirm"), !!s.holdToConfirm, fw, (v) => setSetting({ holdToConfirm: v }));
    toggleRow("chk-timing", T("timingAssist"), !!s.timingAssist, fw, (v) => setSetting({ timingAssist: v }));
    flow("replay-row", [{ id: "btn-replay-tutorial", text: T("replayTutorial"), act: replayTutorial }], fw, 6, "start");
  }, { style: "fieldset", width: w, spacing: 7 });
  ui.column("runtime-opts", () => {
    para(T("optRuntime"), w, "dim", "opt-runtime");
    flow("runtime-row", [
      { id: "btn-options", text: T("openOptions"), act: () => openMenu() },
      { id: "btn-rebind", text: T("keyBindings"), act: () => requestRebind() },
    ], w);
  }, { spacing: 8, width: w });
}
