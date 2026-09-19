'use client';

import { useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';
import { invalidate } from '@/lib/stacks/invalidation';

/**
 * One customer's whole position, and the events behind it.
 *
 * Deliberately three obligations rather than one balance, because that is how a distributor
 * actually thinks and how disputes actually go: money owed, containers still out, and money the
 * shop is holding. They settle in different ways — cash, crates, and a refund — and rolling them
 * into a single figure is what makes an account impossible to explain across a counter.
 */

export interface AccountEmpties {
  /** Null for containers owed to a MAKER rather than a product — what a book carries across. */
  product_id: string | null;
  product: string;
  product_unit_id: string | null;
  unit: string;
  unit_plural: string;
  group: string | null;
  qty: string | number;
}

/**
 * What the shop is holding, as ONE figure.
 *
 * It was a row per pool with a quantity and a rate. A shop does not hold twenty crates' worth of
 * money; it holds forty thousand naira, and expressing that as containers is exactly why a plain
 * deposit could not be recorded at all.
 */
export type AccountDeposit = number;

export interface CustomerAccount {
  customer: { id: string; name: string; business: string | null; phone: string };
  balance: string;
  money: { goods: string; deposits_charged: string; paid: string };
  charges: { label: string; amount: string }[];
  empties: AccountEmpties[];
  deposits_held: number;
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
 * The scope for figures only the server can work out — a balance, a statement, empties owed.
 *
 * Separate from the one the customer LISTS live in, and that separation is the point. Notifying
 * the list's scope meant settling a sale re-read every customer in the shop to learn one person's
 * balance had moved — a round trip for something the till had just done, with the old figure on
 * screen until it landed. The lists are told their own news through `useListChannel`.
 */
export const ACCOUNT_DERIVED_SCOPE = 'account_derived';

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
  // Told, not deleted — see `invalidate`. Clearing took the People list and the customer picker
  // with it, both of which live in this scope and neither of which the writer knows about.
  invalidate(ACCOUNT_DERIVED_SCOPE);
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
   * A RESOURCE, for two faults the old loader had.
   *
   * A refresh that failed WIPED the account: it wrote `{ account: null, history: [] }` over what was
   * on screen, so a customer's page went blank on a flaky connection — the rule this app already had
   * ("a loader never blanks") broken by the one screen a dispute is settled on. And `reload` did not
   * read: the demand was already spent, so the Try again button and the refresh on resume did
   * nothing at all.
   *
   * New key (`account:v2`): the old cached value could be a failure record with `account: null`,
   * which read back as "loaded" would render an account that is not there.
   */
  const r = useResource<{ account: CustomerAccount; history: HistoryEvent[] }>({
    key: `account:v2:${customerId ?? 'none'}`,
    scope: ACCOUNT_DERIVED_SCOPE,
    enabled: Boolean(customerId),
    read: async () => {
      const supabase = getSupabase();
      // Together: a page that showed the balance and then filled the history in a moment later
      // would jump under someone already reading it.
      const [a, h] = await Promise.all([
        supabase.rpc('customer_account', { p_store_customer_id: customerId }),
        supabase.rpc('customer_history', { p_store_customer_id: customerId, p_limit: 200 }),
      ]);
      if (a.error) throw a.error;
      if (h.error) throw h.error;
      return { account: a.data as CustomerAccount, history: (h.data ?? []) as HistoryEvent[] };
    },
  });

  return {
    account: r.data?.account ?? null,
    history: r.data?.history ?? [],
    error: r.error,
    loaded: r.loaded,
    /*
     * Not loaded and not failed IS loading — including the first frame before the read has
     * started. A page that checks `loading`, then `error`, then reads `account` must never fall
     * through to an account that is not there.
     */
    loading: !r.loaded && !r.error,
    reload: r.reload,
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
    /*
     * NO TTL — see `useCustomerAccount`. Ten minutes is worse than thirty seconds here, not
     * better: the pools change perhaps twice a year, so the timer's only observable effect is to
     * empty a screen somebody left open.
     */
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
