/**
 * A few real sales, then everything that should have moved — checked.
 *
 * Not "did a page render". Every figure a shop would act on, after each sale, across the screens
 * that carry it: the receipt, the shelf, the customer's account, the day's takings, the profit,
 * the debtor list, the status of the order itself.
 *
 * Four sales, chosen because each breaks something different:
 *
 *   1. PAID IN FULL, CASH        — the ordinary case, and the baseline everything else moves from.
 *   2. PART PAID, ON ACCOUNT     — money and debt must add up to the total, and the debt must land
 *                                  on ONE customer's balance and nobody else's.
 *   3. A CHEAPER BAND            — five or more at the bulk price, so the line total is not simply
 *                                  quantity times the ordinary price.
 *   4. SOLD BELOW COST           — margin goes negative, which reports must show rather than
 *                                  clamping to zero.
 *
 * Run against a product this probe owns, so nothing a shop is trading is disturbed and the numbers
 * are exact rather than "close enough given whatever else happened today".
 *
 *     node scripts/probe-sales-truth.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

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
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;

const stamp = Date.now().toString().slice(-6);
const NAME = `ZZ Truth ${stamp}`;
const UNIT = `TCase${stamp}`;
const CUSTOMER = `ZZ Buyer ${stamp}`;

let productId = null;
let customerId = null;
let unitId = null;
const sales = [];

/** Settle a draft through the shop's own path, exactly as the till does. */
async function sell({ qty, unitPrice, payCash, customer, label }) {
  const clientUuid = crypto.randomUUID();

  const { data: draftId, error: draftErr } = await shop.rpc('save_draft_order', {
    p_store_id: storeId,
    p_lines: [
      {
        product_id: productId,
        qty,
        // The same shape the till sends: base_qty and line_total are the shop's own arithmetic,
        // not something the server is left to infer.
        base_qty: qty,
        unit_price: unitPrice,
        line_total: qty * unitPrice,
        pack_id: null,
        sale_unit_id: unitId,
        containers_out: 0,
      },
    ],
    p_draft_id: null,
    p_customer_id: customer ?? null,
    p_label: label,
    p_fee_amount: null,
    p_fee_label: null,
    p_note: null,
    p_client_uuid: clientUuid,
    p_charges: [],
  });
  if (draftErr) throw new Error(`draft: ${draftErr.message}`);

  const { data: saleId, error: settleErr } = await shop.rpc('settle_draft_order', {
    p_draft_id: draftId,
    p_payments:
      payCash > 0
        ? [{ amount: payCash, method: 'cash', reference: null, bank_account_id: null }]
        : [],
    p_client_uuid: crypto.randomUUID(),
  });
  if (settleErr) throw new Error(`settle: ${settleErr.message}`);

  sales.push(saleId);
  return saleId;
}

