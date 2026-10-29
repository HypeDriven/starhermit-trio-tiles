// Native client checks on the StarHermit engine: the TypeScript type check,
// `starhermit check .` (any warning fails), then every tests/native/*.play
// script plus today's Daily Steep (generated here: the table follows the UTC
// date) as signed-out offscreen runs (--render-check) driving the real UI, and
// that the committed web index (starhermit-files.json) matches the files.
// STARHERMIT names the runtime (default: the published 1.23.0 Linux runtime);
// TSC the TypeScript compiler (default ~/sh/runtime/ts).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dailyScript } from '../tools/gen-plays.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fallback = join(homedir(), 'sh/runtime/1.23.0/starhermit-1.23.0-linux-x86_64/starhermit');
const exe = process.env.STARHERMIT || (existsSync(fallback) ? fallback : null);
const tsc = process.env.TSC || join(homedir(), 'sh/runtime/ts/node_modules/.bin/tsc');
let failed = 0;
const fail = (name, e) => { failed++; console.log(`not ok - ${name}\n${String(e.stderr || e.stdout || e.message || e).trim().slice(-3000)}`); };

const { files: index, excluded = [] } = JSON.parse(readFileSync(join(root, 'starhermit-files.json'), 'utf8'));
const left = (f) => excluded.some((e) => (e.endsWith('/') ? f.startsWith(e) : f === e));
const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--deduplicate'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => f && f !== 'starhermit-files.json' && !left(f) && !f.split('/').some((p) => p.startsWith('.')) && existsSync(join(root, f)));
const stale = tracked.filter((f) => {
  const data = readFileSync(join(root, f));
  return !index[f] || index[f].sha256 !== createHash('sha256').update(data).digest('hex');
}).concat(Object.keys(index).filter((f) => !tracked.includes(f)));
if (stale.length) fail('web index is up to date', `stale (run npm run package): ${stale.join(', ')}`);
else console.log('ok - web index matches the files');

if (existsSync(tsc)) {
  try { execFileSync(tsc, ['-p', '.'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); console.log('ok - tsc'); }
  catch (e) { fail('tsc', e); }
} else console.log('SKIP tsc: set TSC to a TypeScript 5 compiler');
if (!exe) { console.log('SKIP engine checks: set STARHERMIT to the engine runtime'); process.exit(failed ? 1 : 0); }
try {
  const out = execFileSync(exe, ['check', '.', '--quiet'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const warnings = out.split('\n').filter((l) => /^warning/i.test(l));
  if (warnings.length) fail('starhermit check', warnings.join('\n'));
  else console.log('ok - starhermit check');
} catch (e) { fail('starhermit check', e); }
const only = process.argv.slice(2);
const scripts = readdirSync(join(root, 'tests', 'native')).filter((n) => n.endsWith('.play')).sort().map((n) => `tests/native/${n}`);
// today's Daily: a git-ignored script inside the game folder (--script takes a path relative to it)
mkdirSync(join(root, 'test-results'), { recursive: true });
writeFileSync(join(root, 'test-results', 'daily.play'), dailyScript());
scripts.push('test-results/daily.play');
const shots = join(tmpdir(), 'trio-tiles-native');
mkdirSync(shots, { recursive: true });
for (const f of scripts.filter((n) => !only.length || only.some((o) => n.includes(o)))) {
  try {
    execFileSync(exe, ['.', '--render-check', '--guest', '--script', f], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, STARHERMIT_RENDER_CHECK_PNG: process.env.STARHERMIT_RENDER_CHECK_PNG || shots } });
    console.log(`ok - ${f}`);
  } catch (e) { fail(f, e); }
}
console.log(failed ? `NATIVE FAIL — ${failed} failed` : 'NATIVE PASS');
process.exit(failed ? 1 : 0);
