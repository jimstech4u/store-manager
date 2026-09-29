/**
 * BACK ON THE STOCK TAB STAYS ON THE STOCK TAB — and never empties a stack.
 *
 * "why am I pressing back in the second page of the Stock stack and I get to the Sell page, in the
 * PWA ... and sometimes the stack is blank."
 *
 * Tries it the ways a shop does: straight, after a reload mid-stack (the stack comes back from
 * session storage, the browser's entries do not), and at the root.
 *
 *     node scripts/probe-stock-back-ui.mjs [http://localhost:3100]
 */

import { chromium, webkit } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/stock-back';
mkdirSync(SHOTS, { recursive: true });

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

const browser = await (process.env.ENGINE === 'webkit' ? webkit : chromium).launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

/** Which tab is lit, and what the visible page's title is. */
const where = () =>
  p.evaluate(() => {
    // The group in the address is the tab being shown.
    const g = new URLSearchParams(location.search).get('group') ?? '';
    const tab = g.startsWith('stock') ? 'Stock' : g.startsWith('sell') ? 'Sell' : g || '(none)';
    const col = [...document.querySelectorAll('.navstack-column-body')].find(
      (el) => el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().width > 0,
    );
    const h1 = col?.closest('[class*="column"]')?.querySelector('h1')?.textContent?.trim()
      ?? [...document.querySelectorAll('h1')].find((h) => h.getBoundingClientRect().width > 0)?.textContent?.trim()
      ?? '?';
    const blank = !col || (col.textContent ?? '').trim().length === 0;
    return { tab, h1, blank, url: location.pathname + location.search };
  });

const headerBack = async () => {
  const b = p.locator('button[aria-label*="back" i]').locator('visible=true').first();
  if (await b.count()) await b.click();
  await p.waitForTimeout(3000);
};

const openAProduct = async () => {
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(4000);
  const item = p.getByText(/Goldberg Bottle|Chivita Active|Coca-Cola/).locator('visible=true').first();
  await item.waitFor({ state: 'visible', timeout: 60000 });
  await item.click();
  await p.waitForTimeout(5000);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  console.log('\n— straight: Stock → item → Back —');
  await openAProduct();
  console.log('   on the item:', JSON.stringify(await where()));
  await headerBack();
  let w = await where();
  console.log('   after Back: ', JSON.stringify(w));
  await p.screenshot({ path: `${SHOTS}/1-straight.png` });
  check('header Back stays on Stock', w.tab === 'Stock', w.tab);

  console.log('\n— after a reload mid-stack —');
  await openAProduct();
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(10000);
  console.log('   reloaded on:', JSON.stringify(await where()));
  await headerBack();
  w = await where();
  console.log('   after Back: ', JSON.stringify(w));
  await p.screenshot({ path: `${SHOTS}/2-after-reload.png` });
  check('header Back after a reload stays on Stock', w.tab === 'Stock', w.tab);
  check('and the stack is not blank', !w.blank);

  console.log('\n— browser Back after a reload —');
  await openAProduct();
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(10000);
  await p.goBack().catch(() => {});
  await p.waitForTimeout(4000);
  w = await where();
  console.log('   after browser Back:', JSON.stringify(w));
  await p.screenshot({ path: `${SHOTS}/3-browser-back.png` });
  check('browser Back after a reload stays on Stock', w.tab === 'Stock', w.tab);
  check('and the stack is not blank', !w.blank);

  console.log('\n— a cold start, like opening the PWA: one history entry, stacks from storage —');
  await openAProduct();
  // Leave Stock two pages deep and go to Sell, so the relaunch opens on Sell — the shop's case.
  await p.locator('.nav-item').filter({ hasText: /^Sell$/ }).first().click();
  await p.waitForTimeout(3000);
  // Same login and the same sessionStorage (where the stacks live), but a fresh history: exactly
  // what a PWA relaunch looks like on a phone.
  const session = await p.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))));
  const state = await p.context().storageState();
  await p.close();
  const ctx2 = await browser.newContext({ storageState: state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx2.addInitScript((ss) => {
    if (sessionStorage.getItem('__probe_seeded')) return;
    for (const [k, v] of Object.entries(JSON.parse(ss))) sessionStorage.setItem(k, v);
    sessionStorage.setItem('__probe_seeded', '1');
  }, session);
  const q = await ctx2.newPage();
  q.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  await q.goto(`${BASE}/main`, { waitUntil: 'networkidle' });
  await q.waitForTimeout(10000);
  const whereCold = () =>
    q.evaluate(() => {
      const g = new URLSearchParams(location.search).get('group') ?? '';
      const h1 = [...document.querySelectorAll('h1')].find((h) => h.getBoundingClientRect().width > 0)?.textContent?.trim() ?? '?';
      return { g, h1, len: history.length };
    });
  console.log('   launched on:', JSON.stringify(await whereCold()));
  await q.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await q.waitForTimeout(4000);
  let c = await whereCold();
  console.log('   Stock tab:  ', JSON.stringify(c));
  const deep = c.h1 !== 'Stock';
  check('switching to Stock restores it two pages deep', deep, c.h1);
  const b = q.locator('button[aria-label*="back" i]').locator('visible=true').first();
  if (!deep) {
    const item = q.getByText(/Goldberg Bottle|Chivita Active|Coca-Cola/).locator('visible=true').first();
    await item.click();
    await q.waitForTimeout(5000);
  }
  if (await b.count()) await b.click();
  await q.waitForTimeout(4000);
  c = await whereCold();
  console.log('   after Back: ', JSON.stringify(c));
  await q.screenshot({ path: `${SHOTS}/4-cold-start.png` });
  check('after a cold start, Back on Stock stays on Stock', c.g.startsWith('stock'), c.g);
  check('and shows the Stock list', c.h1 === 'Stock', c.h1);
  if (await b.count()) await b.click().catch(() => {});
  await q.waitForTimeout(3000);
  c = await whereCold();
  console.log('   Back again at the root:', JSON.stringify(c));
  check('Back at the root never blanks the tab', c.h1 !== '?' && c.h1 !== '', c.h1);

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  console.log(`\n  shots in ${SHOTS}`);
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
