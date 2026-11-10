/**
 * THE CUSTOMER BAR AND THE COUNT GATE, AS REDESIGNED (10 Nov).
 *
 *   1. "+" starts a customer and its new tab is in view.
 *   2. The active tab opens the customer picker (no Add / Change button); the code and its share are
 *      the fourth action, not on the tab row.
 *   3. The count gate is one checklist: every item a row, a progress line, the first one open; Add
 *      ticks it and opens the next. Record is never pressed.
 *
 * On a tab of its own: the browser is shown only this probe's drafts and told nothing has been
 * counted today. Nothing is recorded; the probe's tab is closed at the end.
 *
 *     node scripts/probe-till-bar-gate-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';
import { addOnTill } from './till.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? 'probe-shots/till-bar';
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
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let failed = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const PROBE = trackDrafts(p);
const mine = new Set();
const writes = [];
p.on('request', (r) => {
  if (/rpc\/(count_from_till|record_count|settle)/.test(r.url())) writes.push(r.url());
});
p.on('response', async (r) => {
  if (!r.url().includes('/rpc/save_draft_order') || !r.ok()) return;
  try {
    mine.add(String(await r.json()));
  } catch {
    // not ours
  }
});
await p.route('**/rest/v1/rpc/my_open_drafts*', async (route) => {
  const res = await route.fetch();
  const rows = (await res.json()) ?? [];
  await route.fulfill({ response: res, json: rows.filter((r) => mine.has(r.id)) });
});
// Nothing counted today, so the gate has work to show.
await p.route('**/rest/v1/rpc/todays_counts*', (route) => route.fulfill({ json: [] }));
await p.route('**/rest/v1/rpc/which_need_count*', async (route) => {
  const ids = JSON.parse(route.request().postData() ?? '{}').p_product_ids ?? [];
  await route.fulfill({ json: ids.map((id) => ({ product_id: id })) });
});
const shot = (n) => p.screenshot({ path: `${SHOTS}/${n}.png` });

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(7000);
  await p.evaluate(() =>
    [...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === 'Sell')?.click(),
  );
  await p.waitForTimeout(3000);

  // ── 1. A few tabs, then "+": the new one is in view ──
  for (let i = 0; i < 5; i++) {
    await p.getByRole('button', { name: 'Start another customer' }).first().evaluate((el) => el.click());
    await p.waitForTimeout(2500);
  }
  const inView = await p.evaluate(() => {
    const row = document.querySelector('[role="tablist"][aria-label="Customers being served"]');
    const active = row.querySelector('[aria-selected="true"]');
    const r = row.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    return {
      ok: a.left >= r.left - 1 && a.right <= r.right + 1,
      n: row.querySelectorAll('[role="tab"]').length,
      a: [Math.round(a.left), Math.round(a.right)],
      r: [Math.round(r.left), Math.round(r.right)],
    };
  });
  check(inView.ok, `the new customer's tab is in view (${inView.n} tabs, tab ${inView.a} in row ${inView.r})`);
  await shot('1-bar');

  // ── 2. The bar's controls ──
  const group = p.getByRole('group', { name: 'What to do with this customer' });
  const actions = (await group.innerText()).replace(/\s+/g, ' ');
  check(!/Change|\bAdd\b/.test(actions), `no Add / Change action (${actions})`);
  check(/Remove/.test(actions) && /Close/.test(actions) && /Take over/.test(actions), 'Remove, Close and Take over are there');
  check((await group.getByRole('button', { name: /Share order|No order code/ }).count()) === 1, 'the code and share are the fourth action');
  check((await p.locator('[class*="tabsRow"] [aria-label^="Share order"]').count()) === 0, 'and are off the tab row');
  const activeName = () => p.locator('[role="tab"][aria-selected="true"]').first().innerText();
  const before = (await activeName()).split('\n')[0];
  await p.locator('[role="tab"][aria-selected="true"]').first().click();
  const picker = p.getByRole('dialog', { name: 'Who is this for?' });
  check(await picker.waitFor({ timeout: 8000 }).then(() => true).catch(() => false), 'tapping the active tab opens the customer picker');
  await p.waitForTimeout(800);
  await shot('2-picker-from-tab');
  await p.goBack();
  await p.waitForTimeout(1200);
  const after = (await activeName()).split('\n')[0];
  check(after === before, `closing the picker leaves the same customer active (${before} -> ${after})`);

  // ── 3. The count gate ──
  await addOnTill(p, '1 Big Stout', 'Big Stout Bottle (600mL)');
  await addOnTill(p, '2 Trophy', 'Trophy Bottle (600mL)');
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /Count (it|them) now/ }).locator('visible=true').first().click();
  const list = p.locator('ol[class*="checklist"]');
  await list.waitFor({ timeout: 20000 });
  await p.waitForTimeout(1500);
  await shot('3-gate');
  const rows = await list.locator(':scope > li').count();
  check(rows === 2, `every item to count is a row (${rows})`);
  check(/0\s*of 2 counted/.test(await p.getByLabel('How far along').innerText()), 'the progress says 0 of 2');
  check((await list.locator('li[class*="itemOpen"]').count()) === 1, 'the first item is open to count');
  const open = list.locator('li[class*="itemOpen"]');
  await open.locator('input').first().fill('3');
  await open.getByRole('button', { name: 'Add', exact: true }).click();
  await p.waitForTimeout(600);
  check(/1\s*of 2 counted/.test(await p.getByLabel('How far along').innerText()), 'Add ticks it: 1 of 2');
  check((await list.locator('li[class*="itemDone"]').count()) === 1, 'the counted row shows its figure');
  check((await list.locator('li[class*="itemOpen"]').count()) === 1, 'and the next one opens');
  await shot('4-gate-one-counted');
  check(writes.length === 0, 'nothing was recorded');
} catch (e) {
  check(false, `ran — ${e.message.split('\n')[0]}`);
  await shot('error').catch(() => {});
} finally {
  await sweepDrafts(admin, PROBE);
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
