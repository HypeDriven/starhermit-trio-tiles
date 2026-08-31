/**
 * Trio Tiles authoritative server — zero external dependencies (node:http).
 *
 * Serves the static distribution and the /api/v1 surface used by
 * js/platform/host.js:
 *   GET  /api/v1/time            server epoch time (round-trip offset sync)
 *   GET  /api/v1/daily?day=      daily challenge descriptor (seed per UTC day)
 *   GET/POST /api/v1/daily/session   durable daily session snapshot/reconnect
 *   POST /api/v1/score           replay-validated score submission (idempotent)
 *   GET  /api/v1/leaderboard     global / friends-filtered boards
 *   POST /api/v1/achievements    idempotent durable unlocks
 *   GET  /api/v1/achievements    player unlocks
 *   POST /api/v1/presence|activity|telemetry  lifecycle sinks (204)
 *
 * Score claims are untrusted: every submission carries a replay envelope that
 * is re-run through the same rules engine (imported verbatim) and accepted
 * only if the final state hash and score reproduce exactly.
 */

import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { join, normalize, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dailyLevel, materializeLevel, lessonLevel, ACHIEVEMENTS, CONTENT_VERSION, RULESET_STANDARD } from './js/rules/content.js';
import { compareResults } from './js/rules/engine.js';
import { verifyReplay } from './js/session/session.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const PORT = Number(process.env.PORT ?? 8080);
const BOARDS = new Set(['daily', 'journey', 'challenge']);
const ACHIEVEMENT_KEYS = new Set(ACHIEVEMENTS.map((a) => a.key));
const MAX_BODY = 512 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.opus': 'audio/ogg',
};

// ---------------------------------------------------------------------------
// Small durable JSON stores (atomic write via tmp + rename)
// ---------------------------------------------------------------------------

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJSON(file, data) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

const boardsFile = join(DATA_DIR, 'leaderboards.json');
const achievementsFile = join(DATA_DIR, 'achievements.json');
const sessionsFile = join(DATA_DIR, 'daily-sessions.json');
const excludedFile = join(DATA_DIR, 'excluded-days.json');

// ---------------------------------------------------------------------------
// Rate limiting — per identity+route token bucket, recoverable 429s
// ---------------------------------------------------------------------------

const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  b.count++;
  if (buckets.size > 5000) buckets.clear(); // bound memory; window restarts
  return b.count <= limit;
}

// ---------------------------------------------------------------------------
// Content resolver for replay validation — re-materializes the exact level
// from its descriptor through the shared content pipeline.
// ---------------------------------------------------------------------------

