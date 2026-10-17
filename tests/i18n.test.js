// Every string key used in markup (data-i18n*) and code (t('…')) exists in all
// nine locales with the same {placeholders} as US English, and every content
// name (symbols, chapters, themes, difficulties, challenges, lessons, lesson
// steps, achievements) is translated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { STRINGS } from '../js/ui/strings.js';
import { SYMBOLS } from '../js/rules/layout.js';
import { JOURNEY_CHAPTERS, THEMES, PRACTICE_DIFFICULTIES, CHALLENGES, LESSONS, ACHIEVEMENTS } from '../js/rules/content.js';

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const root = new URL('../', import.meta.url);
function walk(dir) {
  return readdirSync(new URL(dir, root)).flatMap((f) => {
    const rel = dir + f;
    if (f === 'vendor') return [];
    return statSync(new URL(rel, root)).isDirectory() ? walk(rel + '/') : rel.endsWith('.js') && !rel.endsWith('strings.js') ? [rel] : [];
  });
}
const code = walk('js/').map((f) => readFileSync(new URL(f, root), 'utf8')).join('\n');
const html = readFileSync(new URL('index.html', root), 'utf8');
const used = new Set();
for (const m of code.matchAll(/\bt\('([A-Za-z0-9]+)'/g)) used.add(m[1]);
for (const m of code.matchAll(/(?:_caption|onCaption)\('([A-Za-z0-9]+)'/g)) used.add(m[1]);
for (const m of code.matchAll(/\? '(cap[A-Z]\w*)' : '(cap[A-Z]\w*)'/g)) { used.add(m[1]); used.add(m[2]); }
for (const m of html.matchAll(/data-i18n(?:-aria|-title)?="([A-Za-z0-9]+)"/g)) used.add(m[1]);
// Keys reached through lookup tables in main.js.
for (const m of code.matchAll(/:\s*'((?:end|rsn|name|col|lb)[A-Z]\w*)'/g)) used.add(m[1]);
const PLATFORM = new Set(['lbPosting', 'lbRank', 'lbPosted', 'lbNotPosted']);
for (const k of PLATFORM) used.delete(k);
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('ships the nine locales', () => assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort()));
test('every locale has exactly the US English keys', () => {
  const en = Object.keys(STRINGS['en-US']).sort();
  for (const loc of LOCALES) assert.deepEqual(Object.keys(STRINGS[loc]).sort(), en, loc);
});
// Keys built from string tables (['colPlayer', …].map(t)) count as used too.
for (const m of code.matchAll(/'([a-z][A-Za-z0-9]+)'/g)) if (m[1] in STRINGS['en-US'] && typeof STRINGS['en-US'][m[1]] === 'string' && /^(col|name|tiles|status)/.test(m[1])) used.add(m[1]);
test('found the keys in markup and code', () => assert.ok(used.size > 150, String(used.size)));
for (const loc of LOCALES) {
  test(`${loc}: every used key, matching placeholders`, () => {
    const L = STRINGS[loc];
    assert.deepEqual([...used].filter((k) => typeof L[k] !== 'string'), []);
    for (const k of used) assert.equal(vars(L[k]), vars(STRINGS['en-US'][k]), `${loc}.${k}`);
  });
  test(`${loc}: every content name`, () => {
    const L = STRINGS[loc];
    for (const s of SYMBOLS) assert.ok(L.symbols[s.id], `symbol ${s.id}`);
    for (const c of JOURNEY_CHAPTERS) assert.ok(L.chapters[c.id], `chapter ${c.id}`);
    for (const id of Object.keys(THEMES)) assert.ok(L.themes[id], `theme ${id}`);
    for (const d of PRACTICE_DIFFICULTIES) assert.ok(L.difficulties[d.id], `difficulty ${d.id}`);
    for (const c of CHALLENGES) assert.ok(L.challenges[c.id] && L.blurbs[c.id], `challenge ${c.id}`);
    for (const l of LESSONS) {
      assert.ok(L.lessons[l.id] && L.lessonText[l.id], `lesson ${l.id}`);
      for (const st of l.steps) assert.ok(L.lessonText[st.id], `step ${st.id}`);
    }
    for (const a of ACHIEVEMENTS) assert.equal(L.achievements[a.key]?.length, 2, `achievement ${a.key}`);
  });
}
test('English content strings match the authored data', () => {
  const en = STRINGS['en-US'];
  for (const s of SYMBOLS) assert.equal(en.symbols[s.id], s.name);
  for (const c of CHALLENGES) assert.equal(en.blurbs[c.id], c.blurb);
  for (const l of LESSONS) {
    assert.equal(en.lessonText[l.id], l.intro);
    for (const st of l.steps) assert.equal(en.lessonText[st.id], st.text);
  }
  for (const a of ACHIEVEMENTS) assert.deepEqual(en.achievements[a.key], [a.name, a.description]);
});
test('non-English locales are translated', () => {
  for (const loc of LOCALES.filter((l) => !l.startsWith('en'))) {
    const same = [...used].filter((k) => STRINGS[loc][k] === STRINGS['en-US'][k] && !/\{chapter\} \{n\}/.test(STRINGS[loc][k]));
    assert.ok(same.length < 12, `${loc}: ${same.join(', ')}`);
  }
});
