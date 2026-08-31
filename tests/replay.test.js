import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, verifyReplay } from '../js/session/session.js';
import { materializeLevel, practiceLevel, dailyLevel, CHALLENGES, LESSONS, lessonLevel } from '../js/rules/content.js';
import { legalActions, stateHash } from '../js/rules/engine.js';
import { mulberry32 } from '../js/rules/rng.js';

function randomCommands(session, rand, max = 200) {
  // Drive a session with random legal (and occasional illegal) commands.
  for (let i = 0; i < max; i++) {
    if (session.state.status !== 'active') break;
    const la = legalActions(session.state);
    const roll = rand();
    if (roll < 0.85 && la.selectable.length > 0) {
      const tileId = la.selectable[Math.floor(rand() * la.selectable.length)];
      session.submit({ type: 'select', tileId });
    } else if (roll < 0.9 && la.canUndo) {
      session.submit({ type: 'undo' });
    } else if (roll < 0.95) {
      session.submit({ type: 'tick', dt: 50 * (1 + Math.floor(rand() * 20)) });
    } else {
      // Occasionally poke a blocked/unknown tile (counted invalid).
      const any = session.state.tiles[Math.floor(rand() * session.state.tiles.length)];
      if (any) session.submit({ type: 'select', tileId: any.id });
    }
  }
}

test('replay determinism: same version+seed+commands ⇒ identical hashes', () => {
  const level = materializeLevel(practiceLevel('normal', 'replay-seed'));
  const rand = mulberry32(12345);
  const a = new Session(level, { sessionId: 'replay-test' });
  randomCommands(a, rand);
  const env = a.envelope();

  // Re-run the exact command stream in a fresh session.
  const b = new Session(level, { sessionId: 'replay-test' });
  for (const cmd of env.commands) b.submit({ ...cmd });
  assert.equal(stateHash(b.state), stateHash(a.state));
  assert.deepEqual(b.hashes, a.hashes);

  const verdict = verifyReplay(env, { levelResolver: () => level });
  assert.equal(verdict.ok, true, verdict.error);
  assert.ok(verdict.result);
  assert.equal(verdict.result.score, a.result().score);
});

test('replay envelope detects tampering', () => {
  // Lesson-3 has a covered tile: 'top' must be lifted before 'a' is legal.
  // Swapping those two commands is outcome-changing (a counted invalid
  // attempt), so the tampered envelope must fail verification.
  const level = lessonLevel(LESSONS[2]);
  const s = new Session(level, { sessionId: 't1' });
  for (const id of ['top', 'a', 'b', 'c', 'd', 'e']) s.submit({ type: 'select', tileId: id });
  assert.equal(s.state.status, 'won');
  const env = s.envelope();
  assert.equal(verifyReplay(env, { levelResolver: () => level }).ok, true);

  const swapped = JSON.parse(JSON.stringify(env));
  const t = swapped.commands[0];
  swapped.commands[0] = swapped.commands[1];
  swapped.commands[1] = t;
  assert.equal(verifyReplay(swapped, { levelResolver: () => level }).ok, false, 'order-changing swap must not verify');

  const truncated = JSON.parse(JSON.stringify(env));
  truncated.commands.pop();
  assert.equal(verifyReplay(truncated, { levelResolver: () => level }).ok, false, 'dropped command must not verify');

  const forged = JSON.parse(JSON.stringify(env));
  forged.result.score += 100000;
  assert.equal(verifyReplay(forged, { levelResolver: () => level }).ok, false, 'forged score must not verify');

  const hashForged = JSON.parse(JSON.stringify(env));
  hashForged.finalHash = (hashForged.finalHash + 1) >>> 0;
  assert.equal(verifyReplay(hashForged, { levelResolver: () => level }).ok, false, 'forged final hash must not verify');
});

