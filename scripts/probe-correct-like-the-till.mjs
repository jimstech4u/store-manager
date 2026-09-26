/**
 * CORRECTING A RECEIPT IS THE TILL AGAIN — INCLUDING ADDING AND REMOVING.
 *
 * Asked for as «"correct this receipt" should reuse sell-page interaction … add/scan/edit/remove
 * items, void when all removed».
 *
 * The old correction screen only let a seller change HOW MANY and AT WHAT PRICE, on the lines that
 * were already there. That covers a mis-keyed quantity and nothing else: a crate that went out and
 * never made it onto the receipt had no path at all, and a line that should not be there could be
 * taken off but never the last one.
 *
 * The server already accepted any set of lines — it reverses the old ones and applies the new — so
 * ADDING was a UI restriction, not a rule. What the server did NOT have was an answer for the empty
 * set: it would have written a posted receipt with no lines on it whose total was whatever transport
 * had been added. A document saying a customer owes ₦2,000 for nothing, with a link they can open
 * and read as live. 0174 hands that case to `void_sale`.
 *
 * What this proves, against a real settled receipt:
 *
 *   · an item that was never on the receipt can be added, and the shelf and the account follow
 *   · taking the last line off CANCELS it, and the stock, the containers and the payment all come
 *     back rather than being left half-applied
 *   · a null line set still means "leave the lines alone", which is what the old callers pass
 *
 *     node scripts/probe-correct-like-the-till.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const NL = String.fromCharCode(10);
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
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

const stamp = Date.now().toString().slice(-6);
const made = [];
let customerId = null;
let shape = null;
let other = null;

const sell = async ({ qty, price, paid, deposit = 0, charge = 0, chargeLabel = null }) => {
  const uuid = crypto.randomUUID();
  const { data: draft, error: de } = await shop.rpc('save_draft_order', {
    p_store_id: storeId,
    p_draft_id: null,
    p_customer_id: customerId,
    p_label: null,
    p_fee_amount: 0,
    p_fee_label: null,
    p_charges: charge > 0 ? [{ label: chargeLabel ?? 'Transport', amount: charge }] : [],
    p_note: `correct-probe ${stamp}`,
    p_client_uuid: uuid,
    p_lines: [
      {
        product_id: shape.product_id,
        qty,
        pack_id: null,
        sale_unit_id: shape.id,
        base_qty: qty * Number(shape.base_qty || 1),
        unit_price: price,
        line_total: qty * price,
        containers_out: qty,
        deposit_charged: deposit,
      },
    ],
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

const onHand = async (productId) =>
  Number(
    ((await admin.from('stock_movements').select('qty_delta').eq('product_id', productId)).data ?? [])
      .reduce((s, m) => s + Number(m.qty_delta), 0),
  );
const owed = async () => Number((await shop.rpc('customer_balance', { p_store_customer_id: customerId })).data) || 0;
const containers = async () => {
  const { data } = await shop.rpc('customer_empties_owed', { p_store_customer_id: customerId });
  return (data ?? []).filter((r) => r.side === 'they_hold').reduce((s, r) => s + Number(r.owed || 0), 0);
};

try {
  const { data: shapes } = await admin
    .from('product_units')
    .select('id, product_id, base_qty, is_returnable, products!inner(name, store_id, status)')
    .eq('is_sold', true)
    .eq('products.store_id', storeId)
    .eq('products.status', 'active')
    .limit(40);
  shape = (shapes ?? []).find((s) => s.is_returnable);
  other = (shapes ?? []).find((s) => s.product_id !== shape?.product_id);
  if (!shape || !other) throw new Error('need two sellable shapes on different items');
  console.log(`  selling: ${shape.products.name}, adding: ${other.products.name}`);

  /*
   * COUNTED TODAY FIRST, because the shop requires it before anything can be sold (0144).
   *
   * The count is what is ALREADY on the shelf, read from the movements — a probe that invented a
   * figure would be writing a false count into a live shop, and the very next screen would show a
   * shortage nobody caused.
   */
  for (const s of [shape, other]) {
    const { error } = await shop.rpc('count_from_till', {
      p_product_id: s.product_id,
      p_counted: await onHand(s.product_id),
    });
    // Already counted today is not a failure — it is the shop having done its job.
    if (error && !/already/i.test(error.message)) throw new Error(error.message);
  }

  const { data: cid } = await shop.rpc('upsert_customer', {
    p_store_id: storeId,
    p_phone: `0806${stamp}1`,
    p_display_name: `ZZ Correct ${stamp}`,
  });
  customerId = cid;

  // ── An item that was never on the receipt ───────────────────────────────────
  console.log(NL + '— a crate went out and never reached the receipt —');
  {
    const saleId = await sell({ qty: 2, price: 5000, paid: 10000 });
    const shelfBefore = await onHand(other.product_id);
    const owedBefore = await owed();

    const { data: res, error } = await shop.rpc('amend_sale', {
      p_sale_id: saleId,
      p_reason: 'A bag went out with it and was never keyed',
      p_lines: [
        {
          product_id: shape.product_id,
          sale_unit_id: shape.id,
          entered_qty: 2,
          base_qty: 2 * Number(shape.base_qty || 1),
          unit_price: 5000,
          line_total: 10000,
          containers_out: 2,
        },
        {
          product_id: other.product_id,
          sale_unit_id: other.id,
          entered_qty: 1,
          base_qty: 1 * Number(other.base_qty || 1),
          unit_price: 3000,
          line_total: 3000,
          containers_out: 0,
        },
      ],
      p_customer_id: customerId,
    });
    check('an item never on the receipt can be added', !error, error?.message ?? '');
    check('and it is not reported as a cancellation', res?.voided === false, JSON.stringify(res));
    check('the receipt now says the bigger figure', Number(res?.total) === 13000, String(res?.total));
    check('and only the difference is owing', Number(res?.owing) === 3000, String(res?.owing));

    const shelfAfter = await onHand(other.product_id);
    check(
      'the added item left the shelf',
      shelfBefore - shelfAfter === Number(other.base_qty || 1),
      `${shelfBefore} → ${shelfAfter}`,
    );
    check('and the customer is billed for it', (await owed()) - owedBefore === 3000, String(await owed()));
  }

  // ── And a null line set still means "leave them alone" ──────────────────────
  console.log(NL + '— correcting only the customer, with no lines given —');
  {
    const saleId = await sell({ qty: 1, price: 4000, paid: 4000 });
    const { data: res, error } = await shop.rpc('amend_sale', {
      p_sale_id: saleId,
      p_reason: 'Attaching the right customer',
      p_lines: null,
      p_customer_id: customerId,
    });
    check('a null line set is not an empty one', !error, error?.message ?? '');
    check('it did not cancel the receipt', res?.voided === false, JSON.stringify(res));
    check('and the total is unchanged', Number(res?.total) === 4000, String(res?.total));
    const { data: stillThere } = await admin.from('sale_lines').select('id').eq('sale_id', saleId);
    check('the lines are still on it', (stillThere ?? []).length === 1, `${(stillThere ?? []).length} lines`);
  }

  // ── Taking the last line off ────────────────────────────────────────────────
  console.log(NL + '— and taking everything off cancels it —');
  {
    const saleId = await sell({ qty: 3, price: 6000, paid: 18000 });
    const shelfBefore = await onHand(shape.product_id);
    const owedBefore = await owed();
    const heldBefore = await containers();

    const { data: res, error } = await shop.rpc('amend_sale', {
      p_sale_id: saleId,
      p_reason: 'None of this went — the lorry never left',
      p_lines: [],
      p_customer_id: customerId,
    });
    check('an empty set is accepted', !error, error?.message ?? '');
    check('and it says it cancelled the receipt', res?.voided === true, JSON.stringify(res));

    const { data: sale } = await admin.from('sales').select('status,revision').eq('id', saleId).single();
    check('the receipt is cancelled, not a new revision', sale.status === 'voided', JSON.stringify(sale));

    /*
     * AND EVERYTHING IT DID IS UNDONE, which is the whole reason this goes through `void_sale`
     * rather than being written as a correction to nothing.
     */
    check(
      'the stock came back',
      (await onHand(shape.product_id)) === shelfBefore + 3 * Number(shape.base_qty || 1),
      `${shelfBefore} → ${await onHand(shape.product_id)}`,
    );
    check('the containers were released', (await containers()) === heldBefore - 3, `${heldBefore} → ${await containers()}`);

    /*
     * AND THE ₦18,000 THEY HANDED OVER IS NOW THEIRS, not the shop's.
     *
     * The first version of this check asserted the balance came back to where it started, and it
     * failed at −15,000. The code was right and the assertion was wrong: cancelling a receipt that
     * has been paid does not un-receive the money. The payment is unallocated and stands as a
     * CREDIT — the shop is holding cash for a sale that did not happen, and owes it back or against
     * the next one. A void that quietly wrote the money out of existence would be the version that
     * loses ₦18,000 and tells nobody.
     */
    check(
      'and the money they paid becomes a credit to them, not nothing',
      Math.abs((await owed()) - (owedBefore - 18000)) < 0.005,
      `${owedBefore} → ${await owed()}, expected ${owedBefore - 18000}`,
    );

    // A receipt with no lines and a live status is the state this exists to prevent.
    const { data: leftLines } = await admin.from('sale_lines').select('id').eq('sale_id', saleId);
    check(
      'there is no posted receipt with nothing on it',
      sale.status === 'voided' || (leftLines ?? []).length > 0,
      `status ${sale.status}, ${(leftLines ?? []).length} lines`,
    );
  }

  /*
   * ─── AND IT IS ONE BALANCE: GOODS, DEPOSIT, TRANSPORT, THE LOT ─────────────
   *
   * A receipt is rarely only goods. There is a deposit taken against the crates and a charge for
   * carrying it, and both are money the customer owes on the same document. So cancelling it has to
   * take all of it back out — a void that reversed the goods and left the transport charge standing
   * would leave a customer owing ₦1,500 for a delivery that never happened, which is precisely the
   * kind of figure nobody can explain six weeks later.
   */
  console.log(NL + '— and the deposit and the transport come back too —');
  {
    const owedBefore = await owed();
    const heldBefore = await containers();
    const saleId = await sell({
      qty: 2,
      price: 5000,
      paid: 0,
      deposit: 800,
      charge: 1500,
      chargeLabel: 'Transport',
    });

    const owedWithAll = await owed();
    check(
      'the goods, the deposit and the transport are all owed',
      Math.abs(owedWithAll - (owedBefore + 10000 + 800 + 1500)) < 0.005,
      `${owedBefore} → ${owedWithAll}, expected ${owedBefore + 10000 + 800 + 1500}`,
    );
    check('and the crates are out', (await containers()) === heldBefore + 2, `${heldBefore} → ${await containers()}`);

    const { data: res, error } = await shop.rpc('amend_sale', {
      p_sale_id: saleId,
      p_reason: 'The whole delivery was called off',
      p_lines: [],
      p_customer_id: customerId,
    });
    check('cancelling it is accepted', !error, error?.message ?? '');
    check('and reported as a cancellation', res?.voided === true, JSON.stringify(res));

    check(
      'every part of it comes back — goods, deposit and charge',
      Math.abs((await owed()) - owedBefore) < 0.005,
      `${owedWithAll} → ${await owed()}, expected ${owedBefore}`,
    );
    check('and the crates with it', (await containers()) === heldBefore, `${heldBefore} → ${await containers()}`);
  }

  // ── A set of zero-quantity lines is the same thing said differently ─────────
  console.log(NL + '— and a set of empty lines is the same as no lines —');
  {
    const saleId = await sell({ qty: 1, price: 2000, paid: 0 });
    const { data: res, error } = await shop.rpc('amend_sale', {
      p_sale_id: saleId,
      p_reason: 'Removed everything by zeroing it',
      p_lines: [
        {
          product_id: shape.product_id,
          sale_unit_id: shape.id,
          entered_qty: 0,
          base_qty: 0,
          unit_price: 5000,
          line_total: 0,
          containers_out: 0,
        },
      ],
      p_customer_id: customerId,
    });
    check('zeroed lines are accepted', !error, error?.message ?? '');
    check('and cancel it too', res?.voided === true, JSON.stringify(res));
    const { data: sale } = await admin.from('sales').select('status').eq('id', saleId).single();
    check('rather than leaving a receipt for nothing', sale.status === 'voided', sale.status);
  }
} catch (e) {
  check('the probe ran to the end', false, String(e).split('\n')[0]);
} finally {
  /*
   * WHAT CAN BE PUT BACK IS PUT BACK, and what cannot is SAID.
   *
   * `stock_movements` is append-only and refuses deletes, so a settled sale is voided rather than
   * removed — the sanctioned removal, which reverses the shelf and the account to net zero. The
   * customer is left, archived: deleting one with history behind it is a different operation and
   * not this probe's business.
   */
  for (const id of made) {
    const { data: s } = await admin.from('sales').select('status').eq('id', id).maybeSingle();
    if (s?.status === 'posted') await shop.rpc('void_sale', { p_sale_id: id, p_reason: 'probe cleanup' });
  }
  /*
   * AND THE PROBE'S OWN MONEY COMES BACK OUT.
   *
   * Voiding the receipts leaves the payments standing as credits, which is correct for a real sale
   * and wrong for a test one: it would show on the shop's dashboard as money held for a customer
   * who never existed. These are the probe's own rows, identified by its own customer, so they are
   * deleted rather than reversed — a refund is a business event and this was never business.
   */
  if (customerId) {
    const { data: mine } = await admin.from('payments').select('id').eq('store_customer_id', customerId);
    for (const row of mine ?? []) {
      await admin.from('payment_allocations').delete().eq('payment_id', row.id);
      await admin.from('payments').delete().eq('id', row.id);
    }
  }
  const { data: leftOwing } = customerId
    ? await shop.rpc('customer_balance', { p_store_customer_id: customerId })
    : { data: 0 };
  check('the probe leaves no money behind, owed or held', Math.abs(Number(leftOwing) || 0) < 0.005, String(leftOwing));
  if (customerId) await admin.from('store_customers').update({ status: 'archived' }).eq('id', customerId);
  console.log(`${NL}  ${made.length} probe receipt(s), all cancelled`);
  console.log(failed === 0 ? '  all good' : '  ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
