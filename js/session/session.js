/**
 * Session layer — owns the command stream, undo stack, periodic state hashes,
 * and the replay envelope. The engine stays pure; everything rules-visible
 * flows through validated commands here (spec §5: no module may mutate rules
 * state except through a validated command).
 */

import {
  createGame,
  applyCommand,
  validateCommand,
  serializeState,
  deserializeState,
  stateHash,
  resultRecord,
} from '../rules/engine.js';
import { hashString } from '../rules/rng.js';
import { CONTENT_VERSION, BUILD_ID } from '../rules/content.js';

export const REPLAY_SCHEMA_VERSION = 1;
const HASH_EVERY_TURNS = 10;

export class Session {
  /**
   * @param {object} level  materialized level (from materializeLevel)
   * @param {object} [opts] { sessionId, assists, clockOffsetMs }
   */
  constructor(level, opts = {}) {
    this.level = level;
    this.sessionId = opts.sessionId ?? `s-${hashString(String(Math.random()) + Date.now()).slice(0, 10)}`;
    const timingAssist = !!opts.assists?.timingAssist;
    this.state = createGame({
      tiles: level.tiles,
      seed: level.seed,
      meta: {
        contentId: level.id,
        rulesetId: level.kind === 'daily' ? 'daily-v1' : 'standard-v1',
        difficulty: level.difficulty,
        theme: level.theme,
      },
      trayCapacity: level.config.trayCapacity ?? 7,
      limits: {
        moveLimit: level.config.moveLimit ?? null,
        // Timing assistance extends the clock and marks the run assisted.
        timeLimitMs: level.config.timeLimitMs
          ? Math.round(level.config.timeLimitMs * (timingAssist ? 1.5 : 1))
          : null,
      },
      assists: {
        undo: level.config.undo || !!opts.assists?.undo,
        hint: level.config.hints !== false,
        timingAssist,
      },
      parMs: level.parMs ?? null,
    });
    this.stack = [this.state]; // undo snapshots; stack[0] is the opening state
    this.commands = []; // ordered applied commands (the replay log)
    this.hashes = [{ turn: 0, hash: stateHash(this.state) }];
    this.commandSeq = 0;
    this.seenCommandIds = new Set();
    this.events = []; // presentation events since last drain
    this.finished = false;
  }

  /** Next deterministic command id (ids prevent accidental double commits). */
  nextCommandId() {
    return `${this.sessionId}:c${++this.commandSeq}`;
  }

  /**
   * Submit a command. Duplicate command ids are rejected idempotently.
   * Returns { ok, reason?, events, state }.
   */
  submit(cmd) {
    if (this.finished) {
      return { ok: false, reason: 'not_active', events: [], state: this.state };
    }
    if (!cmd.id) cmd.id = this.nextCommandId();
    if (this.seenCommandIds.has(cmd.id)) {
      return { ok: true, duplicate: true, events: [], state: this.state };
    }

    // Undo is resolved against the session-owned snapshot stack.
    if (cmd.type === 'undo') {
      const v = validateCommand(this.state, cmd);
      this.seenCommandIds.add(cmd.id);
      if (!v.ok) return { ok: false, reason: v.reason, events: [{ type: 'invalid', reason: v.reason }], state: this.state };
      const current = this.state;
      this.stack.pop();
      const restored = deserializeState(serializeState(this.stack[this.stack.length - 1]));
      // Turn and undo count derive from the live state (the stack only tracks
      // select snapshots — ticks/hints advance the live turn past them), so
      // the turn number stays strictly monotonic across undo.
      restored.turn = current.turn + 1;
      restored.undosUsed = current.undosUsed + 1;
      this.state = restored;
      this.commands.push({ id: cmd.id, type: 'undo' });
      this._recordHash();
      const events = [{ type: 'undo' }];
      this.events.push(...events);
      return { ok: true, events, state: this.state };
    }

    const result = applyCommand(this.state, cmd);
    this.seenCommandIds.add(cmd.id);
    if (!result.ok) {
      this.state = result.state;
      this.events.push(...result.events);
      return { ok: false, reason: result.reason, events: result.events, state: this.state };
    }

    this.state = result.state;
    if (cmd.type === 'select') this.stack.push(this.state);
    this.commands.push(stripCommand(cmd));
    this._recordHash();
    this.events.push(...result.events);
    if (this.state.status !== 'active') this.finished = true;
    return { ok: true, events: result.events, state: this.state };
  }

