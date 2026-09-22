/**
 * Coming back to a page you scrolled lands where you left it.
 *
 * «i went to a page, scrolled, changed group and then came back, it starts from top»
 *
 * A tab switch unmounts the stack that leaves and rebuilds it on the way back, so this only holds
 * if an entry keeps its identity across that (navigation-stack 0.19.1 — the scroll position is kept
 * per entry). It is the difference between an app and a website, and it broke without a single
 * error anywhere.
 *
 *     node scripts/probe-scroll-restores.mjs [http://localhost:3101]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
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
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

/** Where the page on top is scrolled to. */
const scrollTop = () =>
  p.evaluate(() => {
    const bodies = [...document.querySelectorAll('.navstack-column-body, .navstack-page')].filter(
      (el) => el.scrollHeight > el.clientHeight + 40 && el.offsetParent !== null,
    );
    const el = bodies[bodies.length - 1];
    return el ? Math.round(el.scrollTop) : -1;
  });

const tab = async (label) => {
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(2500);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(15000);

  // A long list: the stock screen, which a shop scrolls all day.
  await tab('Stock');
  await p.waitForTimeout(4000);
  await p.evaluate(() => {
    const bodies = [...document.querySelectorAll('.navstack-column-body, .navstack-page')].filter(
      (el) => el.scrollHeight > el.clientHeight + 40 && el.offsetParent !== null,
    );
    const el = bodies[bodies.length - 1];
    if (el) el.scrollTop = 600;
  });
  await p.waitForTimeout(1500);
  const left = await scrollTop();
  check('the stock list scrolls', left > 100, `at ${left}px`);

  // ── The report: change tab, come back ─────────────────────────────────────────────
  await tab('Money');
  await tab('Stock');
  await p.waitForTimeout(3500);
  const back = await scrollTop();
  check('coming back lands where it was left', Math.abs(back - left) <= 60, `left at ${left}px, came back to ${back}px`);

  // ── And again, to be sure it is not a one-off ─────────────────────────────────────
  await tab('More');
  await tab('Stock');
  await p.waitForTimeout(3500);
  const again = await scrollTop();
  check('and again after a second tab', Math.abs(again - left) <= 60, `came back to ${again}px`);

  /*
   * A pushed page (an item, a receipt) keeps its own place by the same rule — same uid, same
   * saved position. Not walked here: driving a row tap on a list that has just been scrolled is
   * flaky in a probe, and it is the same mechanism this already proves.
   */
} catch (e) {
  console.log('STOPPED:', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
