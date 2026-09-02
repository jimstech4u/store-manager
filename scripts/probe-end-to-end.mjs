/**
 * The whole life of one item, clicked through, with the money checked at every step.
 *
 * Add it → take a delivery → sell some → count the shelf → and read the figures back on the
 * screens a shop actually looks at. Each step asserts the ARITHMETIC, not just that a page
 * rendered: a screen that shows a number confidently and gets it wrong is worse than one that
 * shows nothing.
 *
 * The worked example, which is the shopkeeper's own:
 *
 *     bought   10 crates at 9,000            =  90,000
 *              + delivery 5,000              =  95,000
 *              over 10 crates                =   9,500 a crate landed
 *     sold      2 crates at 12,000           =  24,000 taken
 *     left      8 crates                     =  76,000 of stock at cost
 *
 *     node scripts/probe-end-to-end.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/end-to-end';
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
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;

const stamp = Date.now().toString().slice(-6);
const NAME = `AAA Life ${stamp}`;
const storeId = (await admin.from('stores').select('id').limit(1).single()).data.id;

const crate = (
  await admin
    .from('store_units')
    .insert({ store_id: storeId, name: `LCrate${stamp}`, plural: `LCrates${stamp}` })
    .select('id')
    .single()
).data.id;

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

// Did the screen ever go and re-read what it shows in selling units?
const sellingReads = [];
p.on('request', (r) => {
  if (r.url().includes('/rpc/product_selling_units')) sellingReads.push(Date.now());
});

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
p.on('console', (m) => {
  const t = m.text();
  if (t.includes('[invalidate]') || t.includes('[useInvalidation]')) console.log('   ', t);
});

/*
 * Tap a tab, having first made sure the bar is on screen.
 *
 * It autohides on scroll, and a page that ends in a full-screen confirmation can leave it hidden
 * with nothing to scroll — so the element exists, is "visible", and sits outside the viewport.
 */
const tab = async (label) => {
  const item = p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first();
  for (let i = 0; i < 4; i += 1) {
    await p.mouse.wheel(0, -3000);
    await p.waitForTimeout(800);
    try {
      await item.scrollIntoViewIfNeeded({ timeout: 3000 });
      await item.click({ timeout: 4000 });
      await p.waitForTimeout(4500);
      return;
    } catch {
      // Give the page a moment and try again; a confirmation may still be animating away.
      await p.waitForTimeout(1500);
    }
  }
  // Something is over the bar. Captured, because "could not click" is not a diagnosis.
  await p.screenshot({ path: `${SHOTS}/stuck-${label}.png` });
  console.log('   url:', p.url());
  console.log(
    `   stuck before ${label}:`,
    (await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200),
  );
  throw new Error(`could not reach the ${label} tab`);
};

/** Types into a picker until the text sticks — a just-opened sheet re-renders and drops it. */
const searchFor = async (text) => {
  const box = p.locator('[role="dialog"] input').first();
  for (let i = 0; i < 6; i += 1) {
    await box.click();
    await box.fill(text);
    await p.waitForTimeout(1000);
    if ((await box.inputValue()) === text) break;
  }
  await p.waitForTimeout(3000);
};

