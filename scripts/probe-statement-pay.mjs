/**
 * Recording a payment from a statement: a pushed page, with nothing pinned to the foot.
 *
 * Two things this covers, both reported from a real phone:
 *
 *   The "Record a payment" button sat pinned across the bottom of the statement, on top of the
 *   very timeline it was there to settle. It is a header action now, and the form it opens is a
 *   PAGE — the same `account_action_page` the People tab pushes, rather than a second sheet with
 *   its own copy of the amount field and its own call to `record_payment`.
 *
 *   The action was gated on `owed`, which totals the unpaid amounts on the RECEIPTS. A customer
 *   who owes ₦600,000 from an opening balance has no receipts at all, so the statement offered no
 *   way to take their money. It is gated on the real balance now.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const raw = fs.readFileSync('.env.local', 'utf8');
const env = (k) => (raw.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]?.trim().replace(/^"|"$/g, '');

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
};

const b = await chromium.launch();
const p = await (
  await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
).newPage();
p.on('pageerror', (e) => console.log('  PAGEERROR:', e.message.split('\n')[0]));

await p.goto(BASE + '/login', { waitUntil: 'networkidle' });
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p
  .locator('input[type="password"]')
  .first()
  .evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);

await p.evaluate(() => {
  document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 120; });
});
await p.waitForTimeout(400);
await p.evaluate(() => {
  document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 0; });
});
await p.waitForTimeout(900);

await p.getByRole('button', { name: 'Money', exact: true }).first().click();
await p.waitForTimeout(2800);

const card = p.locator('[class*="rowLink"]:visible').first();
const owedOnCard = (await card.innerText()).replace(/[^0-9]/g, '');
await card.click();
await p.waitForTimeout(3200);
await p.screenshot({ path: 'shots/statement-no-pinned.png' });

const balance = (
  await p.locator('[class*="balanceCard"]:visible [class*="summaryValue"]').first().innerText()
).replace(/[^0-9]/g, '');
console.log(`  statement balance ${balance} (card said ${owedOnCard})`);

/*
 * Nothing pinned across the foot.
 *
 * Measured rather than eyeballed: any fixed/sticky element overlapping the bottom of the viewport
 * that is not the tab bar is a pinned section. That is what this page had.
 */
const pinned = await p.evaluate(() => {
  const vh = window.innerHeight;
  return [...document.querySelectorAll('button, div')]
    .filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') return false;
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      const r = el.getBoundingClientRect();
      if (r.height === 0 || r.width === 0) return false;
      // Overlapping the bottom edge of the screen.
      if (r.bottom < vh - 8 || r.top > vh) return false;
      // The tab bar is meant to be there.
      if (el.closest('[class*="navigation-bar"], nav')) return false;
      return true;
    })
    .map((el) => (el.textContent ?? '').trim().slice(0, 40))
    .filter((t) => /record a payment/i.test(t));
});
check('nothing pinned to the foot of the statement', pinned.length === 0, pinned.join(' | ') || 'clear');

// The action is in the header, and it is offered for a balance with no receipts behind it.
const payAction = p.getByRole('button', { name: 'Record a payment' }).first();
const hasAction = (await payAction.count()) > 0;
check('a payment can be recorded whatever the balance is made of', hasAction,
  `balance ${balance}, receipts ${balance === owedOnCard ? 'match' : 'differ'}`);

if (hasAction) {
  await payAction.click();
  await p.waitForTimeout(2600);
  const body = await p.locator('body').innerText();
  const nav = decodeURIComponent(p.url()).match(/money-stack:([^|&]*)/)?.[1] ?? '';

  check('it pushed a page rather than opening a sheet', nav.split('.').length > 2, nav);
  check('no dialog is on screen', (await p.locator('[role="dialog"]:visible').count()) === 0);
  check('the payment form is on the page', /How much did they pay|How much are they paying/i.test(body));
  await p.screenshot({ path: 'shots/statement-payment-page.png' });

  await p.goBack();
  await p.waitForTimeout(2400);
  check('back returns to the statement', /What makes up this balance/i.test(await p.locator('body').innerText()));
}

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
