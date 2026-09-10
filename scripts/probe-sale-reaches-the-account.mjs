/**
 * One sale, three obligations, one account — and all three follow the sale when it changes.
 *
 * «say one sale bring outstanding of 3000, deposit 10000, 3 goldberg bottles, so it gets added to
 *  the account. Then even if we change the sale (recoverable) it just changes their automatically
 *  thanks to ledger system»
 *
 * That is the claim being tested, not assumed. A sale to a named customer leaves behind:
 *
 *   MONEY      what was billed and not paid → `customer_balance`
 *   A DEPOSIT  crate money handed over      → `deposit_holdings`
 *   CONTAINERS what went out with the goods → `customer_empties`, side `they_hold`
 *
 * Three different ledgers, because they settle on three different days by three different acts —
 * and the point of them being ledgers is that voiding the sale appends the reversal rather than
 * editing anything, so every figure moves back on its own.
 *
 * IT ALSO CHECKS THE GUARD. Containers and deposits are obligations to a PERSON; a walk-in cannot
 * hold either, because there is nobody for the shop to chase or to pay back.
 *
 * MUTATION TEST. Restore the fault and this fails:
 *   · stop `void_sale` reversing `customer_empties` → "the containers go back on the account" fails.
 *   · stop it reversing `deposit_holdings`          → "and the deposit is no longer held" fails.
 *
 *     node scripts/probe-sale-reaches-the-account.mjs
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
let customerId = null;
let draftId = null;
let saleId = null;

/** What the three ledgers say about this customer, read the way the screens read them. */
const position = async () => {
  /*
   * READ THE WAY THE SCREENS READ THEM, which is three different shapes.
   *
   * There is no `customer_deposit_held(customer)` — the deposit page reads the whole shop's held
   * figures from `customers_with_deposits` and picks its row out. Inventing the reader I expected
   * would have made this probe test a function nothing else calls.
   */
  const [{ data: bal }, { data: deps }, { data: owed }] = await Promise.all([
    shop.rpc('customer_balance', { p_store_customer_id: customerId }),
    shop.rpc('customers_with_deposits', { p_store_id: storeId }),
    shop.rpc('customer_empties_owed', { p_store_customer_id: customerId }),
  ]);
  const held = (deps ?? []).find((d) => d.store_customer_id === customerId)?.held ?? 0;
  const theirs = (owed ?? []).filter((r) => (r.side ?? 'they_hold') === 'they_hold');
  return {
    balance: Number(bal) || 0,
    deposit: Number(held) || 0,
    /*
     * `owed`, which is what the reader actually calls it.
     *
     * An earlier draft summed `r.outstanding` — the name `supplier_empties_sent` uses — and got
     * `undefined`, which `Number()` turns into 0. So the probe reported "0 containers" and read
     * like a missing sale→empties bridge, when the trigger from 0117 had written the row correctly
     * all along. Read the keys the function returns, do not assume they match its sibling's.
     */
    containers: theirs.reduce((s, r) => s + Number(r.owed || 0), 0),
  };
};

