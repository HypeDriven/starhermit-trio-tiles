// Plays the web package in Chrome on the machine's GPU (~/games/tools/gpu-chrome.mjs), the loader index.html that
// `npm run package` writes, at a desktop viewport, a DPR-3 phone and a DPR-3 phone sideways: on the desktop Journey
// stage 1 cleared by clicks on the tiles on the table (their named areas, in the solver's order), the results, the
// pause overlay by Escape and Help; on the phone Lesson 1 by touches on the board mirror's buttons; sideways a
// Practice table with a tap, Undo, and leaving the round. Widgets are found through the page's accessibility mirror
// of the engine's UI. Fails on console errors or warnings, the runtime's error screen, or a view that does not
// finish. Screenshots go to --shots.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();
const C = await import('../js/rules/content.js');
const { winLine } = await import('./gen-plays.mjs');
const { Session } = await import('../js/session/session.js');
const { legalActions } = await import('../js/rules/engine.js');
const { STRINGS } = await import('../js/ui/strings.js');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views.filter((x) => !process.env.VIEWS || process.env.VIEWS.split(',').includes(x.name))) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true })).or(page.getByText(name, { exact: true })).first();
  /** A tap / click at window coordinates (CSS px). */
  const tapAt = async (x, y) => {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  /** A press on a widget (or a table target): the mouse on the desktop, a finger on the phones. */
  const press = async (name) => {
    const el = find(name);
    await el.waitFor({ timeout: 15000 });
    const b = await el.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  let reached = false;
  const targetsOf = (state) => {
    const byId = new Map(state.tiles.map((t) => [t.id, t]));
    return legalActions(state).selectable.map((id) => byId.get(id)).sort((a, b) => b.z - a.z || a.gy - b.gy || a.gx - b.gx);
  };
  const NAMES = STRINGS['en-US'].symbols;
  try {
    await shot('title');
    if (v.name === 'desktop') {
      await press('Play');
      await press('Journey');
      await press('First Steeps 1, 12 tiles');
      await find('Pause').waitFor({ timeout: 60000 });
      await page.waitForTimeout(3000);
      await shot('stage-1');
      const level = C.materializeLevel(C.JOURNEY[0]);
      const sess = new Session(level);
      for (const [n, id] of winLine(level).entries()) {
        const list = targetsOf(sess.state);
        const k = list.findIndex((t) => t.id === id);
        await press(`${NAMES[list[k].sym]} tile, layer ${list[k].z + 1}, ${k + 1} of ${list.length}. Enter to pick.`);
        await page.waitForTimeout(350);
        if (n === 4) await shot('stage-1-tray');
        sess.submit({ type: 'select', tileId: id });
      }
      await page.getByText('Table cleared', { exact: true }).first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(800);
      await shot('stage-1-results');
      await press('Next stage');
      await find('Pause').waitFor({ timeout: 60000 });
      await page.waitForTimeout(1500);
      await page.keyboard.press('Escape');
      await find('Resume').waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      await shot('pause');
      await press('Help');
      await page.waitForTimeout(800);
      await shot('help');
    } else if (v.name === 'phone') {
      await press('Play');
      await press('Learn');
      await press('Picking Tiles, 4 steps');
      await find('Pause').waitFor({ timeout: 60000 });
      await page.waitForTimeout(2000);
      await shot('learn');
      await press('Board mirror — available tiles (keyboard friendly)');
      await page.waitForTimeout(500);
      await shot('learn-mirror');
      for (let n = 3; n >= 1; n--) { await press(`Tea Leaf tile, available, 1 of ${n}`); await page.waitForTimeout(500); }
      await page.getByText('Table cleared', { exact: true }).first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(800);
      await shot('learn-results');
    } else {
      await press('Play');
      await press('Practice');
      await press('Easy, 18 tiles · 2 layers');
      await find('Pause').waitFor({ timeout: 60000 });
      await page.waitForTimeout(2000);
      await shot('practice');
      await page.getByText(/ tile, layer \d+, 1 of \d+\. Enter to pick\./).first().waitFor({ timeout: 15000 });
      const el = page.getByText(/ tile, layer \d+, 1 of \d+\. Enter to pick\./).first();
      const bb = await el.boundingBox();
      await tapAt(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await page.waitForTimeout(600);
      await shot('practice-picked');
      await press('Undo');
      await page.waitForTimeout(600);
      await press('Pause');
      await press('Leave round');
      await page.getByText('Round over', { exact: true }).first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(600);
      await shot('practice-results');
    }
    reached = true;
  } catch (e) { problems.push(`play: ${String(e.message || e).split('\n')[0]}`); await shot('failed'); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} played=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
