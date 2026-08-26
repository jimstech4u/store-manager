'use client';

import { useCallback, useEffect, useState } from 'react';
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
   * state-stack holds the CACHE; React state holds what is on screen.
   *
   * The cache is what makes returning to a customer instant: the last figures for them are
   * persisted, so the page opens with their balance already drawn and corrects it a moment later
   * instead of showing a spinner over a number that was very nearly right.
   *
   * Driving the fetch through `demand()` was tried and abandoned. It decides for itself when a
   * loader is stale enough to re-run, and after a write cleared the scope it stopped running the
   * loader at all — the page sat on "Loading the account" with nothing in flight and no error to
   * show for it. Asking for the data plainly, and handing the answer to the cache, is predictable:
   * the load either returns or throws, and both are handled here.
   */
  // [value, demand, set, meta] — the SECOND slot is the demand loader, not the setter.
  const [cached, , setCached] = useDemandState<{
    account: CustomerAccount | null;
    history: HistoryEvent[];
  }>(
    { account: null, history: [] },
    {
      key: `account:${customerId ?? 'none'}`,
      scope: ACCOUNT_SCOPE,
      persist: true,
      deps: [customerId ?? ''],
      // Working as a cache, not a loader: nothing here re-runs on mount, because the fetch below
      // is what runs on mount.
      revalidateOnMount: false,
    },
  );

  const [account, setAccount] = useState<CustomerAccount | null>(cached.account);
  const [history, setHistory] = useState<HistoryEvent[]>(cached.history);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(cached.account === null);

  // Adopt the cached value once it hydrates from storage, so the first paint after a cold start
  // has something in it rather than a spinner.
  useEffect(() => {
    if (cached.account && !account) {
      setAccount(cached.account);
      setHistory(cached.history);
      setLoading(false);
    }
  }, [cached, account]);

  const load = useCallback(async () => {
    if (!customerId) return;
    setError(null);
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

      const next = {
        account: a.data as CustomerAccount,
        history: (h.data ?? []) as HistoryEvent[],
      };
      setAccount(next.account);
      setHistory(next.history);
      /*
       * Persisted for the next visit.
       *
       * The plain setter takes a value, not options — `override` belongs to the `set` handed to a
       * demand loader. It is not needed here anyway: this always writes a whole object with an
       * `account` in it, which state-stack does not mistake for emptiness. The case that WOULD
       * have needed it — a customer paid off to zero — is a zero balance inside a present object,
       * not an absent one.
       */
      setCached(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this account.');
    } finally {
      // Always cleared, on both paths. Leaving it set on the error path is how a screen ends up
      // spinning forever over a request that finished.
      setLoading(false);
    }
  }, [customerId, setCached]);

  useEffect(() => {
    void load();
  }, [load]);

  return { account, history, error, loading: loading && account === null, reload: load };
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
  const [pools, , setPools] = useDemandState<EmptiesPool[]>([], {
    key: `pools:${storeId ?? 'none'}`,
    scope: CATALOG_SCOPE,
    persist: true,
    deps: [storeId ?? ''],
    ttl: 10 * 60_000,
  });

  useEffect(() => {
    if (!storeId) return;
    // Driven here for the same reason as the account above; state-stack keeps the answer so the
    // picker is populated the moment an action screen opens.
    void (async () => {
      const { data } = await getSupabase()
        .from('empties_categories')
        .select('id, name, kind, deposit')
        .eq('store_id', storeId)
        .order('name');
      if (data) setPools(data as EmptiesPool[]);
    })();
  }, [storeId, setPools]);

  return pools;
}
