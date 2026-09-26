/**
 * A CORRECTION REACHES THE MONEY, AND A CANCELLATION CAN BE UNDONE.
 *
 * Asked for as «floating button (correct payment, not longer take payment, also a way to edit the
 * payment, charges, deposit and all)» and «even void, even in void open back, with version and
 * permission and then history».
 *
 * `amend_sale` took lines and a customer and nothing else, so the correction screen could only ever
 * have changed WHAT was sold while the money went untouched — and a seller who finds a crate that
 * went out unkeyed is standing in front of somebody paying the difference. 0178 gives it charges,
 * payments and a deposit. 0179 adds `reopen_sale`, the exact inverse of `void_sale`.
 *
 * Every one of these is a write to a ledger that must net out, so every check here reads the ledger
 * back rather than trusting what the function returned.
 *
 *     node scripts/probe-correct-the-money.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const NL = String.fromCharCode(10);
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const stamp = Date.now().toString().slice(-6);
const made = [];
let customerId = null;
let shape = null;

const sell = async ({ qty, price, paid }) => {
  const uuid = crypto.randomUUID();
  const { data: draft, error: de } = await shop.rpc('save_draft_order', {
    p_store_id: storeId,
    p_draft_id: null,
    p_customer_id: customerId,
    p_label: null,
    p_fee_amount: 0,
    p_fee_label: null,
    p_charges: [],
    p_note: `money-probe ${stamp}`,
    p_client_uuid: uuid,
    p_lines: [{
      product_id: shape.product_id, qty, pack_id: null, sale_unit_id: shape.id,
      base_qty: qty * Number(shape.base_qty || 1), unit_price: price,
      line_total: qty * price, containers_out: qty, deposit_charged: 0,
    }],
  });
  if (de) throw new Error(de.message);
  const { error: se } = await shop.rpc('settle_draft_order', {
    p_draft_id: draft,
    p_payments: paid > 0 ? [{ method: 'cash', amount: paid }] : [],
    p_client_uuid: uuid,
  });
  if (se) throw new Error(se.message);
  const { data: row } = await admin.from('sales').select('id').eq('client_uuid', uuid).maybeSingle();
  made.push(row.id);
  return row.id;
};

const sameLines = (qty, price) => [{
  product_id: shape.product_id, sale_unit_id: shape.id, entered_qty: qty,
  base_qty: qty * Number(shape.base_qty || 1), unit_price: price,
  line_total: qty * price, containers_out: qty,
}];

const onHand = async () =>
  ((await admin.from('stock_movements').select('qty_delta').eq('product_id', shape.product_id)).data ?? [])
    .reduce((s, m) => s + Number(m.qty_delta), 0);
const owed = async () => Number((await shop.rpc('customer_balance', { p_store_customer_id: customerId })).data) || 0;
const containers = async () => {
  const { data } = await shop.rpc('customer_empties_owed', { p_store_customer_id: customerId });
  return (data ?? []).filter((r) => r.side === 'they_hold').reduce((s, r) => s + Number(r.owed || 0), 0);
};
const allocated = async (saleId) =>
  ((await admin.from('payment_allocations').select('amount').eq('sale_id', saleId)).data ?? [])
    .reduce((s, a) => s + Number(a.amount), 0);

try {
  const { data: shapes } = await admin
    .from('product_units')
    .select('id, product_id, base_qty, is_returnable, products!inner(name, store_id, status)')
    .eq('is_sold', true).eq('is_returnable', true)
    .eq('products.store_id', storeId).eq('products.status', 'active')
    .limit(1);
  shape = (shapes ?? [])[0];
  if (!shape) throw new Error('no returnable sellable shape');
  console.log(`  selling: ${shape.products.name}`);

  const { error: ce } = await shop.rpc('count_from_till', {
    p_product_id: shape.product_id,
    p_counted: await onHand(),
  });
  if (ce && !/already/i.test(ce.message)) throw new Error(ce.message);

  const { data: cid } = await shop.rpc('upsert_customer', {
    p_store_id: storeId, p_phone: `0807${stamp}1`, p_display_name: `ZZ Money ${stamp}`,
  });
  customerId = cid;

  // ── Paying the difference during the correction ────────────────────────────
  console.log(NL + '— the customer pays the difference there and then —');
  {
    const saleId = await sell({ qty: 2, price: 5000, paid: 10000 });
    const owedBefore = await owed();

    const { data: res, error } = await shop.rpc('amend_sale', {
      p_sale_id: saleId,
      p_reason: 'A third crate went out and was never keyed',
      p_lines: sameLines(3, 5000),
      p_customer_id: customerId,
      p_payments: [{ method: 'cash', amount: 5000 }],
    });
    check('a payment can be taken while correcting', !error, error?.message ?? '');
    check('the receipt is now the bigger figure', Number(res?.total) === 15000, String(res?.total));
    check('the money handed over is counted', Number(res?.paid) === 15000, String(res?.paid));
    check('so nothing is left owing on it', Number(res?.owing) === 0, String(res?.owing));

    /*
     * THE ALLOCATION IS THE HALF THAT GETS FORGOTTEN. `payments` has no sale_id, so a payment row
     * with no allocation is money that exists unattached while the receipt still reads as owing —
     * and the customer gets chased for what they already handed over.
     */
    check(
      'and it is allocated to this receipt, not left loose',
      Math.abs((await allocated(saleId)) - 15000) < 0.005,
      String(await allocated(saleId)),
    );
    check(
      "the customer's balance did not move: they paid what they owed",
      Math.abs((await owed()) - owedBefore) < 0.005,
      `${owedBefore} → ${await owed()}`,
    );
  }

  // ── Charges, replaced rather than merged ───────────────────────────────────
  console.log(NL + '— the transport that was forgotten, and then removed —');
  {
    const saleId = await sell({ qty: 1, price: 4000, paid: 0 });
    const { data: res } = await shop.rpc('amend_sale', {
      p_sale_id: saleId,
      p_reason: 'Transport was never added',
      p_lines: sameLines(1, 4000),
      p_customer_id: customerId,
      p_charges: [{ label: 'Transport', amount: 1500 }],
    });
    check('a charge can be added while correcting', Number(res?.total) === 5500, String(res?.total));
    const { data: charges } = await admin.from('sale_charges').select('label,amount').eq('sale_id', saleId);
    check('and it is itemised, not lumped', (charges ?? []).length === 1 && charges[0].label === 'Transport', JSON.stringify(charges));

    /*
     * AN EMPTY LIST MEANS "THERE ARE NONE", which is a different instruction from null. It is what
     * a seller gives by deleting the last charge, and merging would make that impossible.
     */
    const { data: cleared } = await shop.rpc('amend_sale', {
      p_sale_id: saleId,
      p_reason: 'Transport was not ours to charge',
      p_lines: sameLines(1, 4000),
      p_customer_id: customerId,
      p_charges: [],
    });
    check('and deleting the last charge is possible', Number(cleared?.total) === 4000, String(cleared?.total));
    const { data: none } = await admin.from('sale_charges').select('id').eq('sale_id', saleId);
    check('the itemised list goes with it', (none ?? []).length === 0, `${(none ?? []).length} left`);

    // And a NULL means leave them alone, which is what every older caller passes.
    await shop.rpc('amend_sale', {
      p_sale_id: saleId,
      p_reason: 'Just the quantity',
      p_lines: sameLines(2, 4000),
      p_customer_id: customerId,
      p_charges: [{ label: 'Transport', amount: 1000 }],
    });
    const { data: kept } = await shop.rpc('amend_sale', {
      p_sale_id: saleId,
      p_reason: 'Quantity again, charges untouched',
      p_lines: sameLines(3, 4000),
      p_customer_id: customerId,
    });
    check(
      'a null charge list leaves them alone',
      Number(kept?.total) === 13000,
      `${kept?.total}, expected 12000 goods + 1000 transport`,
    );
  }

  // ── Cancelling, and undoing the cancellation ───────────────────────────────
  console.log(NL + '— cancelled by mistake, and opened again —');
  {
    const saleId = await sell({ qty: 3, price: 6000, paid: 0 });
    const shelfSold = await onHand();
    const owedSold = await owed();
    const heldSold = await containers();

    await shop.rpc('amend_sale', {
      p_sale_id: saleId, p_reason: 'Cancelled in error', p_lines: [], p_customer_id: customerId,
    });
    const { data: voided } = await admin.from('sales').select('status,revision').eq('id', saleId).single();
    check('it is cancelled', voided.status === 'voided', JSON.stringify(voided));

    const { data: back, error: rErr } = await shop.rpc('reopen_sale', {
      p_sale_id: saleId,
      p_reason: 'Cancelled by mistake, the lorry did go',
    });
    check('a cancelled receipt can be reopened', !rErr, rErr?.message ?? '');

    const { data: live } = await admin.from('sales').select('status,revision').eq('id', saleId).single();
    check('it is live again', live.status === 'posted', JSON.stringify(live));
    check(
      'and the revision moved, so the history shows both',
      Number(live.revision) > Number(voided.revision),
      `${voided.revision} → ${live.revision}`,
    );

    /*
     * EVERY LEDGER BACK WHERE IT WAS. This is the whole reason it is the inverse of `void_sale`
     * step for step rather than an approximation of it: a reopen that restored the bill but not the
     * crates would leave a customer owing money for containers the shop thinks it has.
     */
    check('the stock is off the shelf again', (await onHand()) === shelfSold, `${shelfSold} → ${await onHand()}`);
    check('the crates are out again', (await containers()) === heldSold, `${heldSold} → ${await containers()}`);
    check('and the bill is back on the account', Math.abs((await owed()) - owedSold) < 0.005, `${owedSold} → ${await owed()}`);

    // Twice is harmless: the guard finds a reopen row already pointing at each void row.
    const { error: twice } = await shop.rpc('reopen_sale', { p_sale_id: saleId, p_reason: 'again' });
    check('reopening a live receipt is refused rather than doubled', Boolean(twice), twice?.message ?? 'accepted');
    check('and the crates were not doubled', (await containers()) === heldSold, `${heldSold} → ${await containers()}`);

    check('a reason is required', Boolean((await shop.rpc('reopen_sale', { p_sale_id: saleId, p_reason: '  ' })).error));
    check('the reopen is in the revision history', ((await shop.rpc('sale_revision_history', { p_sale_id: saleId })).data ?? [])
      .some((r) => /reopened/i.test(String(r.reason))), 'looked for "reopened"');
  }
} catch (e) {
  check('the probe ran to the end', false, String(e).split('\n')[0]);
} finally {
  /*
   * Voided, not deleted — `stock_movements` refuses deletes and voiding is the sanctioned removal.
   * Then the probe's own money comes back out: a void leaves the payments standing as credit, which
   * is right for a real sale and wrong for a test one.
   */
  for (const id of made) {
    const { data: s } = await admin.from('sales').select('status').eq('id', id).maybeSingle();
    if (s?.status === 'posted') await shop.rpc('void_sale', { p_sale_id: id, p_reason: 'probe cleanup' });
  }
  if (customerId) {
    const { data: mine } = await admin.from('payments').select('id').eq('store_customer_id', customerId);
    for (const row of mine ?? []) {
      await admin.from('payment_allocations').delete().eq('payment_id', row.id);
      await admin.from('payments').delete().eq('id', row.id);
    }
    await admin.from('deposit_holdings').delete().eq('store_customer_id', customerId);
  }
  const left = customerId ? Number((await shop.rpc('customer_balance', { p_store_customer_id: customerId })).data) || 0 : 0;
  check('the probe leaves no money behind, owed or held', Math.abs(left) < 0.005, String(left));
  if (customerId) await admin.from('store_customers').update({ status: 'archived' }).eq('id', customerId);
  console.log(failed === 0 ? `${NL}  all good` : `${NL}  ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
