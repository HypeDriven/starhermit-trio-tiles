// The look of the screens, the HUD and the overlays: the browser build's
// css/main.css, rewritten class-based in tools/ui-style.css and converted once
// with `starhermit css` into assets/ui-style.json (`npm run css`), registered
// at start with the theme the runtime's own widgets (scroll bars, focus rings,
// selects, text fields) take. The runtime's high contrast option is the old
// body.high-contrast tokens.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  ink: "#f3e8d8", "ink-dim": "#c9b9a4", panel: "#1c140ee0", "panel-solid": "#241a12", edge: "#4a3626",
  accent: "#e0a05a", "accent-strong": "#f0bc74", danger: "#d05a4a", ok: "#7ac88a", focus: "#ffd98a",
};
const CONTRAST: Tokens = {
  ink: "#ffffff", "ink-dim": "#e8e0d0", panel: "#000000f2", "panel-solid": "#000000", edge: "#ffffff",
  accent: "#ffd24a", "accent-strong": "#ffe98a", focus: "#ffffff",
};
let current: Tokens = { ...BASE };
let key = "";
export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "system-ui" });
  ui.setTheme({
    fontSize: 16, smallSize: 14, headingSize: 25.6, padding: 8, spacing: 8, radius: 10,
    text: BASE.ink!, muted: BASE["ink-dim"]!, panel: BASE["panel-solid"]!, control: "#33241a", hovered: "#40301f",
    pressed: "#4a3826", field: "#33241a", accent: BASE.accent!, focus: BASE.focus!, outline: BASE.edge!,
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$ink-dim", radius: 4 } } },
    tooltip: { background: "$panel-solid", text: { color: "$ink" }, radius: 6, padding: 6 },
    // .overlay: rgba(10, 6, 4, 0.6) over the scene
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#0a060499" } } },
  });
  key = "";
  applyTokens(false);
}
export function applyTokens(highContrast: boolean): void {
  const k = String(highContrast);
  if (k === key) return;
  key = k;
  current = { ...BASE, ...(highContrast ? CONTRAST : {}) };
  ui.setTokens(current);
  ui.setTheme({
    text: current.ink!, muted: current["ink-dim"]!, panel: current["panel-solid"]!, accent: current.accent!, focus: current.focus!, outline: current.edge!,
  });
}
export function token(name: string): string { return current[name] ?? "#000000"; }
