/**
 * AN ORDER CHANGED ON ONE DEVICE REACHES THE OTHERS, WITHOUT CLOSING THE APP.
 *
 * "When we are using multiple devices and open one from the background, we have to close and reopen
 * to see changes like draft order changes." Open orders were not on the live feed, the feed skipped
 * anything the signed-in person wrote (so one account on two phones never heard itself), and nothing
 * caught up after the app had been asleep (0273, `live-shop`, `useDraftOrders`).
 *
 * Three devices, ONE account, as the shop runs it:
 *
 *   A  starts an order and puts an item on it (told the shop has no open orders, so it starts one);
 *   B  is listening: the order appears on its till within seconds, no reload;
 *   C  is deaf (its live connection refused, as a phone asleep in a pocket): it does NOT see it —
 *      until the app comes back, when it catches up;
 *   the order is closed (cancelled, as the probe's sweep does) → B drops it, live.
 *
 *     node scripts/probe-orders-across-devices-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const browser = await chromium.launch();
const errors = [];
async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${String(e).split('\n')[0]}`));
  return p;
}
async function signIn(p) {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
}
const tabsOf = (p) => p.locator('[role="tablist"][aria-label="Customers being served"] [role="tab"]');
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(500);
  }
  return false;
}

const a = await device('A');
const b = await device('B');
const c = await device('C');
const PROBE_DRAFTS = trackDrafts(a);

// A: the shop has no open orders, as far as it can tell — so it starts one of its own.
await a.route('**/rest/v1/rpc/my_open_drafts*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
);
// C: asleep. Its live connection never opens.
await c.routeWebSocket(/realtime/, () => {});

try {
  await Promise.all([signIn(b), signIn(c)]);
  const cOpened = Date.now();
  await sleep(6000);
  const b0 = await tabsOf(b).count();
  const c0 = await tabsOf(c).count();
  console.log(`  B shows ${b0} order(s), C shows ${c0}`);

  await signIn(a);
  await a.waitForTimeout(8000);
  await a.getByRole('button', { name: /Add an item/ }).locator('visible=true').first().click();
  await a.waitForTimeout(1800);
  await a.keyboard.type('Chivita Active');
  await a.waitForTimeout(3000);
  await a.locator('.react-modal-sheet-container').getByText('Chivita Active (1L)', { exact: true }).locator('visible=true').first().click();
  const saved = await waitFor(async () => PROBE_DRAFTS.size > 0, 15000);
  check('A started an order and it was saved to the shop', saved);
  await a.waitForTimeout(2000);

  const heard = await waitFor(async () => (await tabsOf(b).count()) > b0, 15000);
  check('B, listening, shows the new order without a reload', heard, `${await tabsOf(b).count()} order(s)`);

  check('C, asleep, has not heard it', (await tabsOf(c).count()) === c0, `${await tabsOf(c).count()} order(s)`);

  // The app comes back: the moment the screen is looked at again.
  const wait = 16000 - (Date.now() - cOpened);
  if (wait > 0) await sleep(wait);
  await c.evaluate(() => window.dispatchEvent(new Event('focus')));
  const caught = await waitFor(async () => (await tabsOf(c).count()) > c0, 15000);
  check('C, coming back, catches up', caught, `${await tabsOf(c).count()} order(s)`);

  // Closed elsewhere (the sweep cancels it, as closing the tab would).
  await sweepDrafts(admin, PROBE_DRAFTS);
  const dropped = await waitFor(async () => (await tabsOf(b).count()) === b0, 15000);
  check('closed elsewhere, B drops it, live', dropped, `${await tabsOf(b).count()} order(s)`);
  await b.screenshot({ path: 'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/across-devices-b.png' });

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
