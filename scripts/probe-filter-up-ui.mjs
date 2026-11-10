/**
 * A FILTER TAPPED BRINGS ITS ROW UP (10 Nov) — "some filter cards do not scroll to view when tapped".
 *
 * On Stock and People the filter chips sit low, under a summary, tiles and a search box; tapping one
 * changed a list that was below the screen. Each check taps a chip and expects its row near the top
 * of the page, with the list under it on screen. Read-only.
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

/** Where the tapped chip's row sits, against the top of the page's scroller. */
const rowTop = (chip) =>
  p.evaluate((chip) => {
    const page = [...document.querySelectorAll('.group-stack-container[data-active="true"] .navstack-page')].pop();
    const el = [...page.querySelectorAll('[role="tab"]')].find((e) => e.textContent.trim() === chip);
    const row = el?.closest('[role="tablist"]')?.parentElement;
    const body = [...page.querySelectorAll('.navstack-column-body')].pop();
    if (!row || !body) return null;
    return {
      top: Math.round(row.getBoundingClientRect().top - body.getBoundingClientRect().top),
      // A list too short to scroll cannot bring its row up; its results are on screen already.
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
    ['Stock', null, 'Running low'],
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
    const before = await rowTop(chip);
    await p.getByRole('tab', { name: chip, exact: true }).locator('visible=true').first().tap();
    await p.waitForTimeout(2200);
    const after = await rowTop(chip);
    check(
      after !== null && (after.top <= 120 || after.atEnd),
      `${where ?? '  same page'}: tapping "${chip}" brings its row up (${before?.top}px -> ${after?.top}px from the top${after?.atEnd && after.top > 24 ? ', page at its end' : ''})`,
    );
  }
} catch (e) {
  check(false, `ran — ${e.message.split('\n')[0]}`);
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
