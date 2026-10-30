/**
 * A CORRECTION AFTER A COUNT ASKS WHETHER THE GOODS MOVED (0263).
 *
 * "We re-edit a receipt and stock is wrong when we cross-check with the physical." A count saw the
 * shelf as it really was, so a receipt from before it, corrected after it, must say whether the goods
 * moved or only the paper was wrong. Walks to the reason page and answers each way. Nothing reaches
 * the shop: the read that decides to ask is supplied, and the save is answered here and read.
 *
 *     node scripts/probe-correction-after-count-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

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

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

let touched = [];
let saved = null;
let saves = 0;
await p.route('**/rest/v1/rpc/correction_touches_a_count*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(touched) }));
await p.route('**/rest/v1/rpc/correct_sale*', (route) => {
  saved = JSON.parse(route.request().postData() ?? '{}');
  saves += 1;
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ sale_id: saved.p_sale_id, revision: 9, total: 0, paid: 0, owing: 0, customer_id: null, voided: false }),
  });
});
const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();

/** From the receipt to the reason page, and press Correct it. */
const press = async () => {
  await top().getByRole('button', { name: /Something on this is wrong/ }).first().click();
  await p.waitForTimeout(6000);
  await p.getByRole('button', { name: /Correct payment/ }).last().click();
  await p.waitForTimeout(6000);
  await top().getByRole('button', { name: /Say why, and finish/ }).last().click();
  await p.waitForTimeout(4000);
  await top().getByLabel(/Why is it being corrected/).fill('Probe: keyed wrongly');
  await top().getByRole('button', { name: /^Correct it$/ }).click();
  await p.waitForTimeout(2500);
};
const asked = () => p.getByText('Did the goods really move?').count();

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(8000);

  await p.locator('button[aria-label="All sales and receipts"]').locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  await top().getByRole('tab', { name: 'Paid', exact: true }).click();
  await p.waitForTimeout(3500);
  await top().getByText(/ items?$/).first().click();
  await p.waitForTimeout(7000);

  // Counted since the sale.
  touched = [{ product_id: '00000000-0000-0000-0000-000000000000', product_name: 'Trophy Bottle (600mL)', stock_change: 12, counted_at: new Date().toISOString() }];
  await press();
  check('it asks, naming the item', (await asked()) > 0 && (await p.getByText(/Trophy Bottle \(600mL\) was counted after this receipt/).count()) > 0);
  check('and nothing is saved until it is answered', saves === 0);

  await p.getByRole('button', { name: 'Go back' }).last().click();
  await p.waitForTimeout(1500);
  check('Go back saves nothing and closes it', saves === 0 && (await asked()) === 0);

  await top().getByRole('button', { name: /^Correct it$/ }).click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: 'Only the paper was wrong' }).click();
  await p.waitForTimeout(4000);
  check('Only the paper was wrong says so to the server', saved?.p_goods_moved === false, String(saved?.p_goods_moved));

  await press();
  await p.getByRole('button', { name: 'Yes, they moved' }).click();
  await p.waitForTimeout(4000);
  check('Yes, they moved says so to the server', saved?.p_goods_moved === true, String(saved?.p_goods_moved));

  // Nothing counted since: no question.
  touched = [];
  await press();
  await p.waitForTimeout(1500);
  check('nothing counted since: it does not ask', (await asked()) === 0 && saves === 3 && saved?.p_goods_moved === null, `saves ${saves}, ${saved?.p_goods_moved}`);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: process.env.TEMP + '/correction-after-count-crash.png' }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n').slice(0, 3).join(' '));
  failed += 1;
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
