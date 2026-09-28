/**
 * TWO CUSTOMERS WHO WERE ONE RECORD, PUT BACK INTO TWO.
 *
 *     node scripts/split-kadijat-and-dcc.mjs --dry
 *     node scripts/split-kadijat-and-dcc.mjs
 *
 * Kadijat was added on 28 September, sold to three times, and then Dcc was added ON THE SAME PHONE
 * NUMBER. `upsert_customer` is keyed on (store, phone), so the insert conflicted and its
 * `do update set display_name = excluded.display_name` RENAMED Kadijat to Dcc and handed back her
 * id. Dcc's ₦63,100 receipt was then recorded against Kadijat's record, along with the crates it
 * owed and an opening bottle entered while adding her.
 *
 * The renaming itself is fixed in 0203 — one number is now one customer, and a second name on a
 * number the shop has already used is refused by name instead of silently taking the first one's
 * place. This script is only the data left behind.
 *
 * ── WHAT BELONGS TO WHOM ────────────────────────────────────────────────────────
 *
 *     Kadijat   09:52  ₦9,000    1 crate Goldberg
 *               10:08  ₦18,200   1 crate Goldberg, 1 crate Castle Lite
 *               11:26  ₦9,000    1 crate Goldberg
 *     Dcc       11:50            an opening bottle, entered as she was added
 *               12:10  ₦63,100   eight part-crates, and a half crate of Goldberg
 *
 * Confirmed by the shop against the totals, which is the only place that knowledge existed — the
 * database cannot tell two people apart once they share one row.
 *
 * ── HOW IT IS MOVED ─────────────────────────────────────────────────────────────
 *
 * THE RECEIPT IS NOT REWRITTEN. `amend_sale` would do this in one call, and it is the right door
 * for a correction a shop makes — but it replaces `sale_lines` wholesale from a payload this script
 * would have to rebuild, and rebuilding eleven lines of a real ₦63,100 receipt to change the name
 * on it risks the money to fix the label. The sale's customer is moved, and its lines are left
 * exactly as the seller entered them.
 *
 * THE EMPTIES ARE REVERSED, NOT MOVED. `customer_empties` is append-only — `tg_append_only` refuses
 * an update or a delete and says to append a reversing entry instead. So Kadijat's book gets a
 * `returned` entry cancelling each container that was never hers, carrying the reason, and Dcc's
 * book gets the `out` entry that should have been written on the day. Both sides stay readable
 * afterwards, which is the point of the rule: her history says what happened, including this.
 *
 * THE MONEY FOLLOWS THE RECEIPT. `amend_sale` moves an allocated payment only when the sale had no
 * customer before, on the reasoning that a payment already belonging to somebody is not that
 * correction's business. Here it is exactly this correction's business: the payment belongs to the
 * wrong person, and leaving it behind would bill Kadijat for Dcc's ₦63,100 while Dcc's money sat
 * against Kadijat's name.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry');

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const SID = '7138327c-c81c-4486-a97c-92207b48b64e';
const PROJECT = 'zinhzpgprhhqmyxmchhm';
const KADIJAT = '28885737-1e13-49b3-85d4-acaa1afe1ed8';
/** Dcc's own number, given by the shop. */
const DCC_PHONE = '+2347034666155';
/** Her receipt. The one thing on that record that was never Kadijat's. */
const HER_SALE = 'a77916bd';
const WHY = 'Not hers: this was Dcc, added on the same phone number';

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { error: authErr } = await shop.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
if (authErr) throw new Error('could not sign in: ' + authErr.message);

console.log(`\n${DRY ? 'PLAN' : 'SPLITTING'} — Kadijat and Dcc\n`);

// ══ 1. Dcc gets her own record ═════════════════════════════════════════════
const [sale] = await sql(
  `select id, total from public.sales where id::text like '${HER_SALE}%' and store_id = '${SID}'`,
);
if (!sale) throw new Error(`the ₦63,100 receipt ${HER_SALE} is not there`);

const existing = await sql(`
  select c.id, c.display_name from public.store_customers c
   join public.identities i on i.id = c.identity_id
  where c.store_id = '${SID}' and i.phone = '${DCC_PHONE.replace(/[^\d+]/g, '')}'`);

let dcc = existing[0]?.id ?? null;
console.log(`1. Dcc's own record: ${dcc ? `already there (${dcc.slice(0, 8)})` : 'to be created'}`);
if (!DRY && !dcc) {
  const { data, error } = await shop.rpc('upsert_customer', {
    p_store_id: SID,
    p_phone: DCC_PHONE,
    p_display_name: 'Dcc',
    p_business_name: null,
  });
  if (error) throw new Error('could not create Dcc: ' + error.message);
  dcc = data;
  console.log(`    created ${dcc.slice(0, 8)} on ${DCC_PHONE}`);
}

// ══ 2. What has to move ════════════════════════════════════════════════════
/*
 * Her containers, in three groups, because they arrived by three different doors:
 *
 *   - the eight the till owed when her receipt was posted (`ref_table = 'sale_lines'`)
 *   - the opening bottle typed in as she was added (no reference at all)
 *   - HALF A CRATE of the Goldberg correction. That correction recorded 3.5 crates in one row
 *     against one record, because at the time it WAS one record: three crates went to Kadijat
 *     across three receipts and the half came off Dcc's. One row cannot be split and cannot be
 *     edited, so the half is reversed on Kadijat and re-owed on Dcc like everything else.
 */