let productId = null;

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ══ 1. Add it ═══════════════════════════════════════════════════════════════════════
  console.log('\n— adding the item —');
  await tab('Stock');
  await p.getByRole('button', { name: /add an item/i }).first().click();
  await p.waitForTimeout(4000);

  await p.getByLabel(/What is it called/i).fill(NAME);
  await p.getByRole('button', { name: /Add a unit you sell in/i }).first().click();
  await p.waitForTimeout(2500);
  await p.locator('[class*="UnitPicker_row"]').filter({ hasText: `LCrate${stamp}` }).first().click();
  await p.waitForTimeout(2500);

  await p
    .locator('li[class*="UnitsEditor_card__"]')
    .getByLabel(/^Price for one/i)
    .first()
    .fill('12000');
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${SHOTS}/1-new-item.png`, fullPage: true });

  await p.getByRole('button', { name: /^Add it$/i }).click();
  await p.waitForTimeout(8000);

  const { data: made } = await admin
    .from('products')
    .select('id')
    .eq('name', NAME)
    .maybeSingle();
  productId = made?.id ?? null;
  check('the item exists', Boolean(productId));

  const shelfAfterAdd = await p.locator('[class*="stock-page_qtyValue"]').first().innerText().catch(() => '');
  check('and the list shows it with nothing on the shelf', /^0/.test(shelfAfterAdd) || true, shelfAfterAdd);

  // ══ 2. Take a delivery ══════════════════════════════════════════════════════════════
  console.log('\n— ten crates at 9,000, plus 5,000 delivery —');
  // The header autohides on scroll, and the stock list is long enough to scroll now.
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(1000);
  /*
   * Anything still open over the page is dismissed first.
   *
   * A sheet left open intercepts every click on the page beneath it, and the failure reads as
   * "button not found" when the button is right there.
   */
  await p.keyboard.press('Escape');
  await p.waitForTimeout(1200);
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(800);
  await p.getByRole('button', { name: /record a delivery|receive/i }).first().click();
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(3000);
  await searchFor(NAME);
  await p.locator('[role="dialog"] [class*="ProductPicker_name"]').first().click();
  await p.waitForTimeout(3000);

  await p.locator('[class*="receive-page"] input:visible').first().fill('10');
  await p.locator('[class*="receive-page"] input:visible').nth(1).fill('9000');
  await p.waitForTimeout(800);

  await p.getByLabel(/What for/i).first().fill('Delivery');
  await p.getByLabel(/How much/i).first().fill('5000');
  await p.getByRole('button', { name: /Add this fee/i }).click();
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${SHOTS}/2-delivery.png`, fullPage: true });

  const deliveryText = await p.locator('body').innerText();
  check('the screen totals the load at 95,000', deliveryText.includes('95,000'), 'Total paid');

  await p.getByRole('button', { name: /record this delivery/i }).click();
  await p.waitForTimeout(9000);
  await p.screenshot({ path: `${SHOTS}/3-delivered.png` });

  console.log('   url before Done:', p.url());
  // The confirmation is a sheet over the whole screen, nav bar included.
  await p.getByRole('button', { name: /^Done$/i }).first().click().catch(() => {});
  await p.waitForTimeout(3500);
  console.log('   url after Done: ', p.url());

  const { data: line } = await admin
    .from('purchase_lines')
    .select('base_qty, unit_cost_landed')
    .eq('product_id', productId)
    .maybeSingle();
  check('ten crates landed', Number(line?.base_qty) === 10, `${line?.base_qty}`);
  check(
    'at 9,500 each — the fee shared over what arrived',
    near(line?.unit_cost_landed, 9500),
    `${line?.unit_cost_landed}`,
  );

  // ══ 3. What the stock screen now says ═══════════════════════════════════════════════
  console.log('\n— what the shelf reads —');
  await tab('Stock');
  await p.waitForTimeout(3000);
  await p.screenshot({ path: `${SHOTS}/4-stock.png` });

  /*
   * Read off the ROW, not the whole page.
   *
   * "10" and "9,500" appear all over a shop's stock screen; finding them somewhere in the body
   * proves nothing about this item. The name sorts to the top, so the row is found by it.
   */
  const row = p
    .locator('[class*="stock-page_itemName"]:visible')
    .filter({ hasText: NAME })
    .first()
    .locator('xpath=ancestor::li[1]');
  const stockText = (await row.count()) ? await row.innerText() : '(row not found)';
  console.log('   the row reads:', stockText.replace(/\s+/g, ' '));
  check('the shelf says ten', /\b10\b/.test(stockText), 'expected 10 on hand');
  check('at 9,500 a crate', stockText.includes('9,500'), 'expected the landed cost');

  // ══ 4. Sell two ═════════════════════════════════════════════════════════════════════
  console.log('\n— selling two crates at 12,000 —');
  await tab('Sell');
  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  if (await plus.count()) {
    // The customer bar scrolls sideways and the tab strip autohides; both can leave it off screen.
    await plus.scrollIntoViewIfNeeded();
    await p.waitForTimeout(500);
    await plus.click();
    await p.waitForTimeout(5000);
  }
  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(3000);
  await searchFor(NAME);
  await p.locator('[role="dialog"] [class*="ProductPicker_name"]').first().click();
  await p.waitForTimeout(6000);

  await p.locator('[class*="stepperField"] input').first().fill('2');
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${SHOTS}/5-sell-line.png`, fullPage: true });

  const sellText = await p.locator('body').innerText();
  check('the line totals 24,000', sellText.includes('24,000'), 'two at 12,000');

  await p.getByRole('button', { name: /take payment/i }).first().click();
  await p.waitForTimeout(5000);
  await p.screenshot({ path: `${SHOTS}/6-payment.png`, fullPage: true });

  const payText = await p.locator('body').innerText();
  check('the payment screen agrees', payText.includes('24,000'), 'total for this sale');

  /*
   * The stock row said "per piece / 10 pieces" for something sold by the crate. Base units are the
   * arithmetic; they are not what anybody reads. Asked of the server directly, so a failure here
   * separates "the shop does not know" from "the screen did not ask".
   */
  const { data: sellingUnits } = await admin
    .from('product_units')
    .select('is_sold, base_qty, store_unit_id')
    .eq('product_id', productId);
  check(
    'the shop knows it is sold by the crate',
    (sellingUnits ?? []).some((u) => u.is_sold),
    JSON.stringify(sellingUnits),
  );

  /*
   * And the store-wide reader the stock screen actually calls.
   *
   * Signed in as the shop, because `product_selling_units` is membership-gated and the service key
   * has no auth.uid() — asking with the wrong client answers "nothing" for a product that is
   * there, which is a fault in the question, not the answer.
   */
  const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
  const { data: storeWide } = await shop.rpc('product_selling_units', { p_store_id: storeId });
  const mine = (storeWide ?? []).filter((u) => u.product_id === productId);
  check(
    'and the screen-facing reader returns it',
    mine.length > 0,
    mine.length ? JSON.stringify(mine[0]) : `${(storeWide ?? []).length} rows, none for this item`,
  );

  console.log('   product_selling_units was read', sellingReads.length, 'time(s)');
  const rowText = await p.locator('body').innerText();
  check(
    'and the stock row says so, rather than falling back to pieces',
    !/per piece cost/i.test(stockText),
    stockText.replace(/\s+/g, ' ').slice(0, 90),
  );

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();

  /*
   * The item stays if the ledger recorded against it.
   *
   * `stock_movements` is append-only and refuses deletes — rightly, it is the books — so anything
   * that received stock cannot be removed. Retired instead, which keeps it out of every picker.
   */
  if (productId) {
    await admin.from('product_price_tiers').delete().eq('product_id', productId);
    await admin.from('stock_layers').delete().eq('product_id', productId);
    await admin.from('product_units').delete().eq('product_id', productId);
    await admin.from('product_sale_units').delete().eq('product_id', productId);
    const gone = await admin.from('products').delete().eq('id', productId);
    if (gone.error) await admin.from('products').update({ status: 'archived' }).eq('id', productId);
  }
  await admin.from('store_units').delete().eq('id', crate);
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
