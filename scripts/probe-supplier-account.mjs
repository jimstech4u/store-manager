/**
 * The other side of the counter: a supplier's account, and the containers that go back.
 *
 * The shop kept a ledger for everybody it sells to and nothing at all for the people it buys from,
 * though the relationship is the same one seen from the other side — the shop owes for a load, it
 * pays, and it holds the SUPPLIER'S crates.
 *
 * `purchases.supplier_name` was free text, so "NBL" and "Nigerian Breweries" were two suppliers and
 * neither had a history. That stopped being merely untidy the moment crates started going back:
 * "who took them" written as a spelling cannot be totalled.
 *
 *     node scripts/probe-supplier-account.mjs [http://localhost:3100]
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
const NAME = `ZZ Brewery ${stamp}`;
let supplierId = null;

try {
  // ── A supplier is a row, and naming it twice is the same row ──────────────────────
  console.log(NL + '— naming a supplier —');
  const { data: id, error } = await shop.rpc('upsert_supplier', {
    p_store_id: storeId,
    p_name: NAME,
    p_phone: '08030000001',
    p_note: 'Delivers Tuesdays',
  });
  check('a supplier can be named', !error, error?.message ?? '');
  if (error) throw new Error(error.message);
  supplierId = id;

  /*
   * THE SAME NAME RETURNS THE SAME ROW, rather than refusing.
   *
   * Somebody typing a name the shop already has means the one that is there — the product groups
   * learnt this in 0093, and a telling-off in the middle of entering a load is the worst moment
   * for one.
   */
  const { data: again } = await shop.rpc('upsert_supplier', {
    p_store_id: storeId,
    p_name: NAME.toLowerCase(),
  });
  check('naming them again returns the same one', again === supplierId, `${again === supplierId}`);

  // ── Money ─────────────────────────────────────────────────────────────────────────
  console.log(NL + '— what the shop owes them —');
  const owedAt = async () =>
    Number((await shop.rpc('supplier_balance', { p_supplier_id: supplierId })).data) || 0;

  check('a new supplier is owed nothing', (await owedAt()) === 0);

  await shop.rpc('record_supplier_payment', {
    p_store_id: storeId,
    p_supplier_id: supplierId,
    p_amount: 50000,
    p_direction: 'charge',
    p_reason: 'Haulage on the Tuesday load',
  });
  check('a charge adds to what the shop owes', (await owedAt()) === 50000, `${await owedAt()}`);

  await shop.rpc('record_supplier_payment', {
    p_store_id: storeId,
    p_supplier_id: supplierId,
    p_amount: 30000,
    p_direction: 'paid',
    p_method: 'transfer',
  });
  check('paying comes off it', (await owedAt()) === 20000, `${await owedAt()}`);

  await shop.rpc('record_supplier_payment', {
    p_store_id: storeId,
    p_supplier_id: supplierId,
    p_amount: 5000,
    p_direction: 'credit',
    p_reason: 'Rebate on 200 crates',
  });
  check('and a rebate comes off it too', (await owedAt()) === 15000, `${await owedAt()}`);

  const { error: noReason } = await shop.rpc('record_supplier_payment', {
    p_store_id: storeId,
    p_supplier_id: supplierId,
    p_amount: 100,
    p_direction: 'charge',
    p_reason: '  ',
  });
  check('a charge with no reason is refused', Boolean(noReason), noReason?.message?.slice(0, 40));

  // ── Containers ────────────────────────────────────────────────────────────────────
  console.log(NL + '— and the crates that went back —');
  const { data: shapes } = await admin
    .from('product_units')
    .select('id, products!inner(name, store_id)')
    .eq('is_returnable', true)
    .eq('products.store_id', storeId)
    .limit(1);
  const shape = (shapes ?? [])[0];
  check('there is a returnable shape to send back', Boolean(shape), shape?.products?.name);

  if (shape) {
    /*
     * COUNT THE STACK FIRST, because a yard with no count has no position.
     *
     * These assertions used to read the yard through `?? 0` and measure movements against that
     * nought. Since 0128 an uncounted shape reports `in_yard = null` — the honest answer, and the
     * whole point of that migration: a shop that has never counted is not standing at zero, it is
     * standing at "nobody has looked". `?? 0` turned that null back into a number and every
     * comparison here silently became 0 → 0.
     *
     * So the probe does what a shop would do and counts before it reconciles.
     */
    await shop.rpc('count_empties', {
      p_store_id: storeId,
      p_parts: [{ product_unit_id: shape.id, qty: 100 }],
      p_note: `supplier probe ${stamp}`,
    });

    const before = (await shop.rpc('yard_empties', { p_store_id: storeId })).data ?? [];
    const yardBefore = Number(before.find((y) => y.product_unit_id === shape.id)?.in_yard);

    await shop.rpc('record_supplier_empties', {
      p_store_id: storeId,
      p_product_unit_id: shape.id,
      p_qty: 40,
      p_supplier_id: supplierId,
    });

    const { data: sent } = await shop.rpc('supplier_empties_sent', { p_supplier_id: supplierId });
    /*
     * `moved` is what has gone back or been written off; `outstanding` is what has not.
     *
     * Both, because the reader now carries two sides and a shop reads the account for both — "we
     * handed back forty" and "none are left" are different sentences and the screen says each.
     */
    const backRow = (sent ?? []).find((r) => r.side === 'we_hold');
    check(
      'the supplier account shows what went back',
      Number(backRow?.moved) === 40,
      `moved ${backRow?.moved}, outstanding ${backRow?.outstanding}`,
    );

    /*
     * AND THE YARD COMES DOWN — the whole reason this leg was missing.
     *
     * Before 0123 the yard figure could only climb: every crate a customer brought back added to
     * it and nothing took any away, so it was published as "counted on the 8th" rather than as a
     * balance. Forty going back is forty fewer standing there.
     */
    const after = (await shop.rpc('yard_empties', { p_store_id: storeId })).data ?? [];
    const yardAfter = Number(after.find((y) => y.product_unit_id === shape.id)?.in_yard);
    check(
      'and the yard comes down by what left',
      yardBefore - yardAfter === 40,
      `${yardBefore} -> ${yardAfter}`,
    );
  }

  // ── Both sides, settling separately ───────────────────────────────────────────────
  if (shape) {
    console.log(NL + '— and the crates that came in with the load —');

    /*
     * THEIR CRATES, STANDING IN THE YARD.
     *
     * A load arrives in the supplier's crates and they sit here until a lorry takes them. Nothing
     * could record that before, so the yard figure was what customers brought back minus what went
     * to breweries — two different sets of crates, which is why it could not reconcile.
     */
    const yardBefore = Number(
      ((await shop.rpc('yard_empties', { p_store_id: storeId })).data ?? []).find(
        (y) => y.product_unit_id === shape.id,
      )?.in_yard,
    );

    await shop.rpc('record_supplier_empties', {
      p_store_id: storeId,
      p_product_unit_id: shape.id,
      p_qty: 60,
      p_supplier_id: supplierId,
      p_side: 'we_hold',
      p_direction: 'out',
    });

    const yardAfter = Number(
      ((await shop.rpc('yard_empties', { p_store_id: storeId })).data ?? []).find(
        (y) => y.product_unit_id === shape.id,
      )?.in_yard,
    );
    check(
      'their crates arriving raise the yard',
      yardAfter - yardBefore === 60,
      `${yardBefore} -> ${yardAfter}`,
    );

    /*
     * AND OURS, GONE OUT WITH A LOAD — the other side, which settles on its own.
     *
     * A shop can be holding sixty of theirs while forty of its own are out with them. Netting those
     * to twenty is a figure neither party would recognise, and neither could be settled against it.
     */
    await shop.rpc('record_supplier_empties', {
      p_store_id: storeId,
      p_product_unit_id: shape.id,
      p_qty: 25,
      p_supplier_id: supplierId,
      p_side: 'they_hold',
      p_direction: 'out',
    });

    const { data: sides } = await shop.rpc('supplier_empties_sent', { p_supplier_id: supplierId });
    const weHold = (sides ?? []).find((r) => r.side === 'we_hold');
    const theyHold = (sides ?? []).find((r) => r.side === 'they_hold');
    check(
      'the two sides are counted apart, not netted',
      Number(weHold?.outstanding) === 20 && Number(theyHold?.outstanding) === 25,
      `we hold ${weHold?.outstanding}, they hold ${theyHold?.outstanding}`,
    );

    /*
     * PARTIAL, on one side only.
     *
     * Handing back twenty of the sixty leaves forty theirs and does not touch the twenty-five of
     * ours that are still out. That independence is the whole reason `side` exists.
     */
    await shop.rpc('record_supplier_empties', {
      p_store_id: storeId,
      p_product_unit_id: shape.id,
      p_qty: 20,
      p_supplier_id: supplierId,
      p_side: 'we_hold',
      p_direction: 'returned',
    });

    const { data: after2 } = await shop.rpc('supplier_empties_sent', { p_supplier_id: supplierId });
    const weHold2 = (after2 ?? []).find((r) => r.side === 'we_hold');
    const theyHold2 = (after2 ?? []).find((r) => r.side === 'they_hold');
    check(
      'settling one side leaves the other alone',
      Number(weHold2?.outstanding) === 0 && Number(theyHold2?.outstanding) === 25,
      `we hold ${weHold2?.outstanding}, they hold ${theyHold2?.outstanding}`,
    );

    const yardEnd = Number(
      ((await shop.rpc('yard_empties', { p_store_id: storeId })).data ?? []).find(
        (y) => y.product_unit_id === shape.id,
      )?.in_yard,
    );
    /*
     * BOTH SIDES MOVE THE YARD, and this assertion used to say otherwise.
     *
     * It expected `yardAfter - 20` — the twenty of theirs handed back — after a run that had ALSO
     * sent twenty-five of ours out on a lorry. That is the answer the old `yard_empties` gave,
     * because it weighed five of the nine ways a container moves and `they_hold` `out` was not one
     * of them. So the probe passed, and what it was actually asserting was the gap.
     *
     * Twenty-five crates leaving a yard is not a bookkeeping subtlety. 0128 weighs all nine, and
     * this line now fails against the function it was written for.
     */
    check(
      'and the yard weighs what came in against what left, both sides of it',
      yardEnd === yardAfter - 25 - 20,
      `${yardAfter} -> ${yardEnd}, expected ${yardAfter - 45}`,
    );
  }

  // ── One timeline ──────────────────────────────────────────────────────────────────
  console.log(NL + '— the story, in one list —');
  const { data: hist } = await shop.rpc('supplier_history', { p_supplier_id: supplierId });
  const kinds = new Set((hist ?? []).map((h) => h.kind));
  check(
    'money and containers share one timeline',
    kinds.has('paid') && kinds.has('charge') && (!shape || kinds.has('empties')),
    [...kinds].join(', '),
  );

  const { data: list } = await shop.rpc('suppliers_with_accounts', { p_store_id: storeId });
  const mine = (list ?? []).find((s) => s.id === supplierId);
  check('and they are on the suppliers list with what is owed', Number(mine?.owed) === 15000, `${mine?.owed}`);
} catch (e) {
  console.log(`${NL}  FAIL  ${String(e).split('\n')[0]}`);
  failed += 1;
} finally {
  /*
   * `supplier_payments` and `supplier_empties` are append-only and refuse a delete through the app;
   * the service key can remove them because they reference nothing else. The supplier goes with
   * them, which is only possible because it has no deliveries against it.
   */
  if (supplierId) {
    await admin.from('supplier_payments').delete().eq('supplier_id', supplierId);
    await admin.from('supplier_empties').delete().eq('supplier_id', supplierId);
    const { error } = await admin.from('suppliers').delete().eq('id', supplierId);
    if (error) await admin.from('suppliers').update({ status: 'archived' }).eq('id', supplierId);
  }
  const { data: left } = await admin
    .from('suppliers')
    .select('name,status')
    .eq('id', supplierId ?? '00000000-0000-0000-0000-000000000000');
  console.log(
    `${NL}left behind: ${(left ?? []).filter((r) => r.status !== 'archived').length} supplier(s)`,
  );
  console.log(`${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}
