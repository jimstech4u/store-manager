'use client';

import { useCallback, useEffect, useState } from 'react';
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

export function useCustomerAccount(customerId: string | null) {
  const [account, setAccount] = useState<CustomerAccount | null>(null);
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!customerId) return;
    setLoading(true);
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
      setAccount(a.data as CustomerAccount);
      setHistory((h.data ?? []) as HistoryEvent[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this account.');
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { account, history, loading, error, reload };
}

export interface EmptiesPool {
  id: string;
  name: string;
  kind: 'content' | 'container';
  deposit: string;
}

/** The pools this shop uses, for the pickers on every empties action. */
export function useEmptiesPools(storeId: string | null) {
  const [pools, setPools] = useState<EmptiesPool[]>([]);

  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    void (async () => {
      const { data } = await getSupabase()
        .from('empties_categories')
        .select('id, name, kind, deposit')
        .eq('store_id', storeId)
        .order('name');
      if (!cancelled) setPools((data ?? []) as EmptiesPool[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  return pools;
}
