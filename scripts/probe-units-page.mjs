/**
 * "How you buy and sell it" — clicked through in a real browser.
 *
 * The RPC probe proves the rule holds in the database. This proves a shopkeeper can actually reach
 * it: that the screen opens, that the compulsory question appears when a unit arrives in a shape
 * nothing is sold in, that Save is refused until it is answered, and that answering it lets the
 * save through.
 *
 *     node scripts/probe-units-page.mjs [http://localhost:3100]
 *
 * Screenshots land in the scratchpad so the result can be looked at, not just believed.
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS = 'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/units-page';
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

const stamp = Date.now().toString().slice(-6);

// ── An item of this probe's own, so nothing the shop sells is disturbed ──────────────────────
const storeId = (
  await admin.from('stores').select('id').limit(1).single()
).data.id;

const { data: product } = await admin
  .from('products')
  .insert({ store_id: storeId, name: `ZZ Probe Oil ${stamp}`, base_unit: 'litre', status: 'active' })
  .select('id, name')
  .single();

const litre = (
  await admin
    .from('store_units')
    .insert({ store_id: storeId, name: `PLitre${stamp}`, plural: `PLitres${stamp}` })
    .select('id')
    .single()
).data.id;
const bag = (
  await admin
    .from('store_units')
    .insert({ store_id: storeId, name: `PBag${stamp}`, plural: `PBags${stamp}` })
    .select('id')
    .single()
).data.id;

// Sold by the litre; arrives in bags, with nobody having said what a bag holds. The state the
// screen exists to get a shop out of.
await admin.from('product_units').insert([
  { product_id: product.id, store_unit_id: litre, base_qty: 1, is_bought: true, is_sold: true, sell_price: 1200, sort_order: 0 },
  { product_id: product.id, store_unit_id: bag, base_qty: 1, is_bought: true, is_sold: false, sort_order: 1 },
]);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await page.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(12000);

  /*
   * NAVIGATED BY TAPPING, not by URL.
   *
   * The stacks own their own routing — the address after signing in is `/main?group=sell-stack`,
   * and there is no `/main/stock` to go to. Typing one produced a 404 the probe cheerfully
   * screenshotted and called a missing warning.
   */
  await page.getByRole('button', { name: 'Stock' }).first().click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${SHOTS}/1-stock.png`, fullPage: false });

  const stockWarning = page.getByText(/come in but never go out/i);
  check('the stock screen warns about stranded stock', (await stockWarning.count()) > 0);

  // ── Open the item ──────────────────────────────────────────────────────────────────
  // Searched rather than scrolled to: the list pages, and this probe's item sorts last.
  const search = page.getByPlaceholder(/search/i).first();
  if (await search.count()) {
    await search.click();
    await page.waitForTimeout(500);
    await page.keyboard.type(`ZZ Probe Oil ${stamp}`, { delay: 40 });
    await page.waitForTimeout(4000);
  }
  await page.getByText(product.name).first().click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/2-product.png` });

  const opener = page.getByText('How you buy and sell it').first();
  check('the item offers a way in', (await opener.count()) > 0);
  await opener.click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/3-units.png`, fullPage: true });

  check(
    'the compulsory question is on screen',
    (await page.getByText(/One pbag/i).count()) > 0,
    'expected "One pbag… is [ ] plitres"',
  );
  check(
    'and it says what happens if it is skipped',
    (await page.getByText(/can never be sold|never go out/i).count()) > 0,
  );

  const save = page.getByRole('button', { name: 'Save' }).first();
  check('Save is refused while the question stands', await save.isDisabled());

  // ── Answer it: one bag is 24 litres ────────────────────────────────────────────────
  /*
   * The box inside the sentence, not "the last numeric input on the page".
   *
   * Pushed-under pages stay mounted in a navigation stack, so `.last()` found a customer's phone
   * number on a screen two pushes down and sat waiting for an invisible element to become
   * editable.
   */
  const answer = page.locator('[class*="units-page_sentence"] input').first();
  await answer.fill('24');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/4-answered.png`, fullPage: true });

  check('Save opens up once it is answered', !(await save.isDisabled()));

  await save.click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${SHOTS}/5-saved.png` });

  const { data: after } = await admin
    .from('product_units')
    .select('base_qty, defined_qty, store_unit_id')
    .eq('product_id', product.id);
  const savedBag = after.find((u) => u.store_unit_id === bag);

  check("the shop's answer reached the database", Number(savedBag?.defined_qty) === 24, `defined_qty ${savedBag?.defined_qty}`);
  check('and a bag is now worth 24 litres', Number(savedBag?.base_qty) === 24, `base_qty ${savedBag?.base_qty}`);

  const { data: gaps } = await admin.rpc('unit_gaps_unchecked', { p_product_id: product.id });
  check('nothing is stranded any more', (gaps ?? []).length === 0);
} finally {
  await browser.close();
  await admin.from('product_units').delete().eq('product_id', product.id);
  await admin.from('product_sale_units').delete().eq('product_id', product.id);
  await admin.from('products').delete().eq('id', product.id);
  await admin.from('store_units').delete().in('id', [litre, bag]);
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
