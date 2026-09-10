/**
 * A settled receipt can be corrected, and the copy the customer is holding is accounted for.
 *
 * «if a receipt is settled and then changes wants to happen, we need a permitted role to be able to
 *  make good correct changes with back traces and version»
 * «when recalling a walk-in sale that did not have anyone, because of outstanding in empties or
 *  money, it has to now be added with a customer»
 *
 * Until 0131 a receipt with one wrong line had exactly one path: void it and key it again. That
 * loses the number the customer is holding, the payment allocation and the tracking link, and makes
 * two documents out of one sale.
 *
 * MUTATION TEST. Restore the fault and this fails:
 *   · skip the `sale_revisions` insert        → "what it used to say is kept" fails.
 *   · drop the walk-in customer check         → "a walk-in cannot be left owing" fails.
 *   · stop reversing the old lines' stock     → "the shelf follows the correction" fails.
 *
 *     node scripts/probe-amend-a-receipt.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const NL = String.fromCharCode(10);

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

const stamp = Date.now().toString().slice(-6);
const made = [];
let customerId = null;

/** Settle a sale and hand back its id. */
const sell = async ({ customer, qty, price, paid, label }) => {
  const uuid = crypto.randomUUID();
  const { data: draft, error: de } = await shop.rpc('save_draft_order', {
    p_store_id: storeId,
    p_draft_id: null,
    p_customer_id: customer,
    p_label: label ?? null,
    p_fee_amount: 0,
    p_fee_label: null,
    p_charges: [],
    p_note: `amend probe ${stamp}`,
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
        deposit_charged: 0,
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
  const { data: row } = await admin
    .from('sales')
    .select('id')
    .eq('client_uuid', uuid)
    .maybeSingle();
  made.push(row.id);
  return row.id;
};

const onHand = async () =>
  Number(
    (
      await admin
        .from('stock_movements')
        .select('qty_delta')
        .eq('product_id', shape.product_id)
    ).data.reduce((s, m) => s + Number(m.qty_delta), 0),
  );

const owed = async (cid) =>
  Number((await shop.rpc('customer_balance', { p_store_customer_id: cid })).data) || 0;

const containers = async (cid) => {
  const { data } = await shop.rpc('customer_empties_owed', { p_store_customer_id: cid });
  return (data ?? [])
    .filter((r) => r.side === 'they_hold')
    .reduce((s, r) => s + Number(r.owed || 0), 0);
};

let shape = null;

try {
  const { data: shapes } = await admin
    .from('product_units')
    .select('id, product_id, base_qty, products!inner(name, store_id, status)')
    .eq('is_returnable', true)
    .eq('is_sold', true)
    .eq('products.store_id', storeId)
    .eq('products.status', 'active')
    .limit(1);
  shape = (shapes ?? [])[0];
  if (!shape) throw new Error('no returnable, sellable shape in this shop');

  const { data: cid } = await shop.rpc('upsert_customer', {
    p_store_id: storeId,
    p_phone: `0805${stamp}1`,
    p_display_name: `ZZ Amend ${stamp}`,
  });
  customerId = cid;

  // ── Three crates keyed, two actually went ────────────────────────────────────────
  console.log(NL + '— a receipt with one wrong line —');

  const shelfBefore = await onHand();
  const saleId = await sell({ customer: customerId, qty: 3, price: 4000, paid: 12000 });

  check('a receipt is settled', !!saleId, saleId);
  check(
    'three went off the shelf',
    (await onHand()) === shelfBefore - 3 * Number(shape.base_qty || 1),
    `${shelfBefore} -> ${await onHand()}`,
  );
  check('and three containers are out', (await containers(customerId)) === 3);

  const { data: result, error: ae } = await shop.rpc('amend_sale', {
    p_sale_id: saleId,
    p_reason: 'Keyed three, only two went',
    p_lines: [
      {
        product_id: shape.product_id,
        sale_unit_id: shape.id,
        entered_qty: 2,
        base_qty: 2 * Number(shape.base_qty || 1),
        unit_price: 4000,
        line_total: 8000,
        containers_out: 2,
      },
    ],
  });
  check('a settled receipt can be corrected', !ae, ae?.message ?? '');
  if (ae) throw new Error(ae.message);

  const r = Array.isArray(result) ? result[0] : result;
  check('and it becomes revision 2', Number(r?.revision) === 2, `revision ${r?.revision}`);
  check('the bill follows the correction', Number(r?.total) === 8000, `₦${r?.total}`);

  const { data: still } = await admin
    .from('sales')
    .select('id, status, revision')
    .eq('id', saleId)
    .maybeSingle();
  /*
   * THE ID SURVIVES, which is what keeps the customer's tracking link resolving — the link is
   * built from the sale id, and `sales` carries no `share_token` of its own (an earlier version of
   * this probe selected one, got an error, and reported "revision undefined").
   */
  check(
    'the receipt keeps its number and stays posted',
    still?.id === saleId && still?.status === 'posted' && Number(still?.revision) === 2,
    `revision ${still?.revision}`,
  );

  check(
    'the shelf follows the correction',
    (await onHand()) === shelfBefore - 2 * Number(shape.base_qty || 1),
    `${await onHand()}, expected ${shelfBefore - 2 * Number(shape.base_qty || 1)}`,
  );
  check('the containers follow it too', (await containers(customerId)) === 2);

  /*
   * THE MONEY IS LEFT ALONE. ₦12,000 was handed over and the drawer has it; the bill is now
   * ₦8,000, so ₦4,000 is credit. Quietly reducing the payment would make the till short.
   */
  check(
    'the payment stays, and the difference becomes credit',
    Number(r?.paid) === 12000 && Number(r?.owing) === -4000,
    `paid ₦${r?.paid}, owing ₦${r?.owing}`,
  );

  // ── What it used to say ──────────────────────────────────────────────────────────
  console.log(NL + '— and the old copy is still readable —');
  const { data: hist, error: he } = await shop.rpc('sale_revision_history', {
    p_sale_id: saleId,
  });
  check('what it used to say is kept', !he && (hist ?? []).length === 1, he?.message ?? '');
  const old = (hist ?? [])[0];
  check(
    'in full, not as a diff',
    Number(old?.document?.lines?.[0]?.entered_qty) === 3 &&
      Number(old?.document?.total) === 12000,
    `was ${old?.document?.lines?.[0]?.entered_qty} at ₦${old?.document?.total}`,
  );
  check('with the reason on it', !!old?.reason, old?.reason);
  check('and who did it', !!old?.amended_by, old?.actor_name ?? '');

  const { error: noReason } = await shop.rpc('amend_sale', {
    p_sale_id: saleId,
    p_reason: '   ',
  });
  check('a correction with no reason is refused', !!noReason, noReason?.message?.slice(0, 40));

  // ── A walk-in that is corrected into an obligation ───────────────────────────────
  console.log(NL + '— and a walk-in cannot be left owing —');

  const walkId = await sell({
    customer: null,
    qty: 2,
    price: 4000,
    paid: 8000,
    label: `ZZ Walkin ${stamp}`,
  });
  check('a walk-in sale settles with nobody named', !!walkId);

  /*
   * THE RULE. Correcting it to bill more than was paid leaves money owing — and a walk-in has
   * nobody on the other end of it, so the debt can never be chased. It must be refused, and the
   * refusal must say what to do about it.
   */
  const { error: orphan } = await shop.rpc('amend_sale', {
    p_sale_id: walkId,
    p_reason: 'They took a third crate on the way out',
    p_lines: [
      {
        product_id: shape.product_id,
        sale_unit_id: shape.id,
        entered_qty: 3,
        base_qty: 3 * Number(shape.base_qty || 1),
        unit_price: 4000,
        line_total: 12000,
        containers_out: 3,
      },
    ],
  });
  check(
    'a walk-in cannot be left owing money or containers',
    !!orphan && /Add a customer/.test(orphan.message),
    orphan?.message?.slice(0, 90) ?? 'it was accepted',
  );

  /*
   * AND NAMING SOMEBODY IS THE WAY THROUGH — including the containers, which the till's trigger
   * could never have written because there was no customer when the line was keyed.
   */
  const beforeOwed = await owed(customerId);
  const { data: fixed, error: fe } = await shop.rpc('amend_sale', {
    p_sale_id: walkId,
    p_reason: 'They took a third crate on the way out',
    p_customer_id: customerId,
    p_lines: [
      {
        product_id: shape.product_id,
        sale_unit_id: shape.id,
        entered_qty: 3,
        base_qty: 3 * Number(shape.base_qty || 1),
        unit_price: 4000,
        line_total: 12000,
        containers_out: 3,
      },
    ],
  });
  check('naming a customer is the way through', !fe, fe?.message ?? '');

  const f = Array.isArray(fixed) ? fixed[0] : fixed;
  check(
    'and the ₦4,000 lands on their account',
    (await owed(customerId)) - beforeOwed === 4000,
    `₦${beforeOwed} -> ₦${await owed(customerId)}`,
  );
  check(
    'along with the containers the walk-in never owed',
    (await containers(customerId)) === 5,
    `${await containers(customerId)}, expected 2 + 3`,
  );

  // ── Once containers start coming back, it is too late ────────────────────────────
  console.log(NL + '— and not once the crates start coming back —');
  await shop.rpc('record_customer_empties', {
    p_store_id: storeId,
    p_customer_id: customerId,
    p_product_unit_id: shape.id,
    p_direction: 'returned',
    p_qty: 1,
    p_side: 'they_hold',
    p_ref_table: 'sale_lines',
    p_ref_id: (
      await admin.from('sale_lines').select('id').eq('sale_id', walkId).maybeSingle()
    ).data.id,
    p_reason: `probe ${stamp}`,
  });

  const { error: late } = await shop.rpc('amend_sale', {
    p_sale_id: walkId,
    p_reason: 'too late',
    p_lines: [],
  });
  check(
    'a receipt whose containers are half back is refused',
    !!late && /already come back/.test(late.message),
    late?.message?.slice(0, 60) ?? 'it was accepted',
  );
} catch (e) {
  console.log(`  FAIL  the probe could not finish — ${e.message}`);
  failed += 1;
} finally {
  /*
   * VOIDED WHERE IT CAN BE, and said plainly where it cannot.
   *
   * `void_sale` refuses a receipt whose containers have started coming back — correctly — so the
   * last sale here stays. Nothing is deleted either way: sales, movements and both empties ledgers
   * are append-only, and a probe that claimed a clean database would be lying about all three.
   */
  let voided = 0;
  for (const id of made) {
    const { error } = await shop.rpc('void_sale', {
      p_sale_id: id,
      p_reason: `probe ${stamp} tidying up`,
    });
    if (!error) voided += 1;
  }
  console.log(
    NL +
      `  left behind: ${made.length - voided} of ${made.length} sale(s) still posted ` +
      `(the rest voided), 1 customer, and their ledger rows — all append-only.`,
  );
}

console.log(NL + (failed === 0 ? 'ALL PASS' : `${failed} FAILED`));
process.exit(failed === 0 ? 0 : 1);