const rows = await sql(`
  select ce.id, ce.product_unit_id, ce.qty, ce.side, ce.occurred_at, ce.ref_table, ce.ref_id,
         p.name product, su.name word,
         (select l.sale_id::text from public.sale_lines l where l.id = ce.ref_id) sale_id,
         ce.reason
    from public.customer_empties ce
    join public.products p on p.id = ce.product_id
    join public.product_units pu on pu.id = ce.product_unit_id
    join public.store_units su on su.id = pu.store_unit_id
   where ce.store_customer_id = '${KADIJAT}' and ce.direction = 'out'
   order by ce.occurred_at`);

const hers = [];
for (const r of rows) {
  if ((r.sale_id ?? '').startsWith(HER_SALE)) hers.push({ ...r, move: Number(r.qty) });
  else if (r.ref_table === null && (r.reason ?? '').startsWith('What they already had'))
    hers.push({ ...r, move: Number(r.qty) });
  else if (r.product.startsWith('Goldberg') && Number(r.qty) === 3.5)
    hers.push({ ...r, move: 0.5 });
}

console.log(`\n2. containers to move off Kadijat's book: ${hers.length}`);
for (const h of hers) {
  const part = h.move === Number(h.qty) ? '' : ` (of ${Number(h.qty)})`;
  console.log(`    ${h.product.padEnd(32)} ${h.word.padEnd(6)} ${h.move}${part}`);
}

const pays = await sql(`
  select p.id, p.amount, p.method from public.payments p
   join public.payment_allocations a on a.payment_id = p.id
  where a.sale_id = '${sale.id}' and p.store_customer_id = '${KADIJAT}'`);
console.log(`\n3. payments on that receipt to follow it: ${pays.length}`);
for (const p of pays) console.log(`    ₦${p.amount} ${p.method}`);

// ══ 3. Move it ═════════════════════════════════════════════════════════════
if (!DRY) {
  // The receipt itself. Its lines are untouched — only whose receipt it is changes.
  await sql(`
    update public.sales
       set store_customer_id = '${dcc}',
           amend_reason = 'Recorded against Kadijat: Dcc was added on the same phone number'
     where id = '${sale.id}';
    update public.payments p
       set store_customer_id = '${dcc}'
      from public.payment_allocations a
     where a.payment_id = p.id and a.sale_id = '${sale.id}'
       and p.store_customer_id = '${KADIJAT}';`);
  console.log('\n    the receipt and its money are Dcc\'s');

  for (const h of hers) {
    const back = await shop.rpc('record_customer_empties', {
      p_store_id: SID,
      p_customer_id: KADIJAT,
      p_product_unit_id: h.product_unit_id,
      p_direction: 'returned',
      p_qty: h.move,
      p_reason: WHY,
      p_ref_table: null,
      p_ref_id: null,
      p_occurred_at: null,
      p_side: h.side,
    });
    if (back.error) {
      console.log(`    FAILED to clear ${h.product} off Kadijat: ${back.error.message}`);
      continue;
    }
    const out = await shop.rpc('record_customer_empties', {
      p_store_id: SID,
      p_customer_id: dcc,
      p_product_unit_id: h.product_unit_id,
      p_direction: 'out',
      p_qty: h.move,
      p_reason: 'Moved from Kadijat: this was Dcc\'s from the start',
      p_ref_table: h.ref_table,
      p_ref_id: h.ref_id,
      p_occurred_at: h.occurred_at,
      p_side: h.side,
    });
    console.log(
      out.error
        ? `    FAILED to owe ${h.product} against Dcc: ${out.error.message}`
        : `    ${h.product} ${h.move} ${h.word.toLowerCase()} → Dcc`,
    );
  }
}

// ══ 4. Where they both stand ═══════════════════════════════════════════════
console.log('\n── where they stand now ──');
for (const c of await sql(`
  select c.display_name, i.phone,
         (select count(*) from public.sales s where s.store_customer_id = c.id) sales,
         (select coalesce(sum(s.total), 0) from public.sales s
           where s.store_customer_id = c.id and s.status = 'posted') traded
    from public.store_customers c join public.identities i on i.id = c.identity_id
   where c.store_id = '${SID}' order by c.created_at`)) {
  console.log(`  ${c.display_name.padEnd(9)} ${String(c.phone).padEnd(15)} ` +
    `${c.sales} sale(s), ₦${Number(c.traded).toLocaleString()}`);
  for (const e of await sql(`
    select p.name, su.name word,
           sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) owed
      from public.customer_empties ce
      join public.products p on p.id = ce.product_id
      join public.product_units pu on pu.id = ce.product_unit_id
      join public.store_units su on su.id = pu.store_unit_id
      join public.store_customers sc on sc.id = ce.store_customer_id
     where sc.store_id = '${SID}' and sc.display_name = '${c.display_name}'
     group by p.name, su.name
    having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) <> 0
     order by p.name`)) {
    console.log(`      ${Number(e.owed)} ${e.word.toLowerCase()} — ${e.name}`);
  }
}

console.log(DRY ? '\nNothing was written. Drop --dry to split.' : '\ndone');
