/**
 * THE TILL'S FOUR FIXES OF 10 NOV (evening), click by click.
 *
 *   1. A line just added is in full view, below the pinned customer bar — not under it.
 *   2. Remove works for a customer who has been through a read from the shop: the name goes with
 *      them, the tab is no longer named after them, and Remove is grey only when there is nobody.
 *   3. The customer picker opens OVER All items, which stays; a customer picked lands on the sheet.
 *   4. A customer CREATED from All items is on the order when the form is done, and All items is
 *      back — no searching for them again.
 *
 * On a tab of its own (only this probe's drafts are shown to it; today's counts answered in the
 * browser). The new customer is never written: `upsert_customer` is answered in the browser with an
 * existing customer's id, so nothing is added to the shop's book. The probe's drafts are cancelled
 * at the end, and nothing is settled.
 *
 *     node scripts/probe-sheets-and-customer-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';
import { addOnTill } from './till.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  process.env.SHOTS ??
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/sheets';
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
const STORE = '7138327c-c81c-4486-a97c-92207b48b64e';

let failed = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failed += 1;
};

const { data: known } = await admin
  .from('store_customers')
  .select('id, display_name')
  .eq('store_id', STORE)
  .eq('display_name', 'A406 Hotel')
  .limit(1);
const STAND_IN = known?.[0]?.id;
if (!STAND_IN) throw new Error('A406 Hotel not found');

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const PROBE = trackDrafts(p);
const mine = new Set();
const writes = [];
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
await p.route('**/rest/v1/rpc/todays_counts*', async (route) => {
  const ids = JSON.parse(route.request().postData() ?? '{}').p_product_ids ?? [];
  await route.fulfill({
    json: ids.map((id) => ({
      product_id: id, period_id: 'probe', period_status: 'open', counted_qty: 0, first_qty: 0,
      counted_by_name: 'Probe', counted_by_you: true, counted_at: new Date().toISOString(), edits: 0,
    })),
  });
});
// The new customer is answered here, never written.
await p.route('**/rest/v1/rpc/upsert_customer*', async (route) => {
  writes.push('upsert_customer');
  await route.fulfill({ json: STAND_IN });
});
await p.route('**/rest/v1/rpc/backfill_*', async (route) => {
  writes.push(route.request().url());
  await route.fulfill({ json: null });
});

const shot = (name) => p.screenshot({ path: `${SHOTS}/${name}.png` });
const visible = (loc) => loc.locator('visible=true').first();
const tabNames = () =>
  p.evaluate(() =>
    [...document.querySelectorAll('[class*="CustomerTabs_bar"] [role="tab"]')].map((t) => t.textContent),
  );

