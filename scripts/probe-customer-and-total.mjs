/**
 * Three things a seller does at a counter, clicked through.
 *
 *   1. Choosing a customer from the payment screen must not throw away what is typed on it.
 *   2. Filing somebody under People must not attach them to whatever sale happens to be open.
 *   3. A price agreed as a TOTAL — "four crates for thirty-five thousand" — must divide itself.
 *
 * All three were found by clicking, not by reading: the first two looked correct in the source and
 * were wrong in the app, and the third did not exist at all.
 *
 *     node scripts/probe-customer-and-total.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/customer-total';
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

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

/*
 * The nav bar's own items, matched EXACTLY, and scrolled back into view first.
 *
 * `getByRole('button', { name })` matches substrings, so asking for "Sell" cheerfully found "Close
 * this tab without selling" and opened a confirm dialog over the whole app — which then looked
 * exactly like the bug being hunted. The nav bar also autohides on scroll.
 */
const tab = async (label) => {
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(1000);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(4000);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ── A fresh tab with one item on it ───────────────────────────────────────────────
  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  if (await plus.count()) {
    await plus.click();
    await p.waitForTimeout(5000);
  }
  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(3500);
  const product = p.locator('[role="dialog"] [class*="ProductPicker_name"]').first();
  if (await product.count()) {
    await product.click();
    await p.waitForTimeout(6000);
  }

  // ── 3. A total the customer agreed to, divided by the till ────────────────────────
  console.log('\n— a price agreed as a total —');
  const qtyField = p.locator('[class*="stepperField"] input').first();
  await qtyField.fill('4');
  await p.waitForTimeout(2500);

  const totalButton = p.locator('button[class*="lineTotalValue"]').first();
  check('the line total can be tapped', (await totalButton.count()) > 0);
  await totalButton.click();
  await p.waitForTimeout(1200);

  const totalInput = p.getByLabel(/Total for this line/i).first();
  await totalInput.fill('35000');
  await p.waitForTimeout(400);
  // Blurred by tapping elsewhere, which is what a seller does next anyway.
  await p.locator('body').click({ position: { x: 5, y: 400 } });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${SHOTS}/1-total.png` });

  const priced = await p.locator('input').evaluateAll((els) =>
    els.map((e) => e.value).filter((v) => v === '8750'),
  );
  check('35,000 across four becomes 8,750 each', priced.length > 0, `values seen: ${priced}`);

  const body1 = await p.locator('body').innerText();
  check('and the line reads back as ₦35,000', body1.includes('35,000'));

  // ── 1. Choosing a customer must not empty the payment form ────────────────────────
  console.log('\n— choosing a customer from the payment screen —');
  await p.getByRole('button', { name: /take payment/i }).first().click();
  await p.waitForTimeout(5000);

  await p.getByLabel(/Note/i).first().fill('PROBE NOTE keep me');
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${SHOTS}/2-typed.png` });

  await p.locator('[class*="forRow"]').first().click();
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `${SHOTS}/3-picker.png` });

  check(
    'the payment screen stays put — no bounce back to the till',
    (await p.locator('[class*="forRow"]').count()) > 0,
  );

  const rows = p.locator('[class*="CustomerPicker_row"]');
  if (await rows.count()) {
    await rows.first().click();
    await p.waitForTimeout(6000);
  }
  await p.screenshot({ path: `${SHOTS}/4-picked.png` });

  const body2 = await p.locator('body').innerText();
  check('a customer is attached', body2.includes('Change'));

  /*
   * Read off the FIELD, not out of the page text.
   *
   * Asserted against innerText first, which an input's value is never part of — so the check could
   * only ever fail, and it reported a data-loss bug that had already been fixed. A probe that
   * cannot pass is worse than no probe: it sends somebody looking for a fault that is not there.
   */
  const noteField = p.getByLabel(/Note/i).first();
  const noteKept = (await noteField.count()) ? await noteField.inputValue() : '(field gone)';
  check(
    'and the note typed before is still there',
    noteKept === 'PROBE NOTE keep me',
    `field holds "${noteKept}"`,
  );

  // ── 2. Filing somebody under People touches no sale ───────────────────────────────
  console.log('\n— adding somebody from the People tab —');
  await p.locator('button[aria-label*="back" i]:visible').first().click().catch(() => {});
  await p.waitForTimeout(3000);

  await tab('People');
  await p.locator('button[aria-label*="customer" i]:visible').first().click();
  await p.waitForTimeout(4000);

  const tag = Date.now().toString().slice(-5);
  await p.getByLabel(/Their name/i).fill(`Unrelated ${tag}`);
  await p.getByLabel(/^Phone/i).fill(`0807${Date.now().toString().slice(-7)}`);
  await p.getByLabel(/Business name/i).fill(`Probe Traders ${tag}`);
  await p.waitForTimeout(400);
  await p.getByRole('button', { name: /Save customer/i }).click();
  await p.waitForTimeout(7000);
  await p.screenshot({ path: `${SHOTS}/5-people.png` });

  await tab('Sell');
  await p.screenshot({ path: `${SHOTS}/6-sell.png` });
  const body3 = await p.locator('body').innerText();
  check(
    'they are NOT attached to the open sale',
    !body3.includes(`Unrelated ${tag}`),
    body3.includes(`Unrelated ${tag}`) ? 'the open order was rewritten' : '',
  );

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
