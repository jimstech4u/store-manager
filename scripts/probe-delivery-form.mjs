/**
 * Recording a delivery the way a real load arrives — clicked through, then checked in the books.
 *
 * The costing has taken named charges, a rebate and free units since it was rewritten; the FORM
 * only ever offered two fixed fee boxes, so none of it could be entered. This drives the screen
 * and then reads what the shop actually recorded.
 *
 * The sums are the shopkeeper's own:
 *
 *     100 packs at 12,000            = 1,200,000
 *     delivery 15,000 + loading 12,000            +   27,000
 *     rebate                                      −   20,000
 *     7 packs free, so 107 packs arrived
 *     landed per pack = 1,207,000 / 107           =    11,280.37
 *
 *     node scripts/probe-delivery-form.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/delivery-form';
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
const storeId = (await admin.from('stores').select('id').limit(1).single()).data.id;

// An item of this probe's own, so no real stock or cost is disturbed.
const { data: product } = await admin
  .from('products')
  .insert({
    store_id: storeId,
    name: `ZZ Delivery Probe ${stamp}`,
    base_unit: 'piece',
    status: 'active',
  })
  .select('id, name')
  .single();

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

// The nav bar autohides on scroll, and `getByRole(name:)` matches substrings — so tabs are
// matched exactly and scrolled back into view first.
const tab = async (label) => {
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(1000);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(4500);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  await tab('Stock');
  await p.getByRole('button', { name: /record a delivery|receive/i }).first().click();
  await p.waitForTimeout(4000);

  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(3000);

  /*
   * Typed until it sticks.
   *
   * A picker that has only just opened re-renders as its first page of results lands, and the
   * re-render throws away whatever was typed in between. A single `type()` then searches for an
   * empty string and the probe blames the app for finding nothing.
   */
  const search = p.locator('[role="dialog"] input').first();
  const wanted = `ZZ Delivery Probe ${stamp}`;
  for (let i = 0; i < 6; i += 1) {
    await search.click();
    await search.fill(wanted);
    await p.waitForTimeout(1200);
    if ((await search.inputValue()) === wanted) break;
  }
  await p.waitForTimeout(3500);

  const result = p.locator('[role="dialog"] [class*="ProductPicker_name"]').first();
  check('the new item is findable in the picker', (await result.count()) > 0);
  await result.click();
  await p.waitForTimeout(3000);

  console.log('\n— what arrived and what it cost —');
  await p.getByLabel(/How many/i).first().fill('100');
  await p.getByLabel(/Price per/i).first().fill('12000');
  await p.waitForTimeout(800);

  const free = p.getByLabel(/Free, on top/i).first();
  check('free units can be recorded at all', (await free.count()) > 0);
  await free.fill('7');
  await p.waitForTimeout(800);

  /*
   * Every fee goes through the ONE composer.
   *
   * There were two fixed boxes, "Delivery" and "Distribution", because those were the two somebody
   * named first — and nothing could record the loading fee, the union levy or the gate fee a real
   * load also carries. The shop names each one as it adds it now.
   */
  const addFee = async (what, amount) => {
    await p.getByLabel(/What for/i).first().fill(what);
    await p.getByLabel(/How much/i).first().fill(amount);
    await p.getByRole('button', { name: /Add this fee/i }).click();
    await p.waitForTimeout(1200);
  };

  const composer = p.getByLabel(/What for/i).first();
  check('there is one set of fee boxes to fill', (await composer.count()) > 0);

  await addFee('Delivery', '15000');
  await addFee('Loading', '12000');

  const rebateField = p.getByLabel(/Rebate/i).first();
  check('a rebate can be entered', (await rebateField.count()) > 0);
  await rebateField.fill('20000');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${SHOTS}/1-filled.png`, fullPage: false });

  const shown = await p.locator('body').innerText();
  check('the screen lists both fees by name', shown.includes('Loading') && shown.includes('Delivery'));

  console.log('\n— record it —');
  await p.getByRole('button', { name: /record this delivery|save|record/i }).last().click();
  await p.waitForTimeout(9000);
  await p.screenshot({ path: `${SHOTS}/2-done.png` });

  // ── What the shop actually wrote down ─────────────────────────────────────────────
  const { data: lines } = await admin
    .from('purchase_lines')
    .select('entered_qty, free_qty, base_qty, unit_cost_landed, purchase_id')
    .eq('product_id', product.id);

  check('the delivery reached the books', (lines ?? []).length === 1, `${(lines ?? []).length} line(s)`);

  if (lines?.length) {
    const l = lines[0];
    check('100 packs were charged for', Number(l.entered_qty) === 100, `entered ${l.entered_qty}`);
    check('7 free ones were recorded', Number(l.free_qty) === 7, `free ${l.free_qty}`);
    check('107 landed on the shelf', Number(l.base_qty) === 107, `base ${l.base_qty}`);
    check(
      'and each cost 11,280.37 — fees in, rebate off, free ones counted',
      near(l.unit_cost_landed, 11280.37),
      `got ${l.unit_cost_landed}`,
    );

    const { data: chargeRows } = await admin
      .from('purchase_charges')
      .select('label, amount')
      .eq('purchase_id', l.purchase_id);
    check(
      'both fees are stored by name, not folded into a total',
      (chargeRows ?? []).some((c) => c.label === 'Loading' && Number(c.amount) === 12000) &&
        (chargeRows ?? []).some((c) => c.label === 'Delivery' && Number(c.amount) === 15000),
      JSON.stringify(chargeRows),
    );

    const { data: purchase } = await admin
      .from('purchases')
      .select('rebate_amount')
      .eq('id', l.purchase_id)
      .single();
    check('and the rebate too', Number(purchase?.rebate_amount) === 20000, `got ${purchase?.rebate_amount}`);

    await admin.from('stock_layers').delete().eq('product_id', product.id);
    await admin.from('purchase_charges').delete().eq('purchase_id', l.purchase_id);
    await admin.from('purchase_lines').delete().eq('purchase_id', l.purchase_id);
    await admin.from('purchases').delete().eq('id', l.purchase_id);
  }

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  /*
   * The product stays if the ledger recorded against it.
   *
   * `stock_movements` is append-only and refuses deletes — rightly, it is the books — so a
   * delivery that landed cannot be taken back out. The product is retired instead of removed.
   */
  await admin.from('product_units').delete().eq('product_id', product.id);
  await admin.from('product_sale_units').delete().eq('product_id', product.id);
  const gone = await admin.from('products').delete().eq('id', product.id);
  if (gone.error) {
    await admin.from('products').update({ status: 'archived' }).eq('id', product.id);
  }
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