test('undo restores state and keeps turn monotonic', () => {
  const level = materializeLevel(practiceLevel('easy', 'undo-seed'));
  const s = new Session(level, { sessionId: 'u1' });
  const la0 = legalActions(s.state);
  const pick = la0.selectable[0];
  s.submit({ type: 'select', tileId: pick });
  const afterPick = s.state;
  assert.equal(afterPick.moves, 1);
  const turnAfterPick = afterPick.turn;

  const r = s.submit({ type: 'undo' });
  assert.equal(r.ok, true);
  assert.equal(s.state.moves, 0);
  assert.equal(s.state.tiles.length, level.tiles.length);
  assert.equal(s.state.turn, turnAfterPick + 1, 'turn never goes backwards');
  assert.equal(s.state.undosUsed, 1);

  // And the same pick is legal again, producing the same successor modulo turn.
  s.submit({ type: 'select', tileId: pick });
  assert.equal(s.state.moves, 1);
});

test('undo is rejected where rules forbid it', () => {
  const level = materializeLevel(CHALLENGES[0]); // undo disabled
  const s = new Session(level, { sessionId: 'u2' });
  const la = legalActions(s.state);
  s.submit({ type: 'select', tileId: la.selectable[0] });
  const r = s.submit({ type: 'undo' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'undo_disabled');
});

test('duplicate command ids are rejected idempotently', () => {
  const level = materializeLevel(practiceLevel('easy', 'dup'));
  const s = new Session(level, { sessionId: 'd1' });
  const la = legalActions(s.state);
  const cmd = { id: 'fixed-id', type: 'select', tileId: la.selectable[0] };
  const r1 = s.submit({ ...cmd });
  const r2 = s.submit({ ...cmd });
  assert.equal(r1.ok, true);
  assert.equal(r2.duplicate, true);
  assert.equal(s.state.moves, 1, 'no double commit');
});

test('full-session golden path: win a practice round via solver hints', () => {
  const level = materializeLevel(practiceLevel('normal', 'golden'));
  const s = new Session(level, { sessionId: 'g1' });
  let guard = 0;
  while (s.state.status === 'active' && guard++ < 500) {
    const la = legalActions(s.state);
    // Greedy: prefer completing a pair already in the tray.
    const traySyms = new Map();
    for (const e of s.state.tray) traySyms.set(e.sym, (traySyms.get(e.sym) ?? 0) + 1);
    const byId = new Map(s.state.tiles.map((t) => [t.id, t]));
    let pick = null;
    let best = -1;
    for (const id of la.selectable) {
      const score = traySyms.get(byId.get(id).sym) ?? 0;
      if (score > best) {
        best = score;
        pick = id;
      }
    }
    s.submit({ type: 'select', tileId: pick });
    s.submit({ type: 'tick', dt: 100 });
  }
  // Layouts are solvable; a perfect solver isn't used here, so either terminal
  // state is acceptable — but the envelope must always verify.
  assert.notEqual(s.state.status, 'active');
  const verdict = verifyReplay(s.envelope(), { levelResolver: () => level });
  assert.equal(verdict.ok, true, verdict.error);
  assert.ok(['cleared', 'tray_full'].includes(s.state.terminalReason));
});

test('daily envelope verifies against daily content', { timeout: 60000 }, () => {
  const level = materializeLevel(dailyLevel(new Date(Date.UTC(2026, 7, 16))));
  const s = new Session(level, { sessionId: 'daily-1' });
  randomCommands(s, mulberry32(99));
  const verdict = verifyReplay(s.envelope(), { levelResolver: () => level });
  assert.equal(verdict.ok, true, verdict.error);
});

test('lesson levels run through the same session machinery', () => {
  const level = lessonLevel(LESSONS[0]);
  const s = new Session(level, { sessionId: 'learn-1' });
  s.submit({ type: 'select', tileId: 'a' });
  s.submit({ type: 'select', tileId: 'b' });
  const r = s.submit({ type: 'select', tileId: 'c' });
  assert.equal(r.state.status, 'won');
  assert.ok(r.events.some((e) => e.type === 'triple'));
  assert.ok(r.events.some((e) => e.type === 'win'));
});
