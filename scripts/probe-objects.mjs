/**
 * The three changes from this round, clicked through:
 *
 *   1. "Add an item you sell" is a PAGE (back arrow, own URL), not a bottom sheet.
 *   2. "Record a delivery" picks items with the same SelectionViewer the sell screen uses.
 *   3. A push carries an ID only — the pushed page resolves the record through provideObject,
 *      and still works when nothing has published anything (a cold deep link).
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
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('  PAGEERROR:', e.message.split('\n')[0]));

const login = async (page) => {
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
  await page
    .locator('input[type="password"]')
    .first()
    .evaluate((el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, env('SAMPLE_PASSWORD'));
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(9000);
};

const revealBar = async (page) => {
  await page.evaluate(() => {
    document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 120; });
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 0; });
  });
  await page.waitForTimeout(900);
};

await login(p);
await revealBar(p);

/* ------------------------------------------------ 1. the add-item form is a page ------------- */

await p.getByRole('button', { name: 'Stock', exact: true }).first().click();
await p.waitForTimeout(2600);

await p.getByRole('button', { name: 'Add an item you sell' }).first().click();
await p.waitForTimeout(2200);
await p.screenshot({ path: 'shots/objects-add-page.png' });

const url = p.url();
const body = await p.locator('body').innerText();
/*
 * Depth in the nav param, not the route name.
 *
 * The stack serialises entries compactly — `stock-stack:1.a1.d1`, one segment per entry — so a
 * pushed page shows as an extra dot-segment, never as its route key. Asserting on the key made
 * this fail against a page that had pushed perfectly.
 */
const depthOf = (u, stack) => {
  const m = decodeURIComponent(u).match(new RegExp(`${stack}:([^|&]*)`));
  return m ? m[1].split('.').length : 0;
};
check('the add form is a pushed page, not a sheet', depthOf(url, 'stock-stack') > 2,
  decodeURIComponent(url).split('nav=')[1] ?? url);
check('it shows the form', /What is it called|How do you count it/.test(body));

// A page has a back arrow. A sheet does not.
const back = p.locator('button[aria-label="Back"]:visible, button[aria-label="Go back"]:visible').first();
check('it has a back arrow', (await back.count()) > 0);

// And nothing behind it is reachable — a page replaces, it does not overlay.
await p.goBack();
await p.waitForTimeout(2200);
check('back returns to the stock list', /Stock|Search your stock/.test(await p.locator('body').innerText()));

/* ---------------------------------- 2. the delivery picker is the shared selection viewer ----- */

await p.getByRole('button', { name: 'Record a delivery' }).first().click();
await p.waitForTimeout(2400);

const addItem = p.locator('button:visible').filter({ hasText: /add an item|what came in/i }).first();
if (await addItem.count()) {
  await addItem.click();
  await p.waitForTimeout(2200);
  await p.screenshot({ path: 'shots/objects-delivery-picker.png' });

  // The selection viewer renders a drag handle and its own search — the old BottomSheet did not.
  const isViewer = await p.evaluate(() =>
    Boolean(document.querySelector('[class*="selection"], [data-selection-viewer], [class*="SelectionViewer"]')),
  );
  const pickerBody = await p.locator('body').innerText();
  check('the delivery picker opened', /what came in|search products/i.test(pickerBody));
  check('it is the selection viewer, not the old sheet', isViewer);

  // Typing must not close it — the exact failure the old sheet had.
  const search = p.locator('input:visible').last();
  await search.fill('co');
  await p.waitForTimeout(1800);
  const stillOpen = /what came in|search products/i.test(await p.locator('body').innerText());
  check('typing does not close it', stillOpen);
  await p.screenshot({ path: 'shots/objects-delivery-typed.png' });

  /*
   * AND IT MUST ACTUALLY FILTER.
   *
   * The first version of this probe only checked the sheet stayed open, and passed while the
   * picker was returning the previous search's rows — "co" listed Eva Water, Goldberg and Trophy.
   * Staying open is worthless if the results are somebody else's answer.
   */
  const names = await p.locator('[class*="ProductPicker_name"]:visible').allInnerTexts();
  const matching = names.filter((n) => n.toLowerCase().includes('co'));
  console.log('   results for "co":', names.slice(0, 6).join(' | '));
  check('the results actually match what was typed', names.length > 0 && matching.length === names.length,
    `${matching.length}/${names.length} contain "co"`);
} else {
  check('the delivery picker opened', false, 'no add-item control found');
}

/* --------------------------------- 3. a push carries an id, and a cold link still works ------- */

await p.goto(BASE + '/main', { waitUntil: 'networkidle' });
await p.waitForTimeout(6000);
await revealBar(p);
await p.getByRole('button', { name: 'Money', exact: true }).first().click();
await p.waitForTimeout(2800);

const card = p.locator('[class*="rowLink"]:visible').first();
const listName = (await card.innerText()).split('\n')[0];
await card.click();
await p.waitForTimeout(3000);

const statementUrl = p.url();
const title = await p.locator('h1:visible').first().innerText().catch(() => '');
console.log(`  list said "${listName}", statement title "${title}"`);
check('the URL carries no customer name', !/name=/.test(decodeURIComponent(statementUrl)));
check('the title still resolves, via provideObject', title.trim() === listName.trim(), `${title} vs ${listName}`);
await p.screenshot({ path: 'shots/objects-statement.png' });

/*
 * THE COLD DEEP LINK — the case a getter cannot cover.
 *
 * A brand-new browser context: nothing has been published, `isProvided` is false, and the page has
 * only the id from the URL. If the title falls back to "Customer" here, the fallback read is not
 * working and every pasted link is broken.
 */
const cold = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
await login(cold);
await cold.goto(BASE + statementUrl.slice(statementUrl.indexOf('/main')), { waitUntil: 'networkidle' });
await cold.waitForTimeout(7000);
const coldTitle = await cold.locator('h1:visible').first().innerText().catch(() => '');
console.log('  cold deep link title:', coldTitle);
check('a cold deep link still names the customer', coldTitle.trim() === listName.trim(), `${coldTitle} vs ${listName}`);
await cold.screenshot({ path: 'shots/objects-cold-link.png' });

await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