/** Whether a till line is wholly between the customer bar and the bottom of what is visible. */
const lineInView = (name) =>
  p.evaluate((name) => {
    const bar = document.querySelector('[class*="CustomerTabs_bar"]');
    const top = bar ? bar.getBoundingClientRect().bottom : 0;
    const vv = window.visualViewport;
    const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const line = [...document.querySelectorAll('[data-line-key]')].find((l) => l.textContent.includes(name));
    if (!line) return { ok: false, why: 'no line' };
    const r = line.getBoundingClientRect();
    return { ok: r.top >= top - 1 && r.bottom <= bottom + 1, top: Math.round(r.top), bar: Math.round(top), bottom: Math.round(r.bottom) };
  }, name);

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(7000);
  // The app may open on another tab; the till is on Sell.
  await visible(p.getByRole('tab', { name: 'Sell' }).or(p.getByRole('link', { name: 'Sell' })).or(p.getByRole('button', { name: 'Sell', exact: true }))).click();
  await p.waitForTimeout(2500);

  // ── 1. The line just added is in view ──
  for (const [typed, name] of [
    ['1 Big Stout', 'Big Stout Bottle (600mL)'],
    ['2 Trophy', 'Trophy Bottle (600mL)'],
    ['1 Goldberg', 'Goldberg Bottle (600mL)'],
    ['1 Heineken Big', 'Heineken Big Bottle (600mL)'],
  ]) {
    await addOnTill(p, typed, name);
    await p.waitForTimeout(900);
    const seen = await lineInView(name);
    check(seen.ok, `${name}: added and in full view below the bar ${JSON.stringify(seen)}`);
  }
  await shot('1-after-adding');

  // ── 2. Remove, after a read from the shop ──
  await visible(p.getByRole('tab', { name: /Say who this sale is for/ })).click();
  await p.getByText('A406 Hotel').first().click();
  await p.waitForTimeout(3500); // saved
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(7000);
  check((await tabNames()).some((t) => t.includes('A406 Hotel')), 'after a reload the tab is A406 Hotel');
  const remove = visible(p.getByRole('button', { name: 'Take the customer off this sale' }));
  check(await remove.isEnabled(), 'and Remove can be pressed');
  await remove.click();
  await p.getByRole('button', { name: 'Take them off' }).click();
  await p.waitForTimeout(3500);
  check(!(await tabNames()).some((t) => t.includes('A406 Hotel')), `taken off, the tab is no longer named after them (${(await tabNames()).join(' | ')})`);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(7000);
  check(!(await tabNames()).some((t) => t.includes('A406 Hotel')), 'and not after another reload either');
  check(!(await visible(p.getByRole('button', { name: 'Take the customer off this sale' })).isEnabled()), 'Remove is grey with nobody on the sale');
  await shot('2-removed');

  // ── 3. The picker over All items ──
  await visible(p.getByRole('button', { name: /All items — share/ })).click();
  const sheet = p.getByRole('dialog', { name: 'All items' });
  await sheet.getByText('Not a receipt').first().waitFor({ timeout: 20000 });
  await p.waitForTimeout(800);
  await sheet.getByRole('button', { name: /Add customer/ }).click();
  const picker = p.getByRole('dialog', { name: 'Who is this for?' });
  await picker.waitFor({ timeout: 10000 });
  await p.waitForTimeout(900);
  await shot('3-picker-over-sheet');
  check(await sheet.isVisible(), 'All items stays open under the picker');
  const focusedInPicker = await p.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-label="Who is this for?"]'));
  check(focusedInPicker, 'and the picker has the keyboard, not the sheet under it');
  await picker.getByText('A406 Hotel').first().click();
  await p.waitForTimeout(1200);
  check(!(await picker.isVisible().catch(() => false)), 'picking closes the picker');
  check(await sheet.isVisible(), 'and All items is still there');
  check(/A406 Hotel/.test(await sheet.innerText()), 'with A406 Hotel on it');
  await shot('3-picked-on-sheet');

  // Back closes the top sheet only.
  await sheet.getByRole('button', { name: /Change/ }).first().click();
  await picker.waitFor({ timeout: 10000 });
  await p.waitForTimeout(700);
  await p.goBack();
  await p.waitForTimeout(1000);
  check(!(await picker.isVisible().catch(() => false)), 'Back closes the picker');
  check(await sheet.isVisible(), 'and leaves All items open');

  // ── 4. A new customer, created from All items ──
  await sheet.getByRole('button', { name: /Change/ }).first().click();
  await picker.waitFor({ timeout: 10000 });
  await p.waitForTimeout(600);
  await p.keyboard.type('Probe Zed', { delay: 30 });
  await p.waitForTimeout(1800);
  await visible(picker.getByRole('button', { name: /Add "Probe Zed"/ })).click();
  await p.getByLabel('Their name').waitFor({ timeout: 20000 });
  await p.waitForTimeout(1200);
  await shot('4-form');
  check(!(await sheet.isVisible().catch(() => false)), 'the sheet steps aside for the form');
  await p.getByLabel('Phone').fill('08000000000');
  await p.getByLabel('They already owe you').fill('0');
  await p.getByLabel('You owe them').fill('0').catch(() => {});
  const none = p.getByText('Nothing of yours is with them', { exact: false });
  if (await none.count()) await none.first().click();
  await p.getByRole('button', { name: 'Save customer' }).click();
  await p.waitForTimeout(2500);
  check(writes.includes('upsert_customer'), 'the form saved (answered in the browser)');
  const back = p.getByRole('dialog', { name: 'All items' });
  await back.waitFor({ timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(1000);
  await shot('4-after-create');
  check(await back.isVisible().catch(() => false), 'All items is back after the form');
  check(/Probe Zed/.test(await back.innerText().catch(() => '')), 'with the new customer on it, without searching again');
  check((await tabNames()).some((t) => t.includes('Probe Zed')), 'and the tab is theirs');

  // ── 5. The same, from Take payment: its own row, and its All items ──
  await back.getByRole('button', { name: 'Close' }).click();
  await p.waitForTimeout(900);
  await p.locator('button').filter({ hasText: /Take payment/ }).locator('visible=true').last().click();
  await p.getByRole('region', { name: 'The bill' }).first().waitFor({ timeout: 20000 });
  await p.waitForTimeout(1200);
  const createFrom = async (name, open) => {
    await open();
    await picker.waitFor({ timeout: 10000 });
    await p.waitForTimeout(600);
    await p.keyboard.type(name, { delay: 30 });
    await p.waitForTimeout(1800);
    await visible(picker.getByRole('button', { name: new RegExp(`Add "${name}"`) })).click();
    await p.getByLabel('Their name').waitFor({ timeout: 20000 });
    await p.getByLabel('Phone').fill('08000000001');
    await p.getByLabel('They already owe you').fill('0');
    const none = p.getByText('Nothing of yours is with them', { exact: false });
    if (await none.count()) await none.first().click();
    await p.getByRole('button', { name: 'Save customer' }).click();
    await p.waitForTimeout(2500);
  };
  await createFrom('Probe Yan', () => visible(p.getByRole('button', { name: 'Change' })).click());
  await shot('5-payment-after-create');
  check(/Probe Yan/.test(await p.locator('main, body').first().innerText()), 'Take payment: a customer created from its row is on the sale');
  // All items is with the items, under Show.
  await p.getByRole('region', { name: 'The bill' }).first().getByRole('button', { expanded: false }).first().click();
  await p.waitForTimeout(500);
  await visible(p.getByRole('button', { name: /All items/ })).click();
  const tpSheet = p.getByRole('dialog', { name: 'All items' });
  await tpSheet.getByText('Not a receipt').first().waitFor({ timeout: 20000 });
  await p.waitForTimeout(800);
  await createFrom('Probe Xu', () => tpSheet.getByRole('button', { name: /Change/ }).first().click());
  await tpSheet.waitFor({ timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(800);
  await shot('5-payment-sheet-after-create');
  check(await tpSheet.isVisible().catch(() => false), 'Take payment: All items is back after the form');
  check(/Probe Xu/.test(await tpSheet.innerText().catch(() => '')), 'with the new customer on it');
} catch (e) {
  console.log('  FAIL  ', e.message.split('\n')[0]);
  await shot('error').catch(() => {});
  failed += 1;
} finally {
  await sweepDrafts(admin, PROBE);
  await browser.close();
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
