'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAuth } from '@/providers/AuthProvider';
import { useResource } from '@/lib/stacks/resource';
import { SETTINGS_SCOPE } from '@/lib/stacks/bank-accounts';
import { getSupabase } from '@/lib/supabase/client';

/**
 * WHAT THIS PERSON MAY DO, AS THE SERVER DECIDES IT.
 *
 * The screens asked the ROLE (`roleCan`), but a role is only the starting point: the owner ticks and
 * unticks boxes per person when adding them (`set_member_permissions`), and the database enforces
 * those. So a manager whose "Reports" box was unticked still saw the button and was refused, and a
 * staff member given counting could not find the Count button at all.
 *
 * Read once per shop from `member_permissions` — the same rule `has_permission` enforces — kept
 * across reloads, and re-read when settings change. Until the first answer the role stands in, so
 * a screen does not flicker between hidden and shown; the server's answer then replaces it.
 */
const PermissionsContext = createContext<ReadonlySet<string> | null>(null);

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { store, user } = useAuth();
  const storeId = store?.id ?? null;
  const userId = user?.id ?? null;

  const res = useResource<string[]>({
    key: `my-permissions:${storeId ?? 'none'}:${userId ?? 'none'}`,
    scope: SETTINGS_SCOPE,
    enabled: Boolean(storeId && userId),
    read: async () => {
      const { data, error } = await getSupabase().rpc('member_permissions', {
        p_store_id: storeId,
        p_user_id: userId,
      });
      if (error) throw error;
      return ((data ?? []) as { code: string; allowed: boolean }[])
        .filter((r) => r.allowed)
        .map((r) => r.code);
    },
  });

  const allowed = useMemo(() => (res.data ? new Set(res.data) : null), [res.data]);
  return <PermissionsContext.Provider value={allowed}>{children}</PermissionsContext.Provider>;
}

/** The server's answer, or null before it has arrived (the role stands in until then). */
export function useGrantedPermissions(): ReadonlySet<string> | null {
  return useContext(PermissionsContext);
}
