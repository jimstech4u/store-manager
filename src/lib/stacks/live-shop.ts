'use client';

import { useEffect } from 'react';
import { getSupabase } from '@/lib/supabase/client';
import { invalidate } from '@/lib/stacks/invalidation';

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
};

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
      for (const scope of scopes) invalidate(scope);
    };

    const heard = (table: string, row: Record<string, unknown> | null | undefined) => {
      // This person's own write: already applied here, and already invalidated by its writer.
      if (row && userId && WRITER_COLUMNS.some((c) => row[c] === userId)) return;
      for (const scope of REACHES[table] ?? []) pending.add(scope);
      if (!timer) timer = setTimeout(flush, BATCH_MS);
    };

    let channel = supabase.channel(`shop:${storeId}`);
    for (const table of Object.keys(REACHES)) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `store_id=eq.${storeId}` },
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
}
