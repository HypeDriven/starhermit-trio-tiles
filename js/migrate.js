/**
 * Carrying the browser build's account data over to the engine client (pure;
 * native/platform.ts calls it, tests/save.test.mjs covers it). The browser
 * build mirrored its settings into the account's settings KV, one key per
 * setting (patchSettings), plus the language helper's ui.language and the
 * options panel's audio.options. The game's own options among them carry
 * over; the rest are the runtime's Options now.
 */
export const OWN_OPTIONS = {
  captions: 'boolean', colorblindPalette: 'string', leftHanded: 'boolean', holdToConfirm: 'boolean',
  timingAssist: 'boolean', cameraView: 'string', themeChoice: 'string',
};
const CHOICES = {
  colorblindPalette: ['default', 'deuteranopia', 'protanopia', 'tritanopia'],
  cameraView: ['default', 'top', 'low'],
};
/** The old KV values (key → value) the game keeps: its own options, with the right types and values. */
export function pickLegacy(kv) {
  const out = {};
  for (const [k, type] of Object.entries(OWN_OPTIONS)) {
    const v = kv?.[k];
    if (typeof v !== type) continue;
    if (type === 'string' && (!v || v.length > 64 || (CHOICES[k] && !CHOICES[k].includes(v)))) continue;
    out[k] = v;
  }
  return out;
}
