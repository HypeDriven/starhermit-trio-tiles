// Every string key the engine client uses (native/*.ts T("…")) exists in all
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
import { ENGINE_STRINGS } from '../js/ui/engine-strings.js';
const root = new URL('../', import.meta.url);
const code = readdirSync(new URL('native/', root)).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(new URL('native/' + f, root), 'utf8')).join('\n');
const used = new Set();
for (const m of code.matchAll(/\bT\("([A-Za-z0-9]+)"/g)) used.add(m[1]);
// Keys reached through lookup tables and the sound captions.
for (const m of code.matchAll(/"((?:end|rsn|name|col|cap|sync|score|tiles|status)[A-Z]\w*)"/g)) if (m[1] in STRINGS['en-US'] || m[1] in ENGINE_STRINGS['en-US']) used.add(m[1]);
const ALL = Object.fromEntries(Object.keys(STRINGS).map((l) => [l, { ...STRINGS[l], ...ENGINE_STRINGS[l] }]));
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('ships the nine locales', () => assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort()));
test('every locale has exactly the US English keys', () => {
  const en = Object.keys(STRINGS['en-US']).sort();
  for (const loc of LOCALES) assert.deepEqual(Object.keys(STRINGS[loc]).sort(), en, loc);
});
// Keys built from string tables (['colPlayer', …].map(t)) count as used too.
test('engine strings ship the nine locales with the same keys', () => {
  const en = Object.keys(ENGINE_STRINGS['en-US']).sort();
  for (const loc of LOCALES) assert.deepEqual(Object.keys(ENGINE_STRINGS[loc]).sort(), en, loc);
});
test('found the keys in code', () => assert.ok(used.size > 150, String(used.size)));
for (const loc of LOCALES) {
  test(`${loc}: every used key, matching placeholders`, () => {
    const L = ALL[loc];
    assert.deepEqual([...used].filter((k) => typeof L[k] !== 'string'), []);
    for (const k of used) assert.equal(vars(L[k]), vars(ALL['en-US'][k]), `${loc}.${k}`);
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
    const same = [...used].filter((k) => ALL[loc][k] === ALL['en-US'][k] && !/\{chapter\} \{n\}/.test(STRINGS[loc][k]));
    assert.ok(same.length < 12, `${loc}: ${same.join(', ')}`);
  }
});
