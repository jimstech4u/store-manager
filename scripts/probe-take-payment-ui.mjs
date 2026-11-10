/**
 * TAKE PAYMENT AND ALL ITEMS, AS REDESIGNED (10 Nov) — and photographed.
 *
 *   1. All items opens as a SHEET over the till: NOT A RECEIPT, the paper, ticks — and no box to type
 *      in. Closing it leaves the till where it was.
 *   2. Take payment: the items fold under a head that says Show and then Hide.
 *   3. A charge and a deposit are each typed in ONE box ("Transport 2000", "5000 crates"), show as
 *      lines in the bill with their own cross, and Done folds the box away.
 *   4. A transfer's reference is added from its line, in the payment's one box.
 *   5. Typing: the tab bar and the floating pill step aside while a box has the keyboard.
 *
 * On a tab of its own: the browser is shown only the orders this probe saved, and today's counts
 * are answered as counted IN THE BROWSER. Nothing is settled; the probe's orders are cancelled at the
 * end. Screenshots go to SHOTS (default: the scratchpad folder below).
 *
 *     node scripts/probe-take-payment-ui.mjs [http://localhost:3100]
 */

import { chromium, webkit } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';
import { addOnTill } from './till.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  process.env.SHOTS ??
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/take-payment';
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

const engine = process.env.ENGINE === 'webkit' ? webkit : chromium;
const browser = await engine.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: process.env.ENGINE !== 'webkit', hasTouch: true });
const PROBE = trackDrafts(p);
const mine = new Set();
const settles = [];
p.on('request', (r) => {
  if (/rpc\/(settle|record_sale)/.test(r.url())) settles.push(r.url());
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
await p.route('**/rest/v1/rpc/todays_counts*', async (route) => {
  const ids = JSON.parse(route.request().postData() ?? '{}').p_product_ids ?? [];
  await route.fulfill({
    json: ids.map((id) => ({
      product_id: id, period_id: 'probe', period_status: 'open', counted_qty: 0, first_qty: 0,
      counted_by_name: 'Probe', counted_by_you: true, counted_at: new Date().toISOString(), edits: 0,
    })),
  });
});

const shot = (name) => p.screenshot({ path: `${SHOTS}/${name}.png` });
const visible = (loc) => loc.locator('visible=true').first();
const bill = () => p.getByRole('region', { name: 'The bill' }).first();
const payBox = () => p.getByRole('region', { name: 'The payment' }).first();

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(7000);

  await addOnTill(p, '1 Big Stout', 'Big Stout Bottle (600mL)');
  await addOnTill(p, '2 Trophy', 'Trophy Bottle (600mL)');
  await p.waitForTimeout(2500);

  // ── 1. All items is a sheet ──
  await visible(p.getByRole('button', { name: /All items — share/ })).click();
  const sheet = p.getByRole('dialog', { name: 'All items' });
  await sheet.getByText('Not a receipt').first().waitFor({ timeout: 20000 });
  await p.waitForTimeout(1200);
  await shot('1-all-items-sheet');
  check(true, 'All items opens as a sheet over the till');
  const boxes = await sheet.locator('input:not([type="checkbox"]), textarea, select').count();
  check(boxes === 0, `no box to type in on the sheet (${boxes})`);
  const h = await sheet.evaluate((el) => {
    const panel = el.getBoundingClientRect();
    return Math.round((panel.height / window.innerHeight) * 100);
  });
  check(h <= 93, `the sheet stops at 92dvh (${h}% of the screen)`);
  await sheet.getByRole('button', { name: 'Close' }).click();
  await p.waitForTimeout(1000);
  check((await sheet.count()) === 0 || !(await sheet.isVisible()), 'Close puts it away');
  check(await visible(p.getByRole('button', { name: /All items — share/ })).isVisible(), 'and the till is still there underneath');

  // ── 2. Take payment, items folded, Show and Hide ──
  await p.locator('button').filter({ hasText: /Take payment/ }).locator('visible=true').last().click();
  await bill().waitFor({ timeout: 20000 });
  await p.waitForTimeout(1500);
  await shot('2-take-payment');
  const head = bill().getByRole('button', { expanded: false }).first();
  check(/Show/.test(await head.innerText()), 'the items are folded, and the head says Show');
  await head.click();
  await p.waitForTimeout(400);
  const open = bill().getByRole('button', { expanded: true }).first();
  check(/Hide/.test(await open.innerText()), 'opened, the head says Hide');
  check(await bill().getByText('Trophy Bottle (600mL)').first().isVisible(), 'and the lines are there');
  await shot('3-items-shown');
  await open.click();
  await p.waitForTimeout(400);
  check(!(await bill().getByText('Trophy Bottle (600mL)').first().isVisible().catch(() => false)), 'Hide folds them again');

  // ── 3. A charge and a deposit, one box ──
  await bill().getByRole('button', { name: 'Charge' }).click();
  const one = bill().getByLabel('The charge');
  await one.pressSequentially('Transport 2000', { delay: 20 });
  await shot('4-composer-charge');
  check(/Adds Transport · ₦2,000/.test(await bill().innerText()), 'the box reads "Transport 2000" as a ₦2,000 transport charge');
  await one.press('Enter');
  await p.waitForTimeout(400);
  check(/Transport[\s\S]*₦2,000/.test(await bill().innerText()), 'Enter adds it as a line in the bill');
  check((await one.inputValue()) === '', 'and the box is empty for the next');
  // The name alone, then the amount: "Add never gets active" when only a name was typed (10 Nov).
  await one.pressSequentially('Loading', { delay: 20 });
  const next = bill().getByRole('button', { name: 'Next' });
  check(await next.isEnabled(), 'a name alone makes the button Next, and it is active');
  await next.click();
  const much = bill().getByLabel('How much for Loading');
  check((await much.getAttribute('inputmode')) === 'decimal', 'Next turns the same box into the amount, with the number pad');
  await much.pressSequentially('1500', { delay: 20 });
  await shot('4b-composer-amount-step');
  await much.press('Enter');
  await p.waitForTimeout(400);
  check(/Loading[\s\S]*₦1,500/.test(await bill().innerText()), 'and Enter adds Loading ₦1,500');
  await bill().getByRole('button', { name: /Remove Loading/ }).click();
  await p.waitForTimeout(300);
  await one.click(); // a box with the keyboard, for the checks below
  await p.waitForTimeout(300);
  const kb = await p.evaluate(() => document.documentElement.getAttribute('data-ax-keyboard'));
  const nav = await p.evaluate(() => {
    const w = document.querySelector('[class*="page_navWrap"]');
    return w ? getComputedStyle(w).display : 'missing';
  });
  check(kb === 'open' && nav === 'none', `typing: the tab bar steps aside (keyboard flag ${kb}, bar ${nav})`);
  const pills = await p.evaluate(() =>
    [...document.querySelectorAll('[class*="FloatingAmount_pill"]')].filter((e) => getComputedStyle(e).display !== 'none').length,
  );
  check(pills === 0, `typing: no floating pill over the keyboard (${pills} showing)`);

  await bill().getByRole('button', { name: 'Deposit', exact: true }).click();
  const dep = bill().getByLabel('The deposit');
  await dep.pressSequentially('5000 crates', { delay: 20 });
  await dep.press('Enter');
  await p.waitForTimeout(400);
  await bill().getByRole('button', { name: 'Done' }).click();
  await p.waitForTimeout(500);
  const text = await bill().innerText();
  check(/Deposit held[\s\S]*crates[\s\S]*₦5,000/.test(text), 'the deposit is its own line, "crates", ₦5,000');
  check((await bill().getByLabel(/The charge|The deposit/).count()) === 0, 'Done folds the box away');
  await shot('5-charge-and-deposit');
  check(/Who is this for\? Needed/.test(await p.locator('body').innerText()), 'a deposit on a walk-in asks who it is for');
  await bill().getByRole('button', { name: 'Remove this deposit' }).click();
  await p.waitForTimeout(400);
  check(!/Deposit held/.test(await bill().innerText()), 'its cross takes the deposit off, from where it is read');
  await bill().getByRole('button', { name: /Remove Transport/ }).click();
  await p.waitForTimeout(400);

  // ── 4. A transfer and its reference, in the one box ──
  await payBox().getByRole('button', { name: 'Transfer', exact: true }).click();
  await payBox().getByLabel('Amount').fill('1000');
  await payBox().getByRole('button', { name: 'Add', exact: true }).click();
  await p.waitForTimeout(400);
  await payBox().getByRole('button', { name: '+ Reference' }).click();
  const ref = payBox().getByLabel('Reference');
  check((await payBox().getByLabel('Amount').count()) === 0, 'the payment box turns into the reference box — still one box');
  await ref.pressSequentially('4471', { delay: 20 });
  await shot('6-reference');
  await ref.press('Enter');
  await p.waitForTimeout(400);
  check(/Transfer[\s\S]*4471[\s\S]*₦1,000/.test(await payBox().innerText()), 'the reference is on the transfer line');
  check((await payBox().getByLabel('Amount').count()) === 1, 'and the amount box is back');
  await p.locator('body').click({ position: { x: 5, y: 120 } });
  await p.waitForTimeout(800);
  await shot('7-payment');

  // ── 5. Who it is for: above the sums; Change and Remove once chosen ──
  const who = p.getByRole('button', { name: /Recording for/ }).locator('visible=true').first();
  const yWho = (await who.boundingBox())?.y ?? 0;
  const yPay = (await payBox().boundingBox())?.y ?? 0;
  const ySum = (await p.getByText('Paying now').first().boundingBox())?.y ?? 0;
  check(yWho > yPay && yWho < ySum, `the customer row sits above the sums, under the payment (${Math.round(yPay)} < ${Math.round(yWho)} < ${Math.round(ySum)})`);
  await who.click();
  const option = p.getByText('A406 Hotel', { exact: true }).locator('visible=true').first();
  await option.waitFor({ timeout: 20000 });
  await option.click();
  await p.waitForTimeout(1200);
  const change = p.getByRole('button', { name: 'Change', exact: true }).locator('visible=true').first();
  const remove = p.getByRole('button', { name: 'Remove', exact: true }).locator('visible=true').first();
  check((await change.isVisible()) && (await remove.isVisible()), 'with a customer chosen, the row offers Change and Remove');
  await change.scrollIntoViewIfNeeded();
  await shot('8-customer-chosen');
  await remove.click();
  await p.waitForTimeout(800);
  check(/Who is this for\? Needed|Anonymous walk-in/.test(await p.locator('body').innerText()), 'Remove takes them off the sale');

  check(settles.length === 0, 'nothing was settled');
} catch (e) {
  failed += 1;
  console.log('  stopped —', String(e).split('\n')[0]);
  await p.screenshot({ path: `${SHOTS}/stopped.png` }).catch(() => {});
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE);
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
