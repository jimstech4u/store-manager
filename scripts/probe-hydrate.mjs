/**
 * Does a screen come back with its data ALREADY DRAWN?
 *
 * The complaint this exists for: opening a receipt from a statement and coming back showed ₦0 and
 * an empty timeline for a beat before the figures reappeared. On a screen whose whole job is to
 * say what somebody owes, a momentary ₦0 is not a loading state — it is a wrong number, shown
 * confidently, to two people looking at the same phone across a counter.
 *
 * THE MEASUREMENT IS THE POINT. Every earlier check waited ~3s after going back and then asserted
 * the page was populated — which passed both before and after the fix, because a refetch finishes
 * well inside 3s. This one samples the DOM on the FIRST FRAMES after the pop, which is the only
 * window where a cache and a refetch look different.
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
  await b.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  })
).newPage();

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

// The bar autohides. A down-then-up produces the upward scroll event that reveals it — setting
// scrollTop to 0 on a container already at 0 fires nothing.
const revealBar = async () => {
  await p.evaluate(() => {
    document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => {
      c.scrollTop = 120;
    });
  });
  await p.waitForTimeout(400);
  await p.evaluate(() => {
    document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => {
      c.scrollTop = 0;
    });
  });
  await p.waitForTimeout(900);
};

await revealBar();
await p.getByRole('button', { name: 'Money', exact: true }).first().click();
await p.waitForTimeout(2800);

/* ------------------------------------------------------------------ pagination survives a push */

const visibleRows = () =>
  p.locator('[class*="money-page_row"]:visible, [class*="rowLink"]:visible').count();

const beforeScroll = await visibleRows();

// Page in more, the way a thumb does.
for (let i = 0; i < 3; i += 1) {
  await p.evaluate(() => {
    document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => {
      c.scrollTop = c.scrollHeight;
    });
  });
  await p.waitForTimeout(1400);
}
const afterScroll = await visibleRows();
console.log(`  list: ${beforeScroll} rows at rest, ${afterScroll} after paging`);

/*
 * Find a customer whose balance actually HAS receipts behind it.
 *
 * The first run picked Irekanmi, whose 600,000 comes from an opening position and deposits — the
 * statement was full but had no sale rows, so the one interesting step (push a receipt, come back)
 * silently did not run and the probe reported 2/2 on a test it had never executed. Keep looking
 * until there is something to push.
 */
let cardName = '';
let receipt = null;
for (let attempt = 0; attempt < 6; attempt += 1) {
  const card = p.locator('[class*="rowLink"]:visible').nth(attempt);
  if (!(await card.count())) break;
  cardName = (await card.innerText()).split('\n')[0];
  await card.click();
  await p.waitForTimeout(3000);
  const candidate = p.locator('[class*="rowLink"]:visible').first();
  if (await candidate.count()) {
    receipt = candidate;
    break;
  }
  console.log(`  ${cardName} has no receipts behind the balance — trying the next customer`);
  await p.goBack();
  await p.waitForTimeout(2200);
}

/* ------------------------------------------- the statement comes back drawn, not empty */

const statementRows = await p.locator('[class*="money-page_row"]:visible').count();
const balanceOf = async () =>
  (
    await p
      .locator('[class*="balanceCard"]:visible [class*="summaryValue"]')
      .first()
      .innerText()
      .catch(() => '')
  ).replace(/[^0-9]/g, '');
const balanceBefore = await balanceOf();
console.log(`  statement for ${cardName}: ${statementRows} rows, balance ${balanceBefore}`);
check('the statement loaded at all', statementRows > 0 && balanceBefore !== '', `${statementRows} rows`);

if (receipt) {
  await receipt.click();
  await p.waitForTimeout(2800);
  await p.screenshot({ path: 'shots/hydrate-receipt.png' });

  /*
   * Go back and sample IMMEDIATELY, repeatedly.
   *
   * Six samples over the first ~600ms. A cached page is populated in every one of them; a page
   * that refetches has at least one sample with no rows or a zeroed balance, and that sample is
   * exactly what somebody sees.
   */
  await p.goBack();
  const samples = [];
  for (let i = 0; i < 6; i += 1) {
    samples.push({
      at: i * 100,
      rows: await p.locator('[class*="money-page_row"]:visible').count(),
      balance: await balanceOf(),
    });
    await p.waitForTimeout(100);
  }
  console.log('  first frames back:', samples.map((s) => `${s.at}ms:${s.rows}r/${s.balance || '—'}`).join('  '));

  const everEmpty = samples.some((s) => s.rows === 0);
  const everZeroed = samples.some((s) => s.balance === '' || (balanceBefore !== '0' && s.balance === '0'));
  check('no empty timeline on the way back', !everEmpty);
  check('the balance never flashes a wrong figure', !everZeroed, `was ${balanceBefore}`);

  await p.waitForTimeout(2500);
  const settledRows = await p.locator('[class*="money-page_row"]:visible').count();
  const settledBalance = await balanceOf();
  check('the statement is still the same statement', settledBalance === balanceBefore,
    `${settledBalance} vs ${balanceBefore}`);
  check('rows did not multiply on the way back', settledRows === statementRows,
    `${settledRows} vs ${statementRows}`);
  await p.screenshot({ path: 'shots/hydrate-back.png' });
}

/* ------------------------------------------------ and the list underneath kept its paging */

await p.goBack();
await p.waitForTimeout(2600);
const listBack = await visibleRows();
console.log(`  list on return: ${listBack} rows (was ${afterScroll})`);
check('the paged list came back paged, not reset to page one', listBack >= afterScroll,
  `${listBack} vs ${afterScroll}`);
await p.screenshot({ path: 'shots/hydrate-list.png' });

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
