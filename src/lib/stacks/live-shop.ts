'use client';

import { useEffect } from 'react';
import { getSupabase } from '@/lib/supabase/client';
import { invalidateHeard, wroteHereRecently } from '@/lib/stacks/invalidation';
import { useWakeRefresh } from '@/hooks/useWakeRefresh';

/**
 * WHAT ANOTHER TILL RECORDS, HEARD HERE AS IT HAPPENS.
 *
 * Every screen already re-reads when its scope is invalidated — that is how a write on THIS device
 * reaches the screens that show it. Other devices could only reach it on the next genuine read: a
 * page returned to, a Try again. So a sale on the front till moved the stock, the customer's balance
 * and their crates, and the back till learned of it when somebody happened to leave a screen.
 *
 * This subscribes to the shop's own rows (0153 publishes them; realtime applies row security, so a
 * member hears only what they could already read) and turns each change into the invalidations a
 * write on this device would have made. The payload is a SIGNAL, never data: the screens re-read the
 * figures from the server, which stays the only source of them. (academix-web does the same with its
 * subscription managers — the balance, the transactions.)
 *
 * WHAT IT SKIPS: a row this person wrote. That change was applied locally the moment it was made
 * (`local-effects.ts`) and its writer already invalidated — hearing it back would be a round trip to
 * learn what this device decided, which is exactly what `probe-no-round-trip` exists to forbid.
 *
 * BATCHED: one sale writes a sale, its lines' movements, a payment, containers — a dozen rows in a
 * moment. The scopes they touch are collected and invalidated once, shortly after the burst.
 */

/** Which screens each table's changes reach, by the scopes those screens read under. */
const REACHES: Record<string, string[]> = {
  // A sale: balances and reports, the sales list, who owes, the People list.
  sales: ['account_derived', 'money_flow', 'customer_flow'],
  payments: ['account_derived', 'money_flow', 'customer_flow'],
  customer_charges: ['account_derived', 'money_flow'],
  // Stock moving: what is on hand and what it is worth, the stock list, today's counts.
  stock_movements: ['catalog_derived', 'catalog_flow'],
  stock_periods: ['counts-today', 'catalog_derived'],
  stock_count_edits: ['counts-today', 'catalog_derived'],
  // Containers and deposits: the two ledgers, and the account page that shows both.
  customer_empties: ['customer_ledgers', 'account_derived'],
  customer_deposits: ['customer_ledgers', 'account_derived'],
  // The catalogue and the people in it.
  products: ['catalog_flow', 'catalog_derived'],
  store_customers: ['customer_flow', 'money_flow'],
  expenses: ['expenses'],

  /*
   * ── WHAT A SHOP ACTUALLY EDITS (0208) ─────────────────────────────────────
   *
   * "we can edit any data in the app and we want to ensure that site used or using are updating
   * as well ... shapes and all of that."
   *
   * This map had eleven tables and none of them held a shape, a price, a maker or an expiry date
   * — so a price changed on the back till stayed old on the front one until somebody happened to
   * leave a screen and come back. On ONE device it was always right, because `catalogChanged`
   * invalidates the derived scope, which is what makes this the kind of fault that gets reported
   * as "it sometimes shows the old figure" and never reproduces for the person looking.
   */
  // A shape: its price, whether it is sold, whether it comes back, what it holds.
  product_units: ['catalog_flow', 'catalog_derived'],
  // The cheaper price for taking more, and the mirror the storefront reads.
  product_price_tiers: ['catalog_derived'],
  product_sale_units: ['catalog_derived'],
  // A lot's expiry date, corrected on the product form.
  stock_layers: ['catalog_derived'],
  // The makers, and which product belongs to which — what the empties roll-up reads.
  product_categories: ['catalog_flow', 'catalog_derived', 'customer_ledgers'],
  product_category_links: ['catalog_flow', 'catalog_derived', 'customer_ledgers'],
  /*
   * Which receipt a payment settles. Taking a payment back removes its allocation and writes no
   * `payments` row for the receipt at all (0205), so without this the other till goes on showing
   * a receipt as paid by money that has been reversed.
   */
  payment_allocations: ['account_derived', 'money_flow', 'customer_flow'],
  // A delivery, and who it came from.
  purchases: ['catalog_derived', 'money_flow'],
  suppliers: ['money_flow'],
  /*
   * A customer's phone number, which lives on the shared identity rather than on the customer.
   * Realtime applies row security, so this is only ever heard for identities the member can
   * already read.
   */
  identities: ['customer_flow'],

  /*
   * ── THE REST OF WHAT A SHOP WRITES (0226) ───────────────────────────────────
   *
   * The audit found nine tables no other till ever heard. Each is a figure some screen shows.
   */
  deposit_holdings: ['customer_ledgers', 'account_derived'],
  variance_resolutions: ['counts-today', 'catalog_derived', 'variance-reasons'],
  supplier_payments: ['suppliers', 'money_flow'],
  supplier_empties: ['suppliers', 'yard'],
  empties_counts: ['yard'],
  store_units: ['catalog_flow', 'catalog_derived', 'product_shapes'],
  // `receipt_paper` follows `store_settings` by itself (scopeDependsOn, invalidation.ts).
  store_settings: ['store_settings', 'settings_flow', 'low_stock'],
  product_low_stock_levels: ['catalog_derived', 'low_stock'],
  sale_charges: ['account_derived', 'money_flow'],

  /*
   * ── ORDERS OPEN ON THE TILL (0273) ───────────────────────────────────────────
   *
   * "When we are using multiple devices and open one from the background, we have to close and
   * reopen to see changes like draft order changes." They were never published, so an order built,
   * changed or settled on one device reached no other. The till re-reads its open orders on
   * `sell_flow`, keeping any tab with edits this device has not sent yet.
   */
  draft_orders: ['sell_flow', 'online_orders'],
  draft_order_lines: ['sell_flow'],
};

