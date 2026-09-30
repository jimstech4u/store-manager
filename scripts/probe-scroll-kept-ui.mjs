/**
 * A PAGE KEEPS ITS PLACE WHEN YOU COME BACK TO IT.
 *
 * "The page with the buttons loses its scroll if we move to a next page (empties, deposit or any from
 * it) ... check other pages that have that." Scroll a page down, open something from it, come back:
 * it must be where it was. Measured on the account (→ Empties, → Deposit, → Money), the Money tab's
 * list, and Stock (→ an item). Read-only.
 *
 *     node scripts/probe-scroll-kept-ui.mjs [http://localhost:3100]
 */
import { chromium, webkit } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

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

/** The scroll position of whatever scrolls on the top page, and which element that is. */
const where = () =>
  p.evaluate(() => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    const pages = [...(active?.querySelectorAll('.navstack-page') ?? [])];
    const page = pages[pages.length - 1];
    const all = [page, ...(page?.querySelectorAll('*') ?? [])];
    const scroller = all.find((el) => el && el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible');
    return {
      top: Math.round(scroller?.scrollTop ?? window.scrollY),
      win: Math.round(window.scrollY),
      el: scroller ? `${scroller.tagName}.${String(scroller.className).split(' ')[0]}` : 'window',
      pages: pages.length,
    };
  });
/** Scroll the top page's scroller to `y`, the way a finger leaves it (works on mobile WebKit too). */
const scrollTo = async (y) => {
  await p.evaluate((y) => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    const pages = [...(active?.querySelectorAll('.navstack-page') ?? [])];
    const page = pages[pages.length - 1];
    const all = [page, ...(page?.querySelectorAll('*') ?? [])];
    const scroller = all.find((el) => el && el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible');
    if (scroller) scroller.scrollTop = y;
  }, y);
  await p.waitForTimeout(900);
};
const roundTrip = async (label, open) => {
  await scrollTo(900);
  const before = await where();
  await open();
  await p.waitForTimeout(3500);
  // Desktop engines keep a hidden page's offset themselves; iOS Safari does not, and only the
  // saved position (navigation-stack 1.9.0) brings it back there. This probe cannot show that part.
  await p.waitForTimeout(300);
  await p.goBack();
  await p.waitForTimeout(3500);
  const after = await where();
  check(`${label}: back where it was`, before.top > 100 && Math.abs(after.top - before.top) < 40,
    `${before.top} → ${after.top} (${after.el})`);
  // back to the top for the next trip
  await scrollTo(0);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(8000);

  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /everyone you sell to/i }).locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  await p.getByRole('button', { name: /Arewa/ }).locator('visible=true').first().click();
  await p.waitForTimeout(6000);

  // A TAP, not Playwright's click: its click scrolls the button into view first, which moved the
  // page before it was left and made the probe measure itself.
  const tap = (locator) => locator.first().evaluate((el) => el.click());
  const card = (name) => () =>
    tap(p.locator('.group-stack-container[data-active="true"] .navstack-page').last().getByRole('button', { name }));
  await roundTrip('account → Empties', card(/^Empties/));
  await roundTrip('account → Deposit', card(/^Deposit/));
  await roundTrip('account → Money', card(/^Money/));

  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(4000);
  await roundTrip('Stock → an item', async () => {
    await tap(p.locator('.group-stack-container[data-active="true"] .navstack-page').last()
      .locator('ul > li button, [role="listitem"] button').locator('visible=true'));
  });

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
