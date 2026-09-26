/**
 * CORRECTING A RECEIPT, WALKED THE WAY A SHOP WALKS IT.
 *
 * The flow asked for: «correct this receipt (using the sell-page add item(scan barcode) to add more
 * and the same way we remove, edit product, price and all) -> so now we have floating button
 * (correct payment) -> then now to reason and then the receipt page».
 *
 * Three screens and a shared working state. The server half is covered by
 * probe-correct-the-money.mjs; this is the part a type-check cannot see — that the screens exist,
 * carry the correction between them, and end with a changed receipt.
 *
 * WHAT IT CHECKS, in the order a seller meets it:
 *
 *   · a settled receipt offers a correction
 *   · the correction screen is the TILL — the item rows, and both ways to add another
 *   · the customer is shown and NOT offered as something to change
 *   · the floating button says "Correct payment", not "Take payment"
 *   · the reason comes after the money, not before
 *   · and the receipt that results actually changed, in the shop, with the reason recorded
 *
 *     node scripts/probe-correct-the-receipt.mjs [http://localhost:3101]
 */
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

const stamp = Date.now().toString().slice(-6);
let saleId = null;
let customerId = null;

/* A receipt to correct, made the ordinary way so the screens meet a real one. */
const { data: shapes } = await admin
  .from('product_units')
  .select('id, product_id, base_qty, products!inner(name, store_id, status)')
  .eq('is_sold', true).eq('products.store_id', storeId).eq('products.status', 'active')
  .limit(1);
const shape = (shapes ?? [])[0];
if (!shape) throw new Error('nothing sellable in this shop');

const { error: ce } = await shop.rpc('count_from_till', {
  p_product_id: shape.product_id,
  p_counted: ((await admin.from('stock_movements').select('qty_delta').eq('product_id', shape.product_id)).data ?? [])
    .reduce((s, m) => s + Number(m.qty_delta), 0),
});
if (ce && !/already/i.test(ce.message)) throw new Error(ce.message);

const { data: cid } = await shop.rpc('upsert_customer', {
  p_store_id: storeId, p_phone: `0809${stamp}1`, p_display_name: `ZZ Correct UI ${stamp}`,
});
customerId = cid;

