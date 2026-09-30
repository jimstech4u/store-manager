/**
 * THE SHOP'S COUNT HISTORY — every count, what it found, filtered, and a way into the item.
 *
 * "Also count history in full, with all products, with filter — and stock history also carries that,
 * so we can see how we counted."
 *
 *   Count -> "Count history": counts are listed, each saying Matched or what it was off by, in
 *   shapes; "Matched" and "Off" filter them; a row opens that item's stock history, which shows the
 *   same count. Read-only.
 *
 *     node scripts/probe-count-history-ui.mjs [http://localhost:3100]
 */

import { chromium, webkit } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad';
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

const rows = () =>
  p.evaluate(() => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    const pages = [...(active?.querySelectorAll('.navstack-page') ?? [])];
    const page = pages[pages.length - 1];
    return [...(page?.querySelectorAll('ul > li > button') ?? [])].map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());
  });
const title = () =>
  p.evaluate(() => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    const pages = [...(active?.querySelectorAll('.navstack-page') ?? [])];
    return (pages[pages.length - 1]?.querySelector('h1')?.textContent ?? '').trim();
  });

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(8000);

  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /^Count$/ }).locator('visible=true').first().click();
  await p.waitForTimeout(3500);
  await p.locator('button[aria-label="Count history"]').locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  check('Count has a "Count history" page', (await title()) === 'Count history', await title());

  let r = await rows();
  await p.screenshot({ path: `${SHOTS}/count-history.png` });
  check('counts are listed', r.length > 0, `${r.length}`);
  check('each says Matched or what it was off by', r.every((t) => /Matched|short|over/.test(t)), r.slice(0, 3).join(' | '));
  check('… with what was counted, in shapes', r.some((t) => /Counted \d+ (packs?|crates?|cans?|bottles?|pieces?)/i.test(t)), r[0]);
  check('an item\'s opening count is not listed', !r.some((t) => /ZZ Probe/.test(t)));

  await p.getByRole('tab', { name: /^Off$/ }).locator('visible=true').first().click();
  // An empty list would pass "every row is off": wait for the rows the server has.
  for (let i = 0; i < 20 && !(r = await rows()).some((t) => /short|over/.test(t)); i++) await p.waitForTimeout(500);
  check('"Off" shows only counts with a difference', r.length > 0 && r.every((t) => /short|over/.test(t)), r.slice(0, 3).join(' | ') || '(none)');

  await p.getByRole('tab', { name: /^Matched$/ }).locator('visible=true').first().click();
  await p.waitForTimeout(3000);
  r = await rows();
  check('"Matched" shows only counts that matched', r.length > 0 && r.every((t) => /Matched/.test(t)), r.slice(0, 3).join(' | '));

  const first = r[0] ?? '';
  // The Count page underneath has rows too; only this page's are on screen.
  await p.locator('.group-stack-container[data-active="true"] ul > li > button').locator('visible=true').first().click();
  await p.waitForTimeout(4500);
  const history = await p.evaluate(() => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    const pages = [...(active?.querySelectorAll('.navstack-page') ?? [])];
    return (pages[pages.length - 1]?.textContent ?? '').replace(/\s+/g, ' ');
  });
  check('a row opens the item\'s stock history', (await title()) === 'Stock history', await title());
  check('… which shows the same count', /Counted\s*Matched/.test(history), first.slice(0, 60));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/count-history-crash.png` }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
