/**
 * Link the cash a walk-in already handed over to the sale it was for.
 *
 * `settle_sale` recorded a walk-in's payment and never allocated it (fixed in 0074). `payments`
 * has no `sale_id`, and everything that reports what a sale was paid reads `payment_allocations` —
 * so the money existed, unattached, while the sale read as owing its full total. On the receipt,
 * in the sales list, in the day's takings.
 *
 * This repairs the ones already recorded. It is NOT part of the migration on purpose: changing
 * behaviour from now on is a fix, and rewriting historical money records is a decision for the
 * shop to take deliberately.
 *
 * WHAT IT MATCHES, and why it is safe:
 *
 *   Only sales with no customer, no allocation at all, and not void.
 *   Only payments with no customer, no allocation, in the same shop, on the same sale's timestamp
 *   to the second — `settle_sale` writes both in one transaction with the same `occurred_at`, so
 *   this is the pairing the code itself created, recovered rather than guessed.
 *   Only when the amounts agree exactly.
 *
 * Anything that does not match cleanly is listed and left alone, for somebody to look at.
 *
 *     node scripts/link-walkin-payments.mjs           # says what it would do
 *     node scripts/link-walkin-payments.mjs --commit  # does it
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const COMMIT = process.argv.includes('--commit');

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

const money = (n) => `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;

// ── The sales that look unpaid ───────────────────────────────────────────────────────────────
const { data: sales, error } = await admin
  .from('sales')
  .select('id, total, occurred_at, store_id, status, store_customer_id')
  .is('store_customer_id', null)
  .neq('status', 'void')
  .order('occurred_at');

if (error) {
  console.error('Could not read the sales:', error.message);
  process.exit(1);
}

const unlinked = [];
for (const s of sales ?? []) {
  const { count } = await admin
    .from('payment_allocations')
    .select('id', { count: 'exact', head: true })
    .eq('sale_id', s.id);
  if ((count ?? 0) === 0) unlinked.push(s);
}

console.log(`walk-in sales with nothing allocated: ${unlinked.length}`);
console.log(`shown as unpaid:                      ${money(unlinked.reduce((t, s) => t + Number(s.total), 0))}`);

const pairs = [];
const unmatched = [];

for (const s of unlinked) {
  // The payment `settle_sale` wrote in the same transaction: same shop, no customer, same instant.
  const { data: candidates } = await admin
    .from('payments')
    .select('id, amount, occurred_at')
    .eq('store_id', s.store_id)
    .is('store_customer_id', null)
    .eq('occurred_at', s.occurred_at);

  const free = [];
  for (const c of candidates ?? []) {
    const { count } = await admin
      .from('payment_allocations')
      .select('id', { count: 'exact', head: true })
      .eq('payment_id', c.id);
    if ((count ?? 0) === 0) free.push(c);
  }

  const exact = free.filter((c) => Math.abs(Number(c.amount) - Number(s.total)) < 0.005);

  if (exact.length === 1) {
    pairs.push({ sale: s, payment: exact[0] });
  } else {
    unmatched.push({
      sale: s,
      why:
        free.length === 0
          ? 'no unallocated payment at that instant'
          : exact.length === 0
            ? `amounts differ (${free.map((c) => money(c.amount)).join(', ')} vs ${money(s.total)})`
            : `${exact.length} payments match — ambiguous`,
    });
  }
}

console.log(`\nmatched cleanly:  ${pairs.length}`);
console.log(`left for a person: ${unmatched.length}`);
for (const u of unmatched) {
  console.log(`   ${u.sale.id.slice(0, 8)} ${money(u.sale.total)} — ${u.why}`);
}

if (!COMMIT) {
  console.log('\nNothing changed. Re-run with --commit to link the matched ones.');
  process.exit(0);
}

let linked = 0;
for (const { sale, payment } of pairs) {
  const { error: err } = await admin
    .from('payment_allocations')
    .insert({ payment_id: payment.id, sale_id: sale.id, amount: payment.amount });
  if (err) console.error(`   could not link ${sale.id.slice(0, 8)}: ${err.message}`);
  else linked += 1;
}

console.log(`\nlinked ${linked} payment(s) to the sale they were for`);