{
  const uuid = crypto.randomUUID();
  const { data: draft } = await shop.rpc('save_draft_order', {
    p_store_id: storeId, p_draft_id: null, p_customer_id: customerId, p_label: null,
    p_fee_amount: 0, p_fee_label: null, p_charges: [], p_note: `ui-probe ${stamp}`,
    p_client_uuid: uuid,
    p_lines: [{
      product_id: shape.product_id, qty: 2, pack_id: null, sale_unit_id: shape.id,
      base_qty: 2 * Number(shape.base_qty || 1), unit_price: 5000, line_total: 10000,
      containers_out: 0, deposit_charged: 0,
    }],
  });
  await shop.rpc('settle_draft_order', { p_draft_id: draft, p_payments: [{ method: 'cash', amount: 10000 }], p_client_uuid: uuid });
  const { data: row } = await admin.from('sales').select('id').eq('client_uuid', uuid).maybeSingle();
  saleId = row.id;
}
console.log(`  receipt: ${saleId}`);

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
try {
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.locator('.nav-item').first().waitFor({ state: 'visible', timeout: 180000 });
  await p.waitForTimeout(4000);

  // Money → the sales list → this receipt.
  await p.getByRole('button', { name: 'Money', exact: true }).first().click();
  await p.waitForTimeout(3000);
  await p.getByRole('button', { name: 'All sales and receipts' }).first().click();
  await p.waitForTimeout(6000);
  await p.locator('[class*="rowLink"]:visible, li:visible button:visible').filter({ hasText: /₦/ }).first().click();
  await p.waitForTimeout(7000);

  const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

  const correct = p.locator('button:visible').filter({ hasText: /Something on this is wrong/i }).first();
  check('a receipt offers a correction', (await correct.count()) > 0, (await body()).slice(0, 110));
  await correct.click();
  await p.waitForTimeout(7000);

  // ── The correction screen IS the till ──────────────────────────────────────
  const rows = p.locator('[class*="SaleLineRow_line__"]:visible');
  check('the items are the tillrows, editable', (await rows.count()) > 0, `${await rows.count()} rows`);
  const text = await body();
  check('and both ways to add another are offered', /Add an item/i.test(text) && /Scan a barcode/i.test(text));

  /*
   * THE CUSTOMER IS SHOWN, NOT OFFERED. A receipt belongs to whoever it was made out to, and a
   * correction that could move it would move the debt to somebody who never took the goods.
   */
  check('the customer is named', /For /i.test(text), text.slice(0, 140));
  check(
    'and is not offered as something to change',
    !/Change customer|Choose a customer/i.test(text),
  );

  // ── Editing a line, the same way the till does ────────────────────────────
  const qty = rows.first().locator('[class*="stepperField"] input').first();
  await qty.fill('3');
  await qty.blur();
  await p.waitForTimeout(2500);

  const pill = p.locator('[class*="FloatingAmount_pill__"]:visible').first();
  const pillSays = (await pill.innerText()).replace(/\s+/g, ' ');
  check('the floating button says Correct payment', /Correct payment/i.test(pillSays), pillSays);
  check('and not Take payment', !/Take payment/i.test(pillSays), pillSays);
  check('it carries the corrected total', /15,000/.test(pillSays), pillSays);
  await p.screenshot({ path: 'shots/probe-correct-items.png', fullPage: true });

  await pill.click();
  await p.waitForTimeout(7000);

  // ── The money ──────────────────────────────────────────────────────────────
  const payText = await body();
  check('the payment screen opened', /Correct payment|Cash, transfer/i.test(payText), payText.slice(0, 110));
  check('it says what changed', /more than it said|less than it said|has not changed/i.test(payText), payText.slice(0, 160));

  const amount = p.locator('[class*="payBox"] input[inputmode="decimal"]').first();
  await amount.fill('5000');
  await amount.blur();
  await p.waitForTimeout(2500);

  const commit = p.locator('[class*="pageActions"] button:visible').first();
  const commitSays = (await commit.innerText()).replace(/\s+/g, ' ');
  check('the button sends them on to say why', /Say why/i.test(commitSays), commitSays);
  await commit.click();
  await p.waitForTimeout(7000);

  // ── The reason, LAST ───────────────────────────────────────────────────────
  const reasonText = await body();
  check('the reason is asked after the money', /Why is it being corrected/i.test(reasonText), reasonText.slice(0, 110));
  check('and it shows what it will say', /It will say/i.test(reasonText));

  const why = p.getByLabel(/Why is it being corrected/i).first();
  await why.fill('A third crate went out and was never keyed');
  await p.waitForTimeout(800);
  await p.getByRole('button', { name: /^Correct it$/ }).first().click();
  await p.waitForTimeout(14000);

  check('it lands on the receipt', /Receipt|Sale recorded/i.test(await body()), (await body()).slice(0, 110));
  await p.screenshot({ path: 'shots/probe-correct-done.png', fullPage: true });

  // ── And the shop actually has the change ──────────────────────────────────
  const { data: after } = await admin.from('sales').select('total,revision,amend_reason').eq('id', saleId).single();
  check('the receipt says the bigger figure', Math.abs(Number(after.total) - 15000) < 0.005, String(after.total));
  check('it kept its number and gained a revision', Number(after.revision) > 1, String(after.revision));
  check('and the reason was recorded', /never keyed/i.test(after.amend_reason ?? ''), String(after.amend_reason));

  const { data: allocs } = await admin.from('payment_allocations').select('amount').eq('sale_id', saleId);
  check(
    'the money taken during the correction reached this receipt',
    Math.abs((allocs ?? []).reduce((s, a) => s + Number(a.amount), 0) - 15000) < 0.005,
    JSON.stringify(allocs),
  );
} catch (e) {
  check('the probe ran to the end', false, String(e).split('\n')[0]);
  await p.screenshot({ path: 'shots/probe-correct-stopped.png', fullPage: true }).catch(() => {});
} finally {
  await b.close();
  // Voided, not deleted, and the probe's own money taken back out.
  if (saleId) {
    const { data: s } = await admin.from('sales').select('status').eq('id', saleId).maybeSingle();
    if (s?.status === 'posted') await shop.rpc('void_sale', { p_sale_id: saleId, p_reason: 'probe cleanup' });
  }
  if (customerId) {
    const { data: mine } = await admin.from('payments').select('id').eq('store_customer_id', customerId);
    for (const row of mine ?? []) {
      await admin.from('payment_allocations').delete().eq('payment_id', row.id);
      await admin.from('payments').delete().eq('id', row.id);
    }
    const left = Number((await shop.rpc('customer_balance', { p_store_customer_id: customerId })).data) || 0;
    check('the probe leaves no money behind', Math.abs(left) < 0.005, String(left));
    await admin.from('store_customers').update({ status: 'archived' }).eq('id', customerId);
  }
  console.log(failed === 0 ? '\n  all good' : '\n  ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
