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

  console.log('F  every sideways row on the list pages');
  /** Tap, in every visible sideways row of the page on screen, a card hanging off its right edge. */
  const tapHangingCards = async (where) => {
    const rows = await p.evaluate(() => {
      const active = document.querySelector('.group-stack-container[data-active="true"]');
      const pages = [...(active?.querySelectorAll('.navstack-page') ?? [])];
      const page = pages[pages.length - 1] ?? active;
      const found = [];
      for (const el of page?.querySelectorAll('*') ?? []) {
        const cs = getComputedStyle(el);
        if (!/(auto|scroll)/.test(cs.overflowX) || el.scrollWidth <= el.clientWidth + 1) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > innerHeight) continue;
        if (el.closest('[data-no-reveal]')) continue;
        el.scrollLeft = 0;
        el.setAttribute('data-probe-row', String(found.length));
        found.push(el.getAttribute('aria-label') || el.className.split(' ')[0] || el.tagName);
      }
      return found;
    });
    if (rows.length === 0) { console.log(`  (${where}: no sideways row to try)`); return; }
    for (let i = 0; i < rows.length; i++) {
      const row = p.locator(`[data-probe-row="${i}"]`);
      const card = await row.evaluateHandle((el) => {
        const r = el.getBoundingClientRect();
        return [...el.querySelectorAll('button, [role="tab"], a[href], label')].find((b) => {
          const c = b.getBoundingClientRect();
          return c.left < r.right - 1 && c.right > r.right + 1;   // partly on, partly off
        }) ?? null;
      });
      const el = card.asElement();
      if (!el) { console.log(`  (${where} ${rows[i]}: nothing hanging off the edge)`); continue; }
      const topBefore = await p.evaluate(() => [...document.querySelectorAll('.navstack-column-body')].filter((x) => x.getBoundingClientRect().width > 0).pop()?.scrollTop ?? 0);
      const before = await shownInRow(el);
      await el.click();
      await p.waitForTimeout(1200);
      const after = await shownInRow(el);
      const topAfter = await p.evaluate(() => [...document.querySelectorAll('.navstack-column-body')].filter((x) => x.getBoundingClientRect().width > 0).pop()?.scrollTop ?? 0);
      check(`${where} · ${rows[i]}: a half-hidden card, tapped, is fully in the row`, after >= 0.99, `${before} → ${after}`);
      check(`${where} · ${rows[i]}: … and the page did not move up or down`, Math.abs(topAfter - topBefore) < 2, `${topBefore} → ${topAfter}`);
      await p.screenshot({ path: `${SHOTS}/f-${where.replace(/\W+/g, '-')}-${i}.png` });
    }
  };

  await tab('Stock');
  await tapHangingCards('Stock');
  await tab('Money');
  await tapHangingCards('Money');
  await p.locator('button[aria-label="Export a report"]').locator('visible=true').first().click();
  await p.waitForTimeout(3000);
  await tapHangingCards('Export');

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
