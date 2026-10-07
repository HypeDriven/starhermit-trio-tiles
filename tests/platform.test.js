// HostPlatform + canonical StarHermit SDK with a stubbed fetch and a fake
// launch fragment: token read, profile name, cloud save in game:<slug>,
// settings KV patch, control overrides — and zero fetches standalone.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HostPlatform } from '../js/platform/host.js';
import { SaveStore } from '../js/session/storage.js';

const SDK_SRC = fs.readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8');
function loadSdk() {
  const m = { exports: {} };
  new Function('module', 'exports', SDK_SRC)(m, m.exports);
  return m.exports;
}
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SLUG = 'trio-test';
const USER = 'abcdef12-3456-7890-abcd-ef1234567890';
const JWT = 'x.' + b64url({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.y';

function fakeWindow(hash) {
  return {
    location: { hash, search: '', pathname: '/', hostname: 'localhost', href: 'http://localhost/' + hash, origin: 'http://localhost' },
    history: { state: null, replaceState(_s, _t, url) { this.url = url; } },
  };
}
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
function stubServer() {
  const calls = [];
  const state = { save: null, settings: {} };
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, auth: init.headers?.Authorization });
    if (url === '/api/v1/time') return json({ epochMs: Date.now() });
    if (url === `/api/v1/users/${USER}/profile`) return json({ nickname: 'Tea Tamsin' });
    if (url.startsWith('/api/v1/me/cloud-saves/')) {
      if (method === 'PUT') {
        state.save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        return new Response(null, { status: 204 });
      }
      return state.save ? new Response(state.save) : new Response(null, { status: 404 });
    }
    if (url === `/api/v1/games/${SLUG}/settings`) {
      if (method === 'PATCH') Object.assign(state.settings, JSON.parse(init.body).settings);
      return json({ settings: state.settings });
    }
    if (url === `/api/v1/games/${SLUG}/controls`) return json({ actions: [{ action: 'undo', codes: ['KeyZ'] }] });
    return new Response(null, { status: 404 });
  };
  return { fetch, calls, state };
}
const noTimers = { setTimeout: () => 0, clearTimeout: () => {} };

test('hosted: token, profile, cloud save game:<slug>, settings, controls', async () => {
  const srv = stubServer();
  const win = fakeWindow('#game_token=' + JWT);
  const sh = loadSdk().create({ window: win, fetch: srv.fetch, ...noTimers });
  sh.init();
  assert.equal(sh.token, JWT);
  assert.equal(win.history.url, '/');
  const store = new SaveStore(memStorage());
  const host = new HostPlatform(store, sh);
  await host.init();
  assert.equal(host.scope.hosted, true);
  assert.equal(host.profileName(), 'Tea Tamsin');
  assert.ok(srv.calls.every((c) => c.auth === 'Bearer ' + JWT));

  store.doc.progression.roundsPlayed = 9;
  store.save(); // mirrored to the cloud slot (debounced; flush below)
  await host._flushCloudSave(true);
  const put = srv.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, '/api/v1/me/cloud-saves/' + encodeURIComponent('game:' + SLUG));
  const back = await sh.loadJSON();
  assert.equal(back.progression.roundsPlayed, 9);

  host.patchSettings({ music: 0.2 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(srv.state.settings, { music: 0.2 });
  assert.equal((await host.getSettings()).music, 0.2);
  assert.deepEqual(await host.loadBindings({ undo: ['KeyU'], hint: ['KeyH'] }), { undo: ['KeyZ'], hint: ['KeyH'] });
  assert.match(host.inviteLink(), new RegExp(`/game-invite/${USER}/${SLUG}$`));
});

test('renewal refused: adapter drops to local play', async () => {
  const srv = stubServer();
  const sh = loadSdk().create({ window: fakeWindow('#game_token=' + JWT), fetch: srv.fetch, ...noTimers });
  sh.init();
  const host = new HostPlatform(new SaveStore(memStorage()), sh);
  await host.init();
  let seen = null;
  host.onAuthChange = (v) => { seen = v; };
  sh.signOut('expired');
  assert.equal(seen, false);
  assert.equal(host.scope.hosted, false);
  assert.equal(host.inviteLink(), null);
});

test('standalone: no token means no fetch at all', async () => {
  const srv = stubServer();
  const sh = loadSdk().create({ window: fakeWindow(''), fetch: srv.fetch });
  sh.init();
  const store = new SaveStore(memStorage());
  const host = new HostPlatform(store, sh);
  await host.init();
  store.save();
  await host._flushCloudSave(true);
  host.patchSettings({ music: 0.1 });
  assert.deepEqual(await host.getSettings(), {});
  await host.leaderboard('daily');
  await host.loadBindings({ undo: ['KeyU'] });
  assert.equal(host.canSignIn(), false);
  assert.deepEqual(await host.submitScore(800), { posted: false, rank: null });
  assert.equal(srv.calls.length, 0);
});

test('hosted: submitScore posts high-score and reads the rank', async () => {
  const srv = stubServer();
  const sh = loadSdk().create({ window: fakeWindow('#game_token=' + JWT), fetch: srv.fetch, ...noTimers });
  sh.init();
  const host = new HostPlatform(new SaveStore(memStorage()), sh);
  const sent = [];
  sh.submitScores = async (sc) => { sent.push(sc); return Object.keys(sc); };
  sh.leaderboard = async (key) => ({ items: key === 'high-score' ? [{ userId: USER, rank: 9 }] : [] });
  assert.deepEqual(await host.submitScore(1777.5), { posted: true, rank: 9 });
  assert.deepEqual(sent, [{ 'high-score': 1778 }]);
  sh.submitScores = async () => [];
  assert.deepEqual(await host.submitScore(3), { posted: false, rank: null });
});

test('leaderboard line strings in every locale', async () => {
  const { PLATFORM_STRINGS, platformStrings } = await import('../js/ui/platform-strings.js');
  assert.equal(Object.keys(PLATFORM_STRINGS).length, 9);
  for (const l of Object.keys(PLATFORM_STRINGS)) {
    for (const k of ['lbPosting', 'lbRank', 'lbPosted', 'lbNotPosted']) assert.ok(PLATFORM_STRINGS[l][k], l + ' ' + k);
    assert.match(platformStrings(l)('lbRank', { rank: 4 }), /#4/, l);
  }
});
