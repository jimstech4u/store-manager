'use client';

import { useCallback, useEffect } from 'react';
import { StateStack, useDemandState } from '@academix-admin/state-stack';
import { getSupabase } from '@/lib/supabase/client';

export interface BankAccount {
  id: string;
  bank_name: string;
  account_name: string;
  account_number: string;
  is_default: boolean;
}

/** Everything the settings tab caches, dropped together when the tab is left. */
export const SETTINGS_SCOPE = 'settings_flow';

/**
 * Say something in the shop's configuration moved.
 *
 * Called by the pages that edit it: bank accounts, the team, the shop's own settings. It clears
 * the whole scope rather than one key, which is right for configuration — read far more often than
 * written, read together, and the alternative is every page guessing which of the others its write
 * invalidated.
 *
 * The account numbers are why this exists at all. Without it the counter would go on reading out
 * an account that was corrected minutes ago — the one staleness here that costs somebody real
 * money, because a customer pays into it.
 */
export function settingsChanged() {
  void StateStack.core.clearScope(SETTINGS_SCOPE);
}

interface AccountsState {
  accounts: BankAccount[];
  error: string | null;
  settled: boolean;
}

/**
 * The shop's accounts: ONE hook, one key, one shape.
 *
 * That is not a stylistic preference, it is a bug fix. There were briefly two readers of
 * `bank-accounts:<store>` — this one storing a bare array for the payment screens, and the
 * settings page storing `{ accounts, error, settled }` — and a cache key does not care which of
 * its writers ran last. Whichever wrote second handed the other a value of the wrong shape, and
 * the settings page went white with "Cannot read properties of undefined". Two shapes under one
 * key is a data race with extra steps.
 *
 * Read by any member, not just whoever can edit them — a seller has to be able to tell a customer
 * where to pay. Writing is gated on `store.settings`, because changing the number a shop collects
 * money into is the highest-value edit in the product.
 */
export function useBankAccountsState(storeId: string | null) {
  const [state, demand] = useDemandState<AccountsState>(
    { accounts: [], error: null, settled: false },
    {
      key: `bank-accounts:${storeId ?? 'none'}`,
      scope: SETTINGS_SCOPE,
      persist: true,
      deps: [storeId ?? ''],
      /*
       * No revalidate on mount.
       *
       * Unlike a balance, these are configuration: they change perhaps twice a year, and a refetch
       * every time a payment screen opens is a request nobody is waiting on. `settingsChanged()`
       * covers the rare edit, which is the only thing that can make this list wrong.
       */
      revalidateOnMount: false,
      /*
       * A value saved by an older build of this app may be a bare array rather than this shape.
       * Nothing downstream should have to defend against that, so it is normalised once, here, on
       * the way out of storage.
       */
      revive: (rawValue: unknown): AccountsState => {
        if (Array.isArray(rawValue)) {
          return { accounts: rawValue as BankAccount[], error: null, settled: true };
        }
        const v = rawValue as Partial<AccountsState> | null;
        return {
          accounts: Array.isArray(v?.accounts) ? v.accounts : [],
          error: v?.error ?? null,
          settled: v?.settled ?? false,
        };
      },
    },
  );

  const reload = useCallback(async () => {
    if (!storeId) return;
    await demand(async ({ set }) => {
      const { data, error } = await getSupabase().rpc('list_bank_accounts', {
        p_store_id: storeId,
      });
      set(
        {
          // A failed refresh keeps the accounts. An empty list here means "this shop takes no
          // transfers", which is a different and much worse thing to say at a counter.
          accounts: error ? state.accounts : ((data ?? []) as BankAccount[]),
          error: error ? error.message : null,
          settled: true,
        },
        { override: true },
      );
    });
    // `state.accounts` is read for the failure path only; depending on it would make this refetch
    // itself every time it succeeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, demand]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}

/** Just the accounts, for the screens that only read them out. */
export function useBankAccounts(storeId: string | null): BankAccount[] {
  return useBankAccountsState(storeId).accounts;
}
