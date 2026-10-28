// The hint search off the game's thread (starhermit:script worker, a module):
// js/rules/solver.js suggestMove, unchanged. In: { id, state }. Out: { id, tile }.
import { suggestMove } from '../js/rules/solver.js';

globalThis.onmessage = (e) => {
  const d = e.data;
  let tile = null;
  try { tile = suggestMove(d.state); } catch { tile = null; }
  postMessage({ id: d.id, tile: tile ?? null });
};