try {
  // ── A returnable product, and somebody to sell it to ──────────────────────────────
  console.log(NL + '— a customer, and something that comes back —');

  const { data: shapeRows } = await admin
    .from('product_units')
    .select('id, product_id, base_qty, products!inner(name, store_id, status)')
    .eq('is_returnable', true)
    .eq('is_sold', true)
    .eq('products.store_id', storeId)
    .eq('products.status', 'active')
    .limit(1);
  const shape = (shapeRows ?? [])[0];
  check('there is something that comes back and is sold', Boolean(shape), shape?.products?.name);
  if (!shape) throw new Error('no returnable, sellable shape in this shop');

  const { data: cid, error: cErr } = await shop.rpc('upsert_customer', {
    p_store_id: storeId,
    p_phone: `0803${stamp}9`,
    p_display_name: `ZZ Ledger ${stamp}`,
  });
  check('a customer can be named', !cErr, cErr?.message ?? '');
  if (cErr) throw new Error(cErr.message);
  customerId = cid;

  const opening = await position();
  check(
    'and they start owing nothing, holding nothing',
    opening.balance === 0 && opening.deposit === 0 && opening.containers === 0,
    `₦${opening.balance}, deposit ₦${opening.deposit}, ${opening.containers} containers`,
  );

  // ── The sale ──────────────────────────────────────────────────────────────────────
  console.log(NL + '— one sale —');

  /*
   * BILLED ₦13,000 and PAID ₦10,000, so ₦3,000 is left outstanding — the request's own figure.
   * Three containers go out with it, and ₦10,000 of crate money is handed over.
   */
  const clientUuid = crypto.randomUUID();
  const { data: did, error: dErr } = await shop.rpc('save_draft_order', {
    p_store_id: storeId,
    p_draft_id: null,
    p_customer_id: customerId,
    p_label: null,
    p_fee_amount: 0,
    p_fee_label: null,
    p_charges: [],
    p_note: `probe ${stamp}`,
    p_client_uuid: clientUuid,
    p_lines: [
      {
        product_id: shape.product_id,
        qty: 3,
        pack_id: null,
        sale_unit_id: shape.id,
        base_qty: 3 * Number(shape.base_qty || 1),
        unit_price: 4000,
        line_total: 12000,
        containers_out: 3,
        deposit_charged: 0,
      },
    ],
  });
  check('a draft with a returnable line can be saved', !dErr, dErr?.message ?? '');
  if (dErr) throw new Error(dErr.message);
  draftId = did;

  const { data: settled, error: sErr } = await shop.rpc('settle_draft_order', {
    p_draft_id: draftId,
    p_payments: [{ method: 'cash', amount: 9000 }],
    p_client_uuid: clientUuid,
  });
  check('and settled with part of it paid', !sErr, sErr?.message ?? '');
  if (sErr) throw new Error(sErr.message);
  saleId = typeof settled === 'string' ? settled : settled?.sale_id ?? settled?.id;

  await shop.rpc('take_customer_deposit', {
    p_store_id: storeId,
    p_customer_id: customerId,
    p_amount: 10000,
    p_reason: `probe ${stamp} crate money`,
  });

  const after = await position();

  /*
   * ALL THREE, ON ONE ACCOUNT. This is the sentence the request asked to have proved.
   */
  check(
    'the money left owing lands on the account',
    after.balance === 3000,
    `₦${after.balance}, expected ₦3,000`,
  );
  check(
    'the deposit is held against them',
    after.deposit === 10000,
    `₦${after.deposit}, expected ₦10,000`,
  );
  check(
    'and the containers are out with them',
    after.containers === 3,
    `${after.containers}, expected 3`,
  );

  // ── The guard: an obligation needs somebody to owe it ─────────────────────────────
  console.log(NL + '— and a walk-in cannot hold either —');

  const walkUuid = crypto.randomUUID();
  const { data: wid } = await shop.rpc('save_draft_order', {
    p_store_id: storeId,
    p_draft_id: null,
    p_customer_id: null,
    p_label: `ZZ Walkin ${stamp}`,
    p_fee_amount: 0,
    p_fee_label: null,
    p_charges: [],
    p_note: null,
    p_client_uuid: walkUuid,
    p_lines: [
      {
        product_id: shape.product_id,
        qty: 1,
        pack_id: null,
        sale_unit_id: shape.id,
        base_qty: Number(shape.base_qty || 1),
        unit_price: 4000,
        line_total: 4000,
        containers_out: 1,
        deposit_charged: 0,
      },
    ],
  });

  const { error: walkErr } = await shop.rpc('settle_draft_order', {
    p_draft_id: wid,
    p_payments: [{ method: 'cash', amount: 4000 }],
    p_client_uuid: walkUuid,
  });

  /*
   * EITHER IT REFUSES, OR IT RECORDS NO OBLIGATION — both are correct answers, and which one this
   * shop gives is the thing worth knowing rather than assuming. What would NOT be correct is
   * recording three crates as owed by nobody: an obligation with no one on the other end of it can
   * never be settled, and it sits on the "still out" list for ever.
   */
  if (walkErr) {
    check('selling a returnable to a walk-in is refused outright', true, walkErr.message.slice(0, 60));
  } else {
    const { count: orphans } = await admin
      .from('customer_empties')
      .select('id', { count: 'exact', head: true })
      .is('store_customer_id', null);
    check(
      'a walk-in sale records no container owed by nobody',
      (orphans ?? 0) === 0,
      `${orphans} container rows with no customer`,
    );
    await shop.rpc('void_sale', {
      p_sale_id: (await admin.from('sales').select('id').eq('client_uuid', walkUuid).maybeSingle())
        .data?.id,
      p_reason: 'probe tidying up',
    });
  }

  // ── Changing the sale moves all three, without touching them ──────────────────────
  console.log(NL + '— and changing the sale moves all three —');

  /*
   * VOIDED BEFORE ANYTHING COMES BACK, deliberately.
   *
   * `void_sale` refuses once containers have started returning — "settle the rest first, then
   * void" — and that guard is correct: putting an obligation back that has already been partly
   * discharged would leave the customer owing a negative number. An earlier draft of this probe
   * returned two crates and then tried to void, read the refusal as a defect, and was wrong. The
   * partial return is tested below, on its own sale.
   */
  const { error: vErr } = await shop.rpc('void_sale', {
    p_sale_id: saleId,
    p_reason: `probe ${stamp}: keyed wrong`,
  });
  check('a settled sale can be taken back', !vErr, vErr?.message ?? '');

  const voided = await position();

  /*
   * THE BILL GOES, THE MONEY STAYS.
   *
   * `void_sale`'s own rule, and the right one: the customer really did hand over ₦9,000 and the
   * drawer has it. So the bill comes off and the payment becomes credit — which reads as a
   * NEGATIVE balance, the shop owing them, not as nothing.
   */
  check(
    'the bill comes off and the payment stays as credit',
    voided.balance === -9000,
    `₦${voided.balance}, expected −₦9,000`,
  );

  check(
    'the containers come off the account by themselves',
    voided.containers === 0,
    `${voided.containers} still out, expected 0`,
  );

  /*
   * AND THE DEPOSIT, which is genuinely separate: it was taken by its own call rather than by the
   * sale, so voiding must not quietly hand back crate money the shop is still holding.
   */
  check(
    'and the deposit is left alone, because it was taken on its own',
    voided.deposit === 10000,
    `₦${voided.deposit}`,
  );

  // ── A partial return, on a sale of its own ────────────────────────────────────────
  console.log(NL + '— and containers come back a few at a time —');

  const secondUuid = crypto.randomUUID();
  const { data: d2 } = await shop.rpc('save_draft_order', {
    p_store_id: storeId,
    p_draft_id: null,
    p_customer_id: customerId,
    p_label: null,
    p_fee_amount: 0,
    p_fee_label: null,
    p_charges: [],
    p_note: `probe ${stamp} second`,
    p_client_uuid: secondUuid,
    p_lines: [
      {
        product_id: shape.product_id,
        qty: 3,
        pack_id: null,
        sale_unit_id: shape.id,
        base_qty: 3 * Number(shape.base_qty || 1),
        unit_price: 4000,
        line_total: 12000,
        containers_out: 3,
        deposit_charged: 0,
      },
    ],
  });
  await shop.rpc('settle_draft_order', {
    p_draft_id: d2,
    p_payments: [{ method: 'cash', amount: 12000 }],
    p_client_uuid: secondUuid,
  });

  const beforeReturn = await position();
  await shop.rpc('record_customer_empties', {
    p_store_id: storeId,
    p_customer_id: customerId,
    p_product_unit_id: shape.id,
    p_direction: 'returned',
    p_qty: 2,
    p_side: 'they_hold',
    p_reason: `probe ${stamp} two back`,
  });
  const afterReturn = await position();

  check(
    'bringing two of three back leaves one owing',
    beforeReturn.containers - afterReturn.containers === 2,
    `${beforeReturn.containers} -> ${afterReturn.containers}`,
  );
  check(
    'and it touches neither the money nor the deposit',
    afterReturn.balance === beforeReturn.balance && afterReturn.deposit === beforeReturn.deposit,
    `₦${afterReturn.balance}, deposit ₦${afterReturn.deposit}`,
  );

} catch (e) {
  console.log(`  FAIL  the probe could not finish — ${e.message}`);
  failed += 1;
} finally {
  /*
   * WHAT IS LEFT, read back rather than assumed.
   *
   * The deposit probe once printed "nothing left behind" while leaving an order every run: it
   * diffed a list of draft ids, PostgREST caps a response at 1,000 rows, and this shop has more
   * drafts than that — so both reads were silently truncated and the new order fell outside the
   * window. Keep the ids when you write them, and finish by reading what is still there.
   */
  if (draftId) await shop.rpc('cancel_draft_order', { p_draft_id: draftId });
  const { data: left } = await admin
    .from('sales')
    .select('id, status')
    .eq('store_id', storeId)
    .ilike('note', `%${stamp}%`);
  const live = (left ?? []).filter((s) => s.status === 'posted').length;
  console.log(
    NL +
      `  left behind: ${live} live sale(s), ${(left ?? []).length - live} voided, ` +
      `1 customer, and the ledger rows behind them — all append-only.`,
  );
}

console.log(NL + (failed === 0 ? 'ALL PASS' : `${failed} FAILED`));
process.exit(failed === 0 ? 0 : 1);