/** Tables whose rows name no writer: an echo of this device's own save is told apart by time alone. */
const NO_WRITER = new Set(['draft_order_lines']);

/*
 * TABLES WITH NO `store_id` — heard WITHOUT the shop filter.
 *
 * Every subscription filtered `store_id=eq.<shop>`, and six of these tables have no such column. The
 * channel still joined (measured: SUBSCRIBED either way), so nothing looked wrong — but a filter on
 * a column that does not exist matches nothing, and a price, a shape, a maker link or a payment's
 * allocation changed on one till was never heard on another. Realtime applies row security, so an
 * unfiltered subscription still only carries rows of shops this member belongs to.
 */
const NO_STORE_COLUMN = new Set([
  'product_units',
  'product_price_tiers',
  'product_sale_units',
  'product_category_links',
  'payment_allocations',
  'identities',
  'product_low_stock_levels',
  'sale_charges',
  'draft_order_lines',
]);

/** Columns that name who wrote a row, where the table has one. */
const WRITER_COLUMNS = ['created_by', 'counted_by', 'edited_by'] as const;

const BATCH_MS = 900;

export function useLiveShop(storeId: string | null, userId: string | null) {
  useEffect(() => {
    if (!storeId) return;
    const supabase = getSupabase();

    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const scopes = [...pending];
      pending.clear();
      for (const scope of scopes) invalidateHeard(scope);
    };

    const heard = (table: string, row: Record<string, unknown> | null | undefined) => {
      // THIS DEVICE'S own write: already applied here and already invalidated by its writer. Judged by
      // time as well as name, because the same person on another phone is another device.
      if (wroteHereRecently() && (NO_WRITER.has(table) || (row && userId && WRITER_COLUMNS.some((c) => row[c] === userId)))) return;
      for (const scope of REACHES[table] ?? []) pending.add(scope);
      if (!timer) timer = setTimeout(flush, BATCH_MS);
    };

    let channel = supabase.channel(`shop:${storeId}`);
    for (const table of Object.keys(REACHES)) {
      channel = channel.on(
        'postgres_changes',
        NO_STORE_COLUMN.has(table)
          ? { event: '*', schema: 'public', table }
          : { event: '*', schema: 'public', table, filter: `store_id=eq.${storeId}` },
        (payload) =>
          heard(
            table,
            (payload.new && Object.keys(payload.new).length > 0 ? payload.new : payload.old) as
              | Record<string, unknown>
              | undefined,
          ),
      );
    }
    channel.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [storeId, userId]);

  /*
   * AND WHAT WAS MISSED WHILE THE APP WAS AWAY. A phone puts a backgrounded app to sleep and its
   * connection with it: whatever changed meanwhile was never heard. Coming back is when to catch up —
   * every scope this hook would have reached, re-read once, as if all of it had been heard.
   */
  useWakeRefresh(() => {
    if (!storeId) return;
    for (const scope of new Set(Object.values(REACHES).flat())) invalidateHeard(scope);
  }, 15_000);
}
