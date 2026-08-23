'use client';

import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase/client';

export interface BankAccount {
  id: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  is_default: boolean;
}

/**
 * The shop's accounts, for the counter to read out.
 *
 * Read by any member, not just whoever can edit them — a seller has to be able to tell a customer
 * where to pay. Writing is gated on `store.settings`, because changing the number a shop collects
 * money into is the highest-value edit in the product.
 */
export function useBankAccounts(storeId: string | null) {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);

  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    void (async () => {
      const { data } = await getSupabase().rpc('list_bank_accounts', { p_store_id: storeId });
      if (!cancelled) setAccounts((data ?? []) as BankAccount[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  return accounts;
}