function levelResolver(desc) {
  try {
    if (desc.kind === 'learn' && Array.isArray(desc.tiles)) {
      return lessonLevel({ id: desc.id, name: desc.id, theme: desc.theme, tiles: desc.tiles });
    }
    if (typeof desc.seed === 'string' && desc.config) {
      return materializeLevel({
        id: desc.id,
        version: desc.version ?? CONTENT_VERSION,
        kind: desc.kind,
        name: desc.id,
        theme: desc.theme ?? 'dawn',
        seed: desc.seed,
        config: desc.config,
      });
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJSON(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendError(res, status, error) {
  sendJSON(res, status, { error });
}

async function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeName(name) {
  return String(name ?? 'Guest').replace(/[\u0000-\u001f<>"']/g, '').trim().slice(0, 24) || 'Guest';
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

async function handleApi(req, res, url, playerId, ip) {
  const path = url.pathname;
  const isPost = req.method === 'POST';
  if (!rateLimit(`${ip}:${isPost ? 'w' : 'r'}:${path}`, isPost ? 30 : 120, 60_000)) {
    return sendError(res, 429, 'rate_limited');
  }

  // --- server time ---------------------------------------------------------
  if (path === '/api/v1/time' && req.method === 'GET') {
    return sendJSON(res, 200, { epochMs: Date.now() });
  }

  // --- daily descriptor ----------------------------------------------------
  if (path === '/api/v1/daily' && req.method === 'GET') {
    const day = url.searchParams.get('day');
    const date = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(day + 'T00:00:00Z') : new Date();
    if (Number.isNaN(date.getTime())) return sendError(res, 400, 'bad day');
    const level = dailyLevel(date);
    const excluded = await readJSON(excludedFile, []);
    return sendJSON(res, 200, {
      day: level.day,
      seed: level.seed,
      theme: level.theme,
      contentVersion: CONTENT_VERSION,
      rulesetId: 'daily-v1',
      excluded: excluded.includes(level.day),
    });
  }

  // --- daily session snapshot / reconnect ----------------------------------
  if (path === '/api/v1/daily/session') {
    if (!playerId) return sendError(res, 401, 'player id required');
    if (req.method === 'GET') {
      const day = url.searchParams.get('day');
      const sessions = await readJSON(sessionsFile, {});
      const snap = sessions[`${playerId}:${day}`];
      if (!snap) return sendError(res, 404, 'no session');
      return sendJSON(res, 200, snap);
    }
    if (isPost) {
      const body = await readBody(req);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.day ?? '')) return sendError(res, 400, 'bad day');
      if (!Array.isArray(body.commands) || body.commands.length > 20000) {
        return sendError(res, 400, 'bad snapshot');
      }
      const sessions = await readJSON(sessionsFile, {});
      sessions[`${playerId}:${body.day}`] = {
        day: body.day,
        sessionId: String(body.sessionId ?? '').slice(0, 64),
        commands: body.commands.slice(0, 20000),
        finished: !!body.finished,
        savedAt: Date.now(),
      };
      await writeJSON(sessionsFile, sessions);
      return sendJSON(res, 200, { ok: true });
    }
  }

  // --- score submission with replay validation ------------------------------
  if (path === '/api/v1/score' && isPost) {
    if (!playerId) return sendError(res, 401, 'player id required');
    const body = await readBody(req);
    const { board, contentId, rulesetId, contentVersion, seed, result, envelope } = body ?? {};
    if (!BOARDS.has(board)) return sendError(res, 400, 'unknown board');
    if (contentVersion !== CONTENT_VERSION) return sendError(res, 409, 'stale content version');
    if (!result || !Number.isInteger(result.score) || result.score < 0 || result.score > 10_000_000) {
      return sendError(res, 400, 'implausible score');
    }
    if (!envelope || envelope.contentVersion !== CONTENT_VERSION) {
      return sendError(res, 422, 'replay envelope required');
    }
    if (board === 'daily' && contentId !== `daily-${envelope.level?.id?.replace('daily-', '')}`) {
      // contentId must match the envelope's level identity
      return sendError(res, 400, 'content id mismatch');
    }

    const check = verifyReplay(envelope, { levelResolver });
    if (!check.ok) return sendError(res, 422, 'replay validation failed: ' + check.error);
    if (!check.result) return sendError(res, 422, 'round not finished in replay');
    if (check.result.score !== result.score || check.result.status !== result.status) {
      return sendError(res, 422, 'score does not match replay');
    }

    const boards = await readJSON(boardsFile, { daily: [], journey: [], challenge: [] });
    const list = boards[board] ?? [];
    const sessionId = String(result.sessionId ?? envelope.sessionId ?? '').slice(0, 64);
    // Idempotent duplicate rejection: same session + board resolves to the
    // stored entry instead of a second insert.
    const existing = list.find((e) => e.sessionId === sessionId && e.playerId === playerId);
    if (existing) {
      return sendJSON(res, 200, { ok: true, duplicate: true, rank: rankOf(list, existing), entry: publicEntry(existing) });
    }
    const entry = {
      playerId,
      name: sanitizeName(body.name),
      sessionId,
      contentId: String(contentId ?? '').slice(0, 64),
      rulesetId: String(rulesetId ?? RULESET_STANDARD),
      contentVersion,
      seed: String(seed ?? '').slice(0, 128),
      status: result.status,
      score: result.score,
      components: result.components ?? {},
      moves: result.moves ?? 0,
      invalidCount: result.invalidCount ?? 0,
      elapsedMs: result.elapsedMs ?? 0,
      assists: { hintsUsed: result.hintsUsed ?? 0, undosUsed: result.undosUsed ?? 0 },
      at: Date.now(),
    };
    list.push(entry);
    list.sort((a, b) => compareResults(a, b));
    boards[board] = list.slice(0, 200);
    await writeJSON(boardsFile, boards);
    return sendJSON(res, 200, { ok: true, rank: rankOf(boards[board], entry), entry: publicEntry(entry) });
  }

  // --- leaderboards ---------------------------------------------------------
  if (path === '/api/v1/leaderboard' && req.method === 'GET') {
    const board = url.searchParams.get('board');
    if (!BOARDS.has(board)) return sendError(res, 400, 'unknown board');
    const friends = url.searchParams.get('friends') === '1';
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    const boards = await readJSON(boardsFile, { daily: [], journey: [], challenge: [] });
    let list = boards[board] ?? [];
    if (friends) {
      // No friend graph in the standalone server: the friends view scopes to
      // the requester's own entries (host shell merges real friends when hosted).
      list = list.filter((e) => e.playerId === playerId);
    }
    const entries = list.slice(0, limit).map((e, i) => ({ rank: i + 1, ...publicEntry(e) }));
    return sendJSON(res, 200, { entries, casual: false, total: list.length });
  }

  // --- achievements (idempotent, stable keys) --------------------------------
  if (path === '/api/v1/achievements') {
    if (!playerId) return sendError(res, 401, 'player id required');
    const all = await readJSON(achievementsFile, {});
    if (req.method === 'GET') {
      return sendJSON(res, 200, { achievements: all[playerId] ?? {} });
    }
    if (isPost) {
      const body = await readBody(req);
      const key = String(body.key ?? '');
      if (!ACHIEVEMENT_KEYS.has(key)) return sendError(res, 400, 'unknown achievement');
      const mine = all[playerId] ?? {};
      if (mine[key]) return sendJSON(res, 200, { ok: true, duplicate: true });
      mine[key] = { unlockedAt: Date.now() };
      all[playerId] = mine;
      await writeJSON(achievementsFile, all);
      return sendJSON(res, 200, { ok: true });
    }
  }

  // --- lifecycle sinks -------------------------------------------------------
  if (isPost && (path === '/api/v1/presence' || path === '/api/v1/activity' || path === '/api/v1/telemetry')) {
    await readBody(req).catch(() => {});
    res.writeHead(204, { 'cache-control': 'no-store' });
    return res.end();
  }

  return sendError(res, 404, 'not found');
}

function rankOf(sortedList, entry) {
  return sortedList.indexOf(entry) + 1;
}

function publicEntry(e) {
  return {
    name: e.name,
    contentId: e.contentId,
    status: e.status,
    score: e.score,
    moves: e.moves,
    invalidCount: e.invalidCount,
    elapsedMs: e.elapsedMs,
    assists: e.assists,
    at: e.at,
    sessionId: e.sessionId,
  };
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

function serveStatic(req, res, url) {
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(resolve(ROOT)) || file.includes(`${resolve(ROOT)}/data`)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  if (!existsSync(file) || !extname(file)) {
    res.writeHead(404);
    return res.end('not found');
  }
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const immutable = /vendor|assets/.test(file);
  res.writeHead(200, {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const playerId = String(req.headers['x-player-id'] ?? '').slice(0, 64) || null;
      const ip = req.socket.remoteAddress ?? 'unknown';
      return await handleApi(req, res, url, playerId, ip);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    return serveStatic(req, res, url);
  } catch (err) {
    sendError(res, err?.message === 'payload too large' ? 413 : 400, err?.message ?? 'bad request');
  }
});

server.listen(PORT, () => {
  console.log(`Trio Tiles server listening on http://localhost:${PORT}`);
});
