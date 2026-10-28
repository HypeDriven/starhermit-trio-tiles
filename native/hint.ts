// The hint search (js/rules/solver.js suggestMove: a depth-first solve of the
// current table with a 60,000-node budget, else the pair/single heuristic)
// on a starhermit:script worker (native/hint-worker.js), so a long search on
// a crowded table never stalls a frame natively; main.ts shows "Thinking…"
// once it takes over 300 ms. Without a worker (it failed to start) the search
// runs on the game's thread as the browser build's did.
import { worker, type Worker } from "starhermit:script";
import { Solver, type State } from "./game.ts";

let w: Worker | null = null;
let failed = false;
let nextId = 1;
let waiting: { id: number; done: (id: string | null) => void } | null = null;

function ensure(): Worker | null {
  if (w || failed) return w;
  try {
    w = worker("native/hint-worker.js", { type: "module" });
    w.on("message", (m) => {
      const r = m as unknown as { id: number; tile: string | null };
      if (!waiting || waiting.id !== r.id) return;
      const job = waiting;
      waiting = null;
      job.done(r.tile);
    });
    w.on("error", (msg) => { if (!/not responding/i.test(msg)) console.warn(`hint worker: ${msg}`); });
    w.on("stopped", () => {
      failed = true; w = null;
      const job = waiting;
      waiting = null;
      if (job) job.done(null);
    });
  } catch (e) { console.warn(`hint worker: ${String(e)}`); failed = true; w = null; }
  return w;
}
export function warm(): void { ensure(); }
export function cancel(): void { waiting = null; }
/** Asks for the suggested tile for `state`; `done` hears it (null: none). */
export function request(state: State, done: (id: string | null) => void): void {
  const sync = (): void => { let id: string | null = null; try { id = Solver.suggestMove(state); } catch { id = null; } done(id); };
  const wk = ensure();
  if (!wk) { sync(); return; }
  const id = nextId++;
  waiting = { id, done };
  try { wk.post({ id, state: JSON.parse(JSON.stringify(state)) }); }
  catch (e) { waiting = null; console.warn(`hint worker: ${String(e)}`); sync(); }
}
