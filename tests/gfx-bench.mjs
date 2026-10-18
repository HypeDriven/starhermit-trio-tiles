// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts Expert practice (54 tiles over 5 layers) and keeps moving exposed tiles into the tray through
// the real board-mirror buttons — preferring the symbol already waiting in the tray so triples clear —
// so tile flights, clear bursts, petals, mist and teapot steam all animate. A finished round is retried.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

const visible = (page, name) => page.evaluate((n) => {
  const s = document.querySelector(`.screen[data-screen="${n}"]`);
  return !!s && !s.hidden;
}, name);

export async function setPreset(page, preset) {
  await page.waitForFunction(() => {
    const s = document.querySelector('.screen[data-screen="title"]');
    return !!s && !s.hidden;
  }, null, { timeout: 20000 });
  await page.click('#btn-title-settings');
  await page.waitForFunction(() => !document.getElementById('overlay-pause').hidden, null, { timeout: 8000 });
  await page.locator('#gfx-preset').scrollIntoViewIfNeeded();
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.locator('#btn-resume').scrollIntoViewIfNeeded();
  await page.click('#btn-resume');
  await page.waitForFunction(() => document.getElementById('overlay-pause').hidden, null, { timeout: 8000 });
}

// Pick the mirror button for the symbol with the most exposed copies, favouring symbols in the tray.
const pick = (page) => page.evaluate(() => {
  const btns = [...document.querySelectorAll('#mirror-list .btn')].filter((b) => !b.disabled);
  if (!btns.length) return false;
  const tray = (document.getElementById('tray-gauge')?.getAttribute('aria-label') || '').toLowerCase();
  const count = {};
  for (const b of btns) { const k = b.textContent.trim(); count[k] = (count[k] || 0) + 1; }
  const score = (k) => count[k] + (tray.includes(k.toLowerCase()) ? 3 : 0);
  const best = btns.reduce((a, b) => (score(b.textContent.trim()) > score(a.textContent.trim()) ? b : a));
  best.click();
  return true;
});

export async function start(page) {
  await page.click('#btn-play');
  await page.waitForFunction(() => !document.querySelector('.screen[data-screen="modes"]').hidden);
  await page.locator('#mode-cards .card[data-mode="practice"]').click();
  await page.waitForFunction(() => !document.querySelector('.screen[data-screen="setup"]').hidden);
  await page.locator('#setup-list .setup-item:not(:disabled)').last().click();
  await page.waitForFunction(() => !document.querySelector('.screen[data-screen="play"]').hidden, null, { timeout: 15000 });
  await page.locator('#board-mirror summary').click();
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try {
        if (await visible(page, 'results')) {
          await page.click('#btn-results-retry', { timeout: 3000 });
          await page.waitForFunction(() => !document.querySelector('.screen[data-screen="play"]').hidden, null, { timeout: 15000 });
          if (!(await page.evaluate(() => document.getElementById('board-mirror').open))) await page.locator('#board-mirror summary').click();
        } else if (await visible(page, 'play')) {
          await pick(page);
        }
      } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error('hook:', e.message.split('\n')[0]); }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  await page.waitForTimeout(1500);
}
