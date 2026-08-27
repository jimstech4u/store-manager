'use client';

import { useCallback, useEffect } from 'react';
import { StateStack, useDemandState } from '@academix-admin/state-stack';
import { getSupabase } from '@/lib/supabase/client';

/**
 * One customer's whole position, and the events behind it.
 *
 * Deliberately three obligations rather than one balance, because that is how a distributor
 * actually thinks and how disputes actually go: money owed, containers still out, and money the
 * shop is holding. They settle in different ways — cash, crates, and a refund — and rolling them
 * into a single figure is what makes an account impossible to explain across a counter.
 */

export interface AccountEmpties {
  category_id: string;
  category: string;
  kind: 'content' | 'container';
  qty: string;
  /** Money actually held against this pool, at the rate it was taken. Often zero. */
  held: string;
}

export interface AccountDeposit {
  category_id: string;
  category: string;
  qty: string;
  amount: string;
}

export interface CustomerAccount {
  customer: { id: string; name: string; business: string | null; phone: string };
  balance: string;
  money: { goods: string; deposits_charged: string; paid: string };
  charges: { label: string; amount: string }[];
  empties: AccountEmpties[];
  deposits_held: AccountDeposit[];
}

export interface HistoryEvent {
  occurred_at: string;
  kind:
    | 'sale'
    | 'payment'
    | 'refund'
    | 'deposit_taken'
    | 'deposit_returned'
    | 'forfeit';
  label: string;
  detail: string | null;
  amount: string | null;
  qty_units: string | null;
  category_id: string | null;
  ref_table: string | null;
  ref_id: string | null;
  actor: string;
}

/**
 * The scope every customer figure lives in.
 *
 * Named so a write anywhere in the app can invalidate it — `accountsChanged()` below — rather than
 * each screen guessing when its own numbers went out of date.
 */
export const ACCOUNT_SCOPE = 'customer_flow';

/**
 * The shop's own configuration — its empties pools — kept OUT of the account scope.
 *
 * They started in it, and leaving a customer's account cleared them: the account page drops
 * `customer_flow` on exit, which is right for one customer's figures and wrong for a list of pools
 * that belongs to the shop. The next screen needing a pool picker found it empty.
 *
 * Different lifetimes want different scopes. A customer's balance is stale the moment they pay;
 * the set of crate types a shop deals in changes about never.
 */
export const CATALOG_SCOPE = 'catalog_flow';

/**
 * Tell every account screen its figures are out of date.
 *
 * Called after anything that moves money or containers: settling a sale, recording a payment,
 * taking or returning a deposit. The next screen to mount refetches instead of showing what it
 * cached before the write.
 *
 * This is the piece that replaced a timer. The screens used to poll every few seconds because
 * nothing told them anything had changed — which is both wasteful and still wrong for the first
 * few seconds after a sale, exactly when someone is looking. A write knows it happened; it should
 * say so.
 */
export function accountsChanged() {
  void StateStack.core.clearScope(ACCOUNT_SCOPE);
}

/**
 * One customer's position and history, cached and revalidated.
 *
 * Held in state-stack rather than in `useState`, for two reasons that are really one:
 *
 *   IT HYDRATES. Coming back to a customer shows their balance immediately, from the last value
 *   saved, instead of a spinner while a round trip completes. On the connections this runs over
 *   that spinner was most of the interaction.
 *
 *   IT REVALIDATES. The cached value is a starting point, not the answer: the loader still runs
 *   when the customer changes, when the TTL expires, or when a write has invalidated the scope.
 *
 * `revalidateOnMount` stays true. This is FETCHED data about money, not working state — the draft
 * orders are the ones that must survive a remount untouched, and they set it false for that
 * reason.
 */
export function useCustomerAccount(customerId: string | null) {
  /*
   * The demand loader, as intended — no workaround.
   *
   * state-stack hydrates the last figures for this customer, so the page opens with their balance
   * already drawn and corrects it a moment later rather than showing a spinner over a number that
   * was very nearly right. `accountsChanged()` invalidates the scope, and as of state-stack 0.2.3
   * that makes every mounted consumer re-run its loader — which is what invalidation should have
   * meant all along.
   *
   * Two things were wrong here before and both are gone: driving the fetch by hand because
   * `demand()` would not re-fire after a clear (fixed in the package), and a `loading` flag that
   * could never clear on the error path.
   */
  const [state, demand] = useDemandState<{
    account: CustomerAccount | null;
    history: HistoryEvent[];
    error: string | null;
    settled: boolean;
  }>(
    { account: null, history: [], error: null, settled: false },
    {
      key: `account:${customerId ?? 'none'}`,
      scope: ACCOUNT_SCOPE,
      persist: true,
      deps: [customerId ?? ''],
      // Half a minute. Long enough that flicking between screens does not re-fetch on every step,
      // short enough that a figure nobody explicitly invalidated still corrects itself.
      ttl: 30_000,
    },
  );

  const load = useCallback(() => {
    if (!customerId) return;
    demand(async ({ set }) => {
      try {
        const supabase = getSupabase();
        // Together: a page that showed the balance and then filled the history in a moment later
        // would jump under someone already reading it.
        const [a, h] = await Promise.all([
          supabase.rpc('customer_account', { p_store_customer_id: customerId }),
          supabase.rpc('customer_history', { p_store_customer_id: customerId, p_limit: 200 }),
        ]);
        if (a.error) throw a.error;
        if (h.error) throw h.error;
        set(
          {
            account: a.data as CustomerAccount,
            history: (h.data ?? []) as HistoryEvent[],
            error: null,
            settled: true,
          },
          // A customer who has just paid everything off genuinely HAS a zero balance and an empty
          // history; without this state-stack would read that as "no value" and keep the figures
          // from before they paid.
          { override: true },
        );
      } catch (e) {
        set(
          {
            account: null,
            history: [],
            error: e instanceof Error ? e.message : 'Could not load this account.',
            settled: true,
          },
          { override: true },
        );
      }
    });
  }, [customerId, demand]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    account: state.account,
    history: state.history,
    error: state.error,
    /*
     * `settled` rather than a separate flag.
     *
     * It is part of the same value the loader writes, so it cannot get out of step with it — which
     * is exactly how the previous version hung: a `loading` boolean that the error path never
     * cleared, leaving a spinner over a request that had finished.
     */
    loading: !state.settled && state.account === null,
    reload: load,
  };
}

export interface EmptiesPool {
  id: string;
  name: string;
  kind: 'content' | 'container';
  deposit: string;
}

/**
 * The pools this shop uses, for the pickers on every empties action.
 *
 * Cached and hydrated too, with a long TTL: a shop's set of pools changes about never, and making
 * every action screen wait on the same query is a spinner over a select box that already knows
 * what it should contain.
 */
export function useEmptiesPools(storeId: string | null) {
  const [pools, demandPools] = useDemandState<EmptiesPool[]>([], {
    key: `pools:${storeId ?? 'none'}`,
    scope: CATALOG_SCOPE,
    persist: true,
    deps: [storeId ?? ''],
    ttl: 10 * 60_000,
  });

  useEffect(() => {
    if (!storeId) return;
    demandPools(async ({ set }) => {
      const { data } = await getSupabase()
        .from('empties_categories')
        .select('id, name, kind, deposit')
        .eq('store_id', storeId)
        .order('name');
      set((data ?? []) as EmptiesPool[], { override: true });
    });
  }, [storeId, demandPools]);

  return pools;
}
