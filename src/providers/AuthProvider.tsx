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
import { StateStack, useDemandState } from '@academix-admin/state-stack';
import { messageOf, setMoneyDecimals } from '@/lib/format';

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

/**
 * WHICH SHOP TO OPEN, given the shops this person works in.
 *
 * Lifted out of the read that fetches them. It used to live at the end of `loadStores`, so it only
 * ever ran on a SUCCESSFUL read — and a cold start with no signal, where the list comes back from
 * the device rather than the server, chose nothing. Every page begins `if (!store) return null`, so
 * the app opened to its own tab bar over three blank pages.
 *
 *   A CHOICE MADE IN THIS SESSION IS SACRED, even into an unfinished shop — somebody who switched
 *   there to finish setting it up must not be pulled back out.
 *   THEN WHERE THEY WERE LAST, if that shop is still theirs and is not a half-made one standing
 *   beside a working one (which is how a mistyped shop answered every sign-in with a setup wizard).
 *   THEN the first finished shop, and only then the first of any.
 */
function chooseStore(list: StoreSummary[], current: string | null): string | null {
  if (current && list.some((s) => s.id === current)) return current;

  const ready = list.filter((s) => s.onboardedAt);
  const preferred = (id: string | null) => {
    if (!id) return null;
    const found = list.find((s) => s.id === id);
    if (!found) return null;
    if (!found.onboardedAt && ready.length > 0) return null;
    return found.id;
  };

  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(LAST_STORE_KEY);
  } catch {
    /* storage blocked — fall through */
  }
  return preferred(remembered) ?? ready[0]?.id ?? list[0]?.id ?? null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  /*
   * WHICH SHOPS THIS PERSON WORKS IN — kept on the device, per person.
   *
   * A cold start with no signal cannot ask, and the app has to open somewhere. Persisted so the
   * till opens on the shop they were last in; keyed by the person signed in, and dropped on sign-out
   * (below), because a shop phone is shared and the next person must not see the last one's shops.
   */
  const [stores, , setStores] = useDemandState<StoreSummary[]>([], {
    key: 'auth:stores',
    scope: 'auth_flow',
    persist: true,
    deps: [session?.user.id ?? ''],
    revalidateOnMount: false,
  });
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
      .select('role_code, stores!inner(id, name, slug, onboarded_at, status)')
      .eq('user_id', uid)
      /*
       * A CLOSED SHOP STOPS BEING OFFERED, and keeps everything it ever wrote.
       *
       * Filtered here rather than after the fact so the whole app — the switcher, the store count
       * that decides whether somebody needs to create one, the automatic pick below — works from
       * one list. Its rows are all still there and its receipts still read: the ledgers are
       * append-only and a receipt in a customer's hand must not stop resolving because the shop
       * that issued it was tidied away.
       */
      .eq('stores.status', 'active');

    if (err) {
      /*
       * KEPT. Emptying the list here said "this person belongs to no shop", and the layout reads
       * that as somebody who has not made one yet — so a signed-in shop with no signal was sent to
       * the create-a-shop wizard, over its own till. A read that failed is not an answer.
       */
      setError(err.message);
      return;
    }

    type Row = {
      role_code: Role;
      stores: {
        id: string;
        name: string;
        slug: string;
        onboarded_at: string | null;
        status: string;
      };
    };

    const rows = (data ?? []) as unknown as Row[];
    const list: StoreSummary[] = rows.map((r) => ({
      id: r.stores.id,
      name: r.stores.name,
      slug: r.stores.slug,
      role: r.role_code,
      onboardedAt: r.stores.onboarded_at,
    }));

    /*
     * SORTED, because `list[0]` was about to decide which shop somebody works in.
     *
     * The rows come back from a join with no `order by`, so "the first store" is whichever one the
     * database felt like returning — stable enough in testing to look deliberate, and free to
     * change on any query plan. Which shop a session opens in is not something to leave to that.
     */
    list.sort((a, b) => a.name.localeCompare(b.name));

    setStores(list);
    setError(null);

    /*
     * Reopen wherever they were last, if that store is still theirs — losing your place on every
     * reload is a small thing that makes an app feel unreliable.
     *
     * BUT NOT INTO A SHOP THAT WAS NEVER FINISHED, while a working one exists.
     *
     * A store with no `onboarded_at` is one the layout immediately routes to `/setup/opening`. This
     * account has a real shop trading since August and a "Yh" created by accident this morning, and
     * because creating a shop WRITES the remembered id on the way past, every sign-in afterwards
     * reopened the accident and answered with a setup wizard. The only way out on that screen was
     * "Skip for now", which marks the wrong shop finished in order to escape it.
     *
     * A half-made shop is not lost by this — it is still in the switcher, and choosing it there
     * lands on its setup, which is the one context where that screen is what somebody asked for.
     */
    setStoreId((current) => chooseStore(list, current));
    // `setStores` comes from state-stack and is stable; it is listed because the rule is right.
  }, [setStores]);

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
  }, [loadStores, setStores]);

  /*
   * A list without a choice is the offline cold start: the read failed, but the shops came back from
   * the device. Nothing here overrides a choice already made — `chooseStore` keeps it.
   */
  useEffect(() => {
    if (stores.length === 0) return;
    setStoreId((current) => chooseStore(stores, current));
  }, [stores]);

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

  /*
   * HOW THIS SHOP SHOWS MONEY, applied as soon as the shop is known.
   *
   * `stores.money_decimals` reached nothing before this: every screen formatted to whole naira
   * because that is the hard-coded default, and a shop that set anything else was ignored. Read
   * here rather than per screen so one answer serves all 143 formatting calls, and re-read whenever
   * the store changes — switching shops must not carry the previous one's setting across, the same
   * reason `selectStore` clears the scopes.
   */
  useEffect(() => {
    if (!storeId) {
      setMoneyDecimals(0);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await getSupabase()
        .from('stores')
        .select('money_decimals')
        .eq('id', storeId)
        .maybeSingle();
      if (!cancelled) setMoneyDecimals((data as { money_decimals: number } | null)?.money_decimals);
    })();
    return () => {
      cancelled = true;
    };
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