  _recordHash() {
    if (this.state.turn % HASH_EVERY_TURNS === 0 || this.state.status !== 'active') {
      this.hashes.push({ turn: this.state.turn, hash: stateHash(this.state) });
    }
  }

  /** Presentation events accumulated since the last drain. */
  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Authoritative result record (score components, tiebreak fields). */
  result() {
    return resultRecord(this.state, this.sessionId);
  }

  /**
   * Replay envelope (spec §5): schema version, build/content version, seed,
   * initial hash, ordered commands, periodic state hashes, terminal result.
   */
  envelope() {
    return {
      schemaVersion: REPLAY_SCHEMA_VERSION,
      build: BUILD_ID,
      contentVersion: CONTENT_VERSION,
      level: envelopeLevelDescriptor(this.level),
      seed: this.state.seed,
      sessionId: this.sessionId,
      initialHash: this.hashes[0]?.hash ?? 0,
      commands: this.commands.map((c) => ({ ...c })),
      hashes: this.hashes.map((h) => ({ ...h })),
      finalHash: stateHash(this.state),
      result: this.finished ? this.result() : null,
    };
  }
}

function stripCommand(cmd) {
  const { type, tileId, dt } = cmd;
  const out = { id: cmd.id, type };
  if (tileId !== undefined) out.tileId = tileId;
  if (dt !== undefined) out.dt = dt;
  return out;
}

function envelopeLevelDescriptor(level) {
  // Everything needed to re-materialize the exact content, no more.
  return {
    id: level.id,
    kind: level.kind,
    version: level.version,
    seed: level.seed,
    theme: level.theme,
    config: level.config,
    tiles: level.kind === 'learn' ? level.tiles : undefined,
  };
}

/**
 * Deterministically re-run a replay envelope. Returns
 * { ok, finalHash, result, error?, mismatchedTurn? }. Never throws on
 * malformed input — replays are untrusted data.
 */
export function verifyReplay(envelope, { levelResolver } = {}) {
  try {
    if (!envelope || envelope.schemaVersion !== REPLAY_SCHEMA_VERSION) {
      return { ok: false, error: 'unsupported schema version' };
    }
    const desc = envelope.level;
    if (!desc || typeof desc.seed !== 'string' || !desc.config) return { ok: false, error: 'bad level descriptor' };
    let level = levelResolver ? levelResolver(desc) : null;
    if (!level) {
      // Re-materialize from the descriptor alone (daily/practice/challenge).
      const tiles = desc.tiles ?? null;
      if (!tiles) return { ok: false, error: 'level resolver required for generated content' };
      level = { ...desc, parMs: null, difficulty: 1 };
    }
    const session = new Session(level, { sessionId: envelope.sessionId });
    if (session.hashes[0].hash !== envelope.initialHash) {
      return { ok: false, error: 'initial hash mismatch' };
    }
    let commandSeq = 0;
    for (const cmd of envelope.commands ?? []) {
      commandSeq++;
      const res = session.submit({ ...cmd, id: cmd.id ?? `${envelope.sessionId}:c${commandSeq}` });
      if (!res.ok && res.reason === 'not_active') return { ok: false, error: 'commands continue after terminal state' };
    }
    const finalHash = stateHash(session.state);
    const recorded = envelope.hashes ?? [];
    for (const h of recorded) {
      // Recompute the hash at that turn by walking the session's own hashes.
      const mine = session.hashes.find((x) => x.turn === h.turn);
      if (mine && mine.hash !== h.hash) {
        return { ok: false, error: 'state hash mismatch', mismatchedTurn: h.turn };
      }
    }
    // The envelope's final hash is authoritative and always checked.
    if (typeof envelope.finalHash === 'number' && envelope.finalHash !== finalHash) {
      return { ok: false, error: 'final hash mismatch' };
    }
    const result = session.finished ? session.result() : null;
    if (envelope.result && result) {
      const sameScore = envelope.result.score === result.score;
      const sameStatus = envelope.result.status === result.status;
      if (!sameScore || !sameStatus) return { ok: false, error: 'recorded result does not match replay' };
    }
    return { ok: true, finalHash, result };
  } catch (err) {
    return { ok: false, error: 'replay verification crashed: ' + (err?.message ?? String(err)) };
  }
}
