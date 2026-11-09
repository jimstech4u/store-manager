/**
 * AN ITEM SAVED IN STOCK DOES NOT LAND ON THE TILL'S OPEN ORDER.
 *
 * "When we make new products, edit or any operation in stock, it adds that product to the sell page
 * draft order." The till published its "put the new item on this receipt" callback under one shared
 * key for as long as it was open — and it is always open — so every save of the product form found
 * it. Each caller now names its own channel in the push (`then`).
 *
 *   1  the till has an order with one item on it (its own tab, tracked and cancelled at the end);
 *   2  Stock → an existing item → Edit → Save changes, nothing changed;
 *   3  back on the till: still one line.
 *
 *     node scripts/probe-product-save-stays-off-till-ui.mjs [http://localhost:3100]
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
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const PROBE_DRAFTS = trackDrafts(p);
// The till starts a tab of its own rather than touching the shop's real open orders.
await p.route('**/rest/v1/rpc/my_open_drafts*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

const tab = (name) => p.locator('.nav-item').filter({ hasText: new RegExp(`^${name}$`) }).first().click();
const lines = () => p.locator('[class*="SaleLineRow_line__"]').locator('visible=true').count();

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(8000);

  await p.getByRole('button', { name: /Add an item/ }).locator('visible=true').first().click();
  await p.waitForTimeout(1800);
  await p.keyboard.type('Chivita Active');
  await p.waitForTimeout(3000);
  await p.locator('.react-modal-sheet-container').getByText('Chivita Active (1L)', { exact: true }).locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  const before = await lines();
  check('the till has an order with one item', before === 1, `${before} line(s)`);

  await tab('Stock');
  await p.waitForTimeout(5000);
  await p.locator('[class*="stock-page_item__"]').locator('visible=true').nth(1).click();
  await p.waitForTimeout(4000);
  const itemName = await p.locator('h1').locator('visible=true').last().textContent();
  await p.getByRole('button', { name: /edit/i }).locator('visible=true').first().click();
  await p.waitForTimeout(4000);
  const saves = [];
  p.on('request', (r) => { if (/rpc\/(save|update)_product/.test(r.url())) saves.push(r.url()); });
  await p.getByRole('button', { name: 'Save changes' }).locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  check(`"${itemName}" was saved from Stock`, saves.length > 0, `${saves.length} save call(s)`);

  await tab('Sell');
  await p.waitForTimeout(4000);
  const after = await lines();
  check('the till order still has only its one item', after === 1, `${after} line(s)`);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  await p.screenshot({ path: 'shots/probe-product-save-stays-off-till.png' }).catch(() => {});
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
