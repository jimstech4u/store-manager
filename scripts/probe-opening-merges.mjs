/**
 * A new customer's opening balance, and the sales that follow, adding up to ONE figure.
 *
 * This is the seam the tidy-up closed. The customer form writes opening empties into
 * `customer_empties`; a sale writes its containers there too, through the trigger on `sale_lines`.
 * Before 0119 the account screen was still reading `deposit_ledger` — so the empties page and the
 * account page answered the same question from two ledgers, both live, both growing, drifting apart
 * from the first sale onwards.
 *
 * So this checks the merge from BOTH ENDS: the ledger the empties screen reads, and the account
 * object every money screen reads. If those two ever disagree the shop has two truths again.
 *
 *     node scripts/probe-opening-merges.mjs [http://localhost:3100]
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
const NAME = `ZZ Merge ${stamp}`;

const { data: cust } = await shop.rpc('upsert_customer', {
  p_store_id: storeId,
  p_phone: `0805${stamp}00`.slice(0, 11),
  p_display_name: NAME,
  p_business_name: 'Dans',
});
const cid = typeof cust === 'string' ? cust : cust?.id;

const shapeOf = async (product, unit) => {
  const { data } = await admin
    .from('product_units')
    .select('id, products!inner(id, name, store_id), store_units!inner(name)')
    .eq('is_returnable', true)
    .eq('products.store_id', storeId);
  return (data ?? []).find(
    (r) =>
      r.products.name.toLowerCase().includes(product.toLowerCase()) &&
      r.store_units.name.toLowerCase() === unit.toLowerCase(),
  );
};

let saleId = null;

try {
  const gulder = await shapeOf('Gulder', 'Crate');
  check('there is a returnable shape to trade in', Boolean(gulder), gulder?.products?.name);
  if (!gulder) throw new Error('nothing returnable to test with');

  // ── What the book says they already had ───────────────────────────────────────────
  console.log(NL + '— the opening balance, as the customer form writes it —');
  await shop.rpc('record_customer_empties', {
    p_store_id: storeId,
    p_customer_id: cid,
    p_product_unit_id: gulder.id,
    p_direction: 'out',
    p_qty: 3,
    p_reason: 'What they already had when the account opened',
  });

  const owedAfterOpening = async () => {
    const { data } = await shop.rpc('customer_empties_owed', { p_store_customer_id: cid });
    return (data ?? []).find((r) => r.product_unit_id === gulder.id)?.owed ?? 0;
  };
  check('three crates are owed from the book', Number(await owedAfterOpening()) === 3);

  // ── And then they buy ─────────────────────────────────────────────────────────────
  console.log(NL + '— and then they buy two and a half more —');

  /*
   * WRITTEN AS A SALE LINE, which is the whole point.
   *
   * Nothing here calls the empties writer. The obligation follows from the line existing — that is
   * what the trigger from 0117 is for — so this proves the merge rather than performing it.
   */
  const { data: sale } = await admin
    .from('sales')
    .insert({
      store_id: storeId,
      store_customer_id: cid,
      status: 'posted',
      total: 0,
      client_uuid: crypto.randomUUID(),
    })
    .select('id')
    .single();
  saleId = sale.id;

  await admin.from('sale_lines').insert({
    sale_id: saleId,
    product_id: gulder.products.id,
    sale_unit_id: gulder.id,
    entered_qty: 2.5,
    base_qty: 30,
    unit_price: 0,
    line_total: 0,
  });

  const merged = Number(await owedAfterOpening());
  check(
    'the sale adds to the book, it does not replace it — 5.5',
    merged === 5.5,
    `${merged} crates`,
  );

  // ── And BOTH screens say the same ─────────────────────────────────────────────────
  console.log(NL + '— and every screen reads the same ledger —');
  const { data: account } = await shop.rpc('customer_account', { p_store_customer_id: cid });
  const onAccount = (account?.empties ?? []).find(
    (e) => e.product_unit_id === gulder.id,
  );
  check(
    'the account page agrees with the empties page',
    Number(onAccount?.qty) === merged,
    `account ${onAccount?.qty} vs ledger ${merged}`,
  );
  check(
    'and names the product and shape, not a pool',
    Boolean(onAccount?.product) && !/NBL (crate|bottle)/i.test(String(onAccount?.product)),
    `${onAccount?.product} ${onAccount?.unit_plural}`,
  );

  /*
   * THE OLD LEDGER STAYS STILL.
   *
   * `returnables_for_sale` is retired to an empty result, so `record_sale` writes no pool rows any
   * more. If this ever climbs, a sale is being recorded twice in two vocabularies again — which is
   * the exact fault this migration set exists to remove.
   */
  const { count: poolRows } = await admin
    .from('deposit_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('store_customer_id', cid);
  check('and nothing reached the retired pool ledger', (poolRows ?? 0) === 0, `${poolRows} row(s)`);

  // ── The deposit is money, and stays out of it ─────────────────────────────────────
  console.log(NL + '— the deposit is money and nothing to do with the crates —');
  await shop.rpc('take_customer_deposit', {
    p_store_id: storeId,
    p_customer_id: cid,
    p_amount: 20000,
    p_reason: 'Held when the account opened',
  });

  const { data: account2 } = await shop.rpc('customer_account', { p_store_customer_id: cid });
  check(
    'the account holds it as ONE figure, not a count of crates',
    Number(account2?.deposits_held) === 20000,
    `${JSON.stringify(account2?.deposits_held)}`,
  );

  const stillOwed = (account2?.empties ?? []).find((e) => e.product_unit_id === gulder.id);
  check(
    'and taking it changed nothing about what they are holding',
    Number(stillOwed?.qty) === merged,
    `${stillOwed?.qty}`,
  );
} catch (e) {
  console.log(`${NL}  FAIL  ${String(e).split('\n')[0]}`);
  failed += 1;
} finally {
  /*
   * The sale and its line CAN go — `sales` is not append-only — and removing the line is what
   * removes the obligation it created, because the ledger row references it. The ledger rows
   * themselves refuse a delete, so the customer is archived instead and what is left is said.
   */
  if (saleId) {
    await admin.from('sale_lines').delete().eq('sale_id', saleId);
    await admin.from('sales').delete().eq('id', saleId);
  }
  if (cid) await admin.from('store_customers').update({ status: 'archived' }).eq('id', cid);

  const { data: left } = await admin
    .from('customer_empties')
    .select('id')
    .eq('store_customer_id', cid ?? '00000000-0000-0000-0000-000000000000');
  console.log(
    `${NL}left behind: ${(left ?? []).length} append-only row(s) on an archived customer`,
  );
  console.log(`${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}
