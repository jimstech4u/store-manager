'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase/client';
import { StateStack } from '@academix-admin/state-stack';
import { messageOf } from '@/lib/format';

/**
 * Auth and the current store, in one provider.
 *
 * They are together because they are one question in practice: this app is useless without both
 * "who are you" and "which store are you working in", and every screen needs the pair. Splitting
 * them into two providers would mean every consumer coordinating two loading states and handling
 * the impossible combination (a store with no user) that the database would reject anyway.
 */

export type Role = 'owner' | 'manager' | 'staff';

export interface StoreSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
  /** Null until the owner has finished entering opening balances. */
  onboardedAt: string | null;
}

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  /** Every store this user belongs to. */
  stores: StoreSummary[];
  /** The store being worked in. Null when the user has none yet. */
  store: StoreSummary | null;
  selectStore: (storeId: string) => void;
  /** False once the first auth + store load has settled, either way. */
  loading: boolean;
  error: string | null;
  refreshStores: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * Convenience for the many screens that cannot function without a store.
 *
 * Throws rather than returning null so a missing store surfaces at the boundary that forgot to
 * guard, instead of as `undefined.id` somewhere three components deeper.
 */
export function useStore(): StoreSummary {
  const { store } = useAuth();
  if (!store) throw new Error('useStore requires a selected store — render inside the app shell');
  return store;
}

const LAST_STORE_KEY = 'sm.lastStore';

/**
 * Scopes holding data that belongs to ONE store, cleared whenever the store changes or the user
 * signs out.
 *
 * academix-web learned this the expensive way: flow-scoped state was cleared in click handlers,
 * so any other exit path left it behind, and because state-stack persists to IndexedDB the stale
 * values reappeared on the NEXT load — far from the action that should have cleared them. Here
 * the list is declared once, next to the thing that owns the lifecycle, so a new scope has an
 * obvious place to be registered rather than being cleaned up somewhere ad hoc.
 */
const STORE_SCOPED = [
  'sell_flow',
  'stock_flow',
  'customer_flow',
  'money_flow',
  'catalog_flow',
  /*
   * Everything below belongs to ONE shop and was missing from this list.
   *
   * `settings_flow` is the one that mattered: it caches the bank accounts a seller reads out to a
   * customer, and the staff list. Switching shop left the previous shop's account NUMBERS on
   * screen under the new shop's name — the one piece of stale data here that ends with money in
   * the wrong account.
   *
   * `list_flow` is `usePaginatedList`'s default scope, so every list that did not name its own
   * lands here. `search_flow` and `receipt_flow` are cheaper to get wrong but no more correct.
   *
   * `storefront_flow` is deliberately NOT in this list: it is the public marketplace, which does
   * not belong to whichever shop the member happens to be signed into.
   */
  'settings_flow',
  'search_flow',
  'receipt_flow',
  'list_flow',
];

async function clearStoreScopes() {
  await Promise.all(STORE_SCOPED.map((scope) => StateStack.core.clearScope(scope)));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [stores, setStores] = useState<StoreSummary[]>([]);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guards the store-scope clear on the very first store selection: there is nothing stale to
  // clear when the app has only just started, and clearing then would wipe a scope a screen has
  // already begun filling.
  const hadStore = useRef(false);

  const loadStores = useCallback(async (uid: string | null) => {
    if (!uid) {
      setStores([]);
      setStoreId(null);
      return;
    }

    const supabase = getSupabase();
    const { data, error: err } = await supabase
      .from('store_members')
      .select('role_code, stores!inner(id, name, slug, onboarded_at)')
      .eq('user_id', uid);

    if (err) {
      setError(err.message);
      setStores([]);
      return;
    }

    type Row = {
      role_code: Role;
      stores: { id: string; name: string; slug: string; onboarded_at: string | null };
    };

    const rows = (data ?? []) as unknown as Row[];
    const list: StoreSummary[] = rows.map((r) => ({
      id: r.stores.id,
      name: r.stores.name,
      slug: r.stores.slug,
      role: r.role_code,
      onboardedAt: r.stores.onboarded_at,
    }));

    setStores(list);
    setError(null);

    // Reopen wherever they were last, if that store is still theirs — losing your place on every
    // reload is a small thing that makes an app feel unreliable.
    setStoreId((current) => {
      if (current && list.some((s) => s.id === current)) return current;
      let remembered: string | null = null;
      try {
        remembered = localStorage.getItem(LAST_STORE_KEY);
      } catch {
        /* storage blocked — fall through to the first store */
      }
      if (remembered && list.some((s) => s.id === remembered)) return remembered;
      return list[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    const supabase = getSupabase();
    let cancelled = false;

    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        if (cancelled) return;
        setSession(data.session);
        await loadStores(data.session?.user.id ?? null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(messageOf(e, 'Could not sign in'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, nextSession) => {
      if (cancelled) return;
      setSession(nextSession);

      if (event === 'SIGNED_OUT') {
        setStores([]);
        setStoreId(null);
        hadStore.current = false;
        // Sign-out must leave nothing of the previous user behind: on a shared device — which is
        // normal in a shop — the next person signing in would otherwise see the last one's
        // half-finished sale rehydrate from IndexedDB.
        await clearStoreScopes();
        return;
      }

      // TOKEN_REFRESHED fires on a timer and changes nothing about which stores exist; reloading
      // them would put a needless request on the network every hour.
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        await loadStores(nextSession?.user.id ?? null);
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [loadStores]);

  const selectStore = useCallback((id: string) => {
    setStoreId((previous) => {
      if (previous === id) return previous;
      try {
        localStorage.setItem(LAST_STORE_KEY, id);
      } catch {
        /* not fatal — the choice just will not survive a reload */
      }
      // Switching stores must not carry the previous store's data across. Doing it here rather
      // than in whatever button triggered the switch means every path that changes store is
      // covered, including a future one nobody has written yet.
      if (previous !== null) void clearStoreScopes();
      return id;
    });
  }, []);

  useEffect(() => {
    if (storeId) hadStore.current = true;
  }, [storeId]);

  const signOut = useCallback(async () => {
    await getSupabase().auth.signOut();
  }, []);

  const refreshStores = useCallback(async () => {
    await loadStores(session?.user.id ?? null);
  }, [loadStores, session?.user.id]);

  const store = useMemo(
    () => stores.find((s) => s.id === storeId) ?? null,
    [stores, storeId],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      session,
      stores,
      store,
      selectStore,
      loading,
      error,
      refreshStores,
      signOut,
    }),
    [session, stores, store, selectStore, loading, error, refreshStores, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
