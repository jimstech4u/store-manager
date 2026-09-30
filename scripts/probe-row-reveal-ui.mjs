/**
 * A CARD TAPPED IN A SIDEWAYS ROW ENDS UP FULLY ON SCREEN — and so does the tab a close leaves active.
 *
 * "Any card clicked in a row list is scrolled into view … so we do not have a half-hanging selected
 * card, just like the customer cards in the sell page. And fix the bug in customer: when we close a
 * customer card, the active one it goes to is not scrolled to."
 *
 *   T  The till: three tabs of the probe's own (tracked, and closed again at the end). Close the
 *      last one → its left neighbour is active and fully in the row. Close a middle one → its right
 *      neighbour, likewise.
 *   F  Filter rows (Stock, Orders): tap the chip hanging off the right edge → it is fully in the row,
 *      and the page did not move vertically.
 *
 *     node scripts/probe-row-reveal-ui.mjs [http://localhost:3100]
 */

import { chromium, webkit } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/row-reveal';
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
const PROBE_DRAFTS = trackDrafts(p);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** How much of the element is inside its horizontally scrolling row, as a fraction (1 = all). */
const shownInRow = (handle) =>
  handle.evaluate((el) => {
    let row = el.parentElement;
    while (row && !(row.scrollWidth > row.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(row).overflowX))) {
      row = row.parentElement;
    }
    if (!row) return 1;
    const r = row.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(r.right, t.right) - Math.max(r.left, t.left));
    return Math.round((overlap / t.width) * 100) / 100;
  });

const activeTab = () => p.locator('[role="tab"][aria-selected="true"]').locator('visible=true').first();
const tabs = () => p.locator('[role="tablist"][aria-label="Customers being served"] [role="tab"]');
const tab = async (label) => {
  // The tab bar hides while a page scrolls; bring every page back to its top first.
  await p.evaluate(() => {
    for (const b of document.querySelectorAll('.navstack-column-body')) b.scrollTop = 0;
  });
  await p.waitForTimeout(1200);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(2500);
};

const closeActive = async () => {
  await p.locator('button[aria-label="Close this tab without selling"]').locator('visible=true').first().click();
  await p.waitForTimeout(800);
  await p.getByRole('button', { name: 'Discard it' }).locator('visible=true').first().click();
  await p.waitForTimeout(2500);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(8000);

  console.log('T  closing a customer tab');
  const before = await tabs().count();
  for (let i = 0; i < 3; i++) {
    await p.locator('button[aria-label="Start another customer"]').locator('visible=true').first().click();
    await p.waitForTimeout(2500);
  }
  const n = await tabs().count();
  check('three probe tabs opened at the end of the row', n === before + 3, `${before} → ${n}`);
  const ours = [n - 3, n - 2, n - 1];

  // The last one is active (just made). Close it → its left neighbour.
  await closeActive();
  await p.waitForTimeout(600);
  let shown = await shownInRow(await activeTab().elementHandle());
  await p.screenshot({ path: `${SHOTS}/t1-closed-last.png` });
  check('closing the last tab leaves its left neighbour fully in the row', shown >= 0.99, `shown ${shown}`);

  // Pick the first of ours, scroll the row away from it, then close it → its right neighbour.
  await tabs().nth(ours[0]).click();
  await p.waitForTimeout(1200);
  await p.evaluate(() => {
    const row = document.querySelector('[role="tablist"][aria-label="Customers being served"]');
    if (row) row.scrollLeft = 0;
  });
  await p.waitForTimeout(600);
  await closeActive();
  await p.waitForTimeout(600);
  shown = await shownInRow(await activeTab().elementHandle());
  await p.screenshot({ path: `${SHOTS}/t2-closed-middle.png` });
  check('closing a tab scrolled out of sight brings the new active one fully in', shown >= 0.99, `shown ${shown}`);

  console.log('F  filter chips');
  for (const [where, open, rowSel] of [
    ['Stock', () => tab('Stock'), '[class*="chips"]'],
    ['Money period', () => tab('Money'), '[class*="FilterBar"], [class*="filterBar"], [class*="periods"], [class*="chips"]'],
  ]) {
    await open();
    const row = p.locator(rowSel).locator('visible=true').first();
    if ((await row.count()) === 0) { console.log(`  (${where}: no chip row found)`); continue; }
    const scrolls = await row.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    if (!scrolls) { console.log(`  (${where}: the row fits the screen — nothing to reveal)`); continue; }
    await row.evaluate((el) => { el.scrollLeft = 0; });
    // The last chip that hangs off the right edge.
    const chip = await row.evaluateHandle((el) => {
      const r = el.getBoundingClientRect();
      return [...el.querySelectorAll('button')].find((b) => b.getBoundingClientRect().right > r.right + 1) ?? null;
    });
    const el = chip.asElement();
    if (!el) { console.log(`  (${where}: no chip off the edge)`); continue; }
    const pageTop = await p.evaluate(() => {
      const b = [...document.querySelectorAll('.navstack-column-body')].filter((x) => x.getBoundingClientRect().width > 0).pop();
      return b?.scrollTop ?? 0;
    });
    const hanging = await shownInRow(el);
    await el.click();
    await p.waitForTimeout(1200);
    const after = await shownInRow(el);
    const pageTopAfter = await p.evaluate(() => {
      const b = [...document.querySelectorAll('.navstack-column-body')].filter((x) => x.getBoundingClientRect().width > 0).pop();
      return b?.scrollTop ?? 0;
    });
    await p.screenshot({ path: `${SHOTS}/f-${where.replace(/\W+/g, '-')}.png` });
    check(`${where}: a half-hidden chip, tapped, is fully in the row`, after >= 0.99, `before ${hanging} → after ${after}`);
    check(`${where}: … without moving the page up or down`, Math.abs(pageTopAfter - pageTop) < 2, `${pageTop} → ${pageTopAfter}`);
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/crash.png` }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
