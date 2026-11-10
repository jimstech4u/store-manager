/**
 * A FILTER TAPPED BRINGS ITS RESULTS INTO VIEW (10 Nov) — and only that far.
 *
 * "Some filter cards do not scroll to view when tapped": on Stock and People the chips sit low, under
 * a summary, tiles and a search box; tapping one changed a list below the screen. Then the fix went
 * too far: the chips are in a PINNED bar, which a glide can never put at the top, so it ran to the end
 * of the page, the list paged on and on, and the first results scrolled away above the bar.
 *
 * Each check taps a chip and expects, once the page settles:
 *   - the START of the results on screen, just under the filter row — not scrolled away above it;
 *   - no pages loaded by the tap itself beyond what the filter's first answer holds.
 * Read-only.
 *
 *     node scripts/probe-filter-up-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

let failed = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const tab = (name) =>
  p.evaluate((name) => [...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === name)?.click(), name);

/**
 * Where the filter row is, where the results begin, and how long the list is — measured against the
 * page's scroller.
 */
const measure = (chip) =>
  p.evaluate((chip) => {
    const page = [...document.querySelectorAll('.group-stack-container[data-active="true"] .navstack-page')].pop();
    const el = [...page.querySelectorAll('[role="tab"]')].find((e) => e.textContent.trim() === chip);
    const row = el?.closest('[role="tablist"]')?.parentElement;
    const body = [...page.querySelectorAll('.navstack-column-body')].pop();
    if (!row || !body) return null;
    let pinned = row;
    while (pinned && pinned !== body && getComputedStyle(pinned).position !== 'sticky') pinned = pinned.parentElement;
    const bar = pinned && pinned !== body ? pinned : row;
    let results = bar.nextElementSibling;
    while (results && results.offsetHeight === 0) results = results.nextElementSibling;
    const b = body.getBoundingClientRect();
    return {
      rowBottom: Math.round(bar.getBoundingClientRect().bottom - b.top),
      resultsTop: results ? Math.round(results.getBoundingClientRect().top - b.top) : null,
      viewport: Math.round(body.clientHeight),
      items: page.querySelectorAll('li').length,
      atEnd: body.scrollTop >= body.scrollHeight - body.clientHeight - 2,
    };
  }, chip);

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(7000);

  for (const [where, open, chip] of [
    ['Stock', null, 'None left'],
    [null, null, 'Running low'],
    [null, null, 'Everything'],
    ['More', /everyone you sell to/i, 'Owes you'],
    [null, null, 'You owe them'],
  ]) {
    // null: stay on the page — tapping the tab you are on goes back to its first page.
    if (where) {
      await tab(where);
      await p.waitForTimeout(3000);
    }
    if (open) {
      await p.getByRole('button', { name: open }).locator('visible=true').first().evaluate((el) => el.click());
      await p.waitForTimeout(4000);
    }
    await p.getByRole('tab', { name: chip, exact: true }).locator('visible=true').first().tap();
    await p.waitForTimeout(1200);
    const settled = await measure(chip);
    await p.waitForTimeout(2500);
    const later = await measure(chip);
    const ok =
      later !== null &&
      later.resultsTop !== null &&
      // The start of the results is on screen, under the filter row — not scrolled away above it.
      later.resultsTop >= later.rowBottom - 4 &&
      later.resultsTop < later.viewport - 40;
    check(ok, `${where ?? '  same page'}: "${chip}" shows the start of its results under the filters (${JSON.stringify(later)})`);
    check(
      later !== null && settled !== null && later.items <= settled.items + 1,
      `${where ?? '  same page'}: and the tap did not page the list on (${settled?.items} -> ${later?.items} rows)`,
    );
  }
} catch (e) {
  check(false, `ran — ${e.message.split('\n')[0]}`);
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