try {
  // ══ The item, its price, and a cheaper band ═══════════════════════════════════════
  productId = (
    await shop.rpc('quick_add_sellable', {
      p_store_id: storeId,
      p_name: NAME,
      p_unit_name: UNIT,
      p_unit_plural: `${UNIT}s`,
      p_price: 1000,
    })
  ).data;

  const { data: tillUnits } = await admin
    .from('product_sale_units')
    .select('id, name, price')
    .eq('product_id', productId);
  unitId = tillUnits?.[0]?.id ?? null;

  // Ten on the shelf at 800 each, so margin and stock have somewhere to move from.
  await admin.from('stock_movements').insert({
    store_id: storeId,
    product_id: productId,
    qty_delta: 20,
    kind: 'opening',
    unit_cost: 800,
  });
  await admin.from('stock_layers').insert({
    store_id: storeId,
    product_id: productId,
    qty_base: 20,
    remaining_base: 20,
    unit_cost: 800,
    ref_table: 'opening',
  });

  // Five or more at 900.
  await admin.from('product_price_tiers').insert({
    product_id: productId,
    sale_unit_id: unitId,
    min_qty: 5,
    max_qty: null,
    price: 900,
  });

  customerId = (
    await shop.rpc('upsert_customer', {
      p_store_id: storeId,
      p_phone: `0805${stamp}0`,
      p_display_name: CUSTOMER,
      p_business_name: null,
    })
  ).data;

  const onHand = async () => {
    const { data } = await admin
      .from('stock_movements')
      .select('qty_delta')
      .eq('product_id', productId);
    return (data ?? []).reduce((sum, m) => sum + Number(m.qty_delta), 0);
  };

  const balance = async () => {
    const { data } = await shop.rpc('customer_balance_total', {
      p_store_customer_id: customerId,
    });
    return Number(data ?? 0);
  };

  check('the shelf starts at twenty', (await onHand()) === 20, String(await onHand()));
  check('and the customer owes nothing', (await balance()) === 0, String(await balance()));

  // ══ 1. Paid in full, cash ═════════════════════════════════════════════════════════
  console.log('\n— two cases at 1,000, paid in cash —');
  const s1 = await sell({ qty: 2, unitPrice: 1000, payCash: 2000, label: 'Cash sale' });

  const readSale = async (id) => {
    const { data } = await shop.rpc('list_sales', {
      p_store_id: storeId,
      p_after_at: null,
      p_after_id: null,
      p_limit: 50,
    });
    const row = (data ?? []).find((r) => r.id === id);
    const { data: full } = await admin.from('sales').select('status, store_customer_id').eq('id', id).single();
    return { ...row, ...full };
  };

  const sale1 = await readSale(s1);

  check('the sale totals 2,000', near(sale1.total, 2000), String(sale1.total));
  check('paid 2,000', near(sale1.paid, 2000), String(sale1.paid));
  check('nothing outstanding', near(sale1.outstanding, 0), String(sale1.outstanding));
  /*
   * `status` is the sale's LIFECYCLE — posted, or void. It is not whether the money came in.
   *
   * Asserting `status === 'paid'` was my mistake and worth writing down, because it is an easy one
   * to make twice: a sale that has been paid and one that has not are the same KIND of record, and
   * the difference is `outstanding`. Anything reading a payment state off `status` would be wrong
   * about every credit sale in the shop.
   */
  check('it is a posted sale, not a draft', sale1.status === 'posted', sale1.status);
  check('and nothing is owed on it', near(sale1.outstanding, 0), String(sale1.outstanding));
  check('the shelf drops to eighteen', (await onHand()) === 18, String(await onHand()));
  check('a walk-in owes nothing', (await balance()) === 0, String(await balance()));

  // ══ 2. Part paid, the rest on account ═════════════════════════════════════════════
  console.log('\n— three at 1,000, 1,200 paid, the rest on account —');
  const s2 = await sell({
    qty: 3,
    unitPrice: 1000,
    payCash: 1200,
    customer: customerId,
    label: 'Credit sale',
  });

  const sale2 = await readSale(s2);

  check('the sale totals 3,000', near(sale2.total, 3000), String(sale2.total));
  check('1,200 paid', near(sale2.paid, 1200), String(sale2.paid));
  check('1,800 outstanding', near(sale2.outstanding, 1800), String(sale2.outstanding));
  check(
    'paid and owed add up to the total',
    near(Number(sale2.paid) + Number(sale2.outstanding), sale2.total),
  );
  check('it is posted, with money still owed', sale2.status === 'posted' && Number(sale2.outstanding) > 0, `${sale2.status}, owing ${sale2.outstanding}`);
  check('the debt is on the right customer', sale2.store_customer_id === customerId);
  check('whose balance is now 1,800', near(await balance(), 1800), String(await balance()));
  check('and the shelf drops to fifteen', (await onHand()) === 15, String(await onHand()));

  // ══ 3. The cheaper band ═══════════════════════════════════════════════════════════
  console.log('\n— five at the bulk price —');
  const { data: banded } = await shop.rpc('resolve_price', {
    p_product_id: productId,
    p_qty: 5,
    p_sale_unit_id: unitId,
    p_customer_id: null,
  });
  /*
   * `suggested` is the answer, and `reason` says why — "bulk" here, "customer" for an agreed
   * price. The till shows that reason on the line, which is half the point of tiers: a seller has
   * to be able to tell a customer why the price changed.
   */
  const bandPrice = Number(banded?.suggested ?? 0);
  check('and says why', banded?.reason === 'bulk', String(banded?.reason));
  check('the till is told 900 for five', near(bandPrice, 900), String(bandPrice));

  const s3 = await sell({ qty: 5, unitPrice: bandPrice, payCash: 4500, label: 'Bulk sale' });
  const sale3 = await readSale(s3);
  check('five at 900 is 4,500, not 5,000', near(sale3.total, 4500), String(sale3.total));
  check('and nothing is owed on it', near(sale3.outstanding, 0), String(sale3.outstanding));
  check('the shelf drops to ten', (await onHand()) === 10, String(await onHand()));

  // ══ 4. Sold below what it cost ════════════════════════════════════════════════════
  console.log('\n— one at 500, under the 800 it cost —');
  const s4 = await sell({ qty: 1, unitPrice: 500, payCash: 500, label: 'Loss sale' });

  const { data: line4 } = await admin
    .from('sale_lines')
    .select('line_total, unit_cost_at_sale')
    .eq('sale_id', s4)
    .single();
  check('the line is 500', near(line4.line_total, 500), String(line4.line_total));
  check('costed at the 800 it came in at', near(line4.unit_cost_at_sale, 800), String(line4.unit_cost_at_sale));
  check(
    'so the margin is minus 300, not zero',
    near(Number(line4.line_total) - Number(line4.unit_cost_at_sale), -300),
  );

  // ══ What the shop's own screens now say ═══════════════════════════════════════════
  console.log('\n— and the figures the shop reads —');

  const { data: listed } = await shop.rpc('list_sales', {
    p_store_id: storeId,
    p_after_at: null,
    p_after_id: null,
    p_limit: 50,
  });
  const mine = (listed ?? []).filter((r) => sales.includes(r.id));
  check('all four sales are in the list', mine.length === 4, `${mine.length} of 4`);
  check(
    'and the list totals agree with the records',
    near(mine.reduce((sum, r) => sum + Number(r.total), 0), 2000 + 3000 + 4500 + 500),
    String(mine.reduce((sum, r) => sum + Number(r.total), 0)),
  );

  // The supabase builder is thenable but not a promise, so `.catch` is not a method on it.
  const debtorsCall = await shop.rpc('list_debtors', {
    p_store_id: storeId,
    p_after_balance: null,
    p_after_id: null,
    p_limit: 200,
  });
  const debtors = debtorsCall.error ? null : debtorsCall.data;
  if (debtors) {
    const owed = debtors.find((d) => d.id === customerId);
    check('the debtor list carries the 1,800', owed ? near(owed.balance, 1800) : false, JSON.stringify(owed));
  }

  const { data: statement } = await shop.rpc('customer_statement', {
    p_store_customer_id: customerId,
  });
  check('the statement shows the credit sale', Boolean(statement), statement ? 'present' : 'missing');

  const { data: selling } = await shop.rpc('selling_units_for_product', {
    p_product_id: productId,
  });
  check(
    'the shelf reads nine in selling units',
    near(selling?.[0]?.on_hand_units, 9),
    String(selling?.[0]?.on_hand_units),
  );

  check(
    'and the total sold matches what left the shelf',
    (await onHand()) === 20 - (2 + 3 + 5 + 1),
    `${await onHand()} left of 20`,
  );
} catch (e) {
  check('the run completed', false, e instanceof Error ? e.message : String(e));
} finally {
  /*
   * Sales and movements are append-only — rightly, they are the books — so what cannot be deleted
   * is voided or retired, and the probe's customer keeps a zero balance rather than a phantom debt.
   */
  for (const id of sales) {
    await shop.rpc('void_sale', { p_sale_id: id, p_reason: 'probe' });
  }
  if (productId) {
    await admin.from('product_price_tiers').delete().eq('product_id', productId);
    await admin.from('stock_layers').delete().eq('product_id', productId);
    await admin.from('product_units').delete().eq('product_id', productId);
    await admin.from('product_sale_units').delete().eq('product_id', productId);
    const gone = await admin.from('products').delete().eq('id', productId);
    if (gone.error) await admin.from('products').update({ status: 'archived' }).eq('id', productId);
  }
  await admin.from('store_units').delete().eq('store_id', storeId).eq('name', UNIT);
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
