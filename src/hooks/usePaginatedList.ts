'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useInfiniteScrollObserver } from '@academix-admin/navigation-stack';
import { useDemandState } from '@academix-admin/state-stack';
import { useInvalidation } from '@/lib/stacks/invalidation';

/**
 * Infinite list with cursor pagination.
 *
 * Same approach academix-web uses — a cursor from the last row, never an OFFSET, because a shop
 * inserts rows continuously and an offset would show one row twice while skipping another.
 *
 * Four things are handled here that academix-web repeats at each call site, and therefore has to
 * get right repeatedly:
 *
 *  1. **Dedup by a Set, not a rescan.** Its version rebuilds an array of existing ids for every
 *     page and scans it per row — O(n·m) that gets slower the further you scroll, exactly when
 *     the list is longest.
 *  2. **`hasMore` is explicit**, derived from whether a full page came back, rather than each
 *     screen inferring it.
 *  3. **Stale responses are dropped.** A request generation counter means a slow page-1 landing
 *     after page-2 cannot overwrite newer rows — the bug that makes a list flicker backwards.
 *  4. **Reset on query change** is built in, so searching cannot mix results from two terms.
 *
 * THE ROWS AND THE CURSOR LIVE IN state-stack, not in `useState`.
 *
 * That is the difference between a list that survives leaving the page and one that does not. A
 * stack page unmounts when another is pushed on top, so a list held in component state came back
 * EMPTY: open a customer's statement, tap a receipt, come back, and the page flashed zero rows and
 * an empty balance before refetching — and the pagination started from the top, losing however far
 * someone had scrolled. state-stack persists both, so the page returns already drawn and corrects
 * itself from the server behind that.
 *
 * `revalidateOnMount: false` on the ROWS is the point: a remount reuses what was there. Fresh data
 * still arrives — `deps` changes reset it, and `reload()` is explicit — but coming back from a
 * pushed page is not a reason to throw away what someone was looking at.
 */

/**
 * The most rows one refresh will ask for.
 *
 * "However many are loaded" has no ceiling, and a list somebody scrolled a long way through is
 * not worth a thousand-row query every time they come back to it. Past this the tail is dropped
 * and re-paginated, which is the honest trade: the alternative is a slow screen.
 */
const REFRESH_LIMIT = 200;

export interface PageResult<T> {
  rows: T[];
  /** Cursor for the next page, taken from the last row. */
  cursor: unknown;
}

export interface PaginatedList<T> {
  items: T[];
  /**
   * Replace the rows for a TARGETED change, leaving the paging state alone.
   *
   * One sale voided, one customer renamed. Re-reading the list instead would cost a round trip for
   * something the caller already knows and throw away every page the reader had scrolled through.
   */
  setItems: (next: T[]) => void;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  /** Start again from page one. Use when the QUESTION changed — a new search, a new store. */
  reload: () => void;
  /**
   * Re-read what is already on screen, without shortening the list.
   *
   * This is what a screen should do when it is returned to. `reload` throws away everything past
   * page one, which on a list somebody has scrolled through is destructive: see the note on
   * `refresh` in the implementation.
   */
  refresh: () => void;
}

export function usePaginatedList<T>({
  fetchPage,
  getId,
  key,
  scope = 'list_flow',
  pageSize = 30,
  deps = [],
  enabled = true,
  persist = true,
}: {
  /** Fetch one page. `cursor` is null for the first. */
  fetchPage: (cursor: unknown | null, limit: number) => Promise<PageResult<T>>;
  getId: (row: T) => string;
  /** Identifies this list within its scope — two lists in one scope must not share a key. */
  key: string;
  /** state-stack scope, so a store switch can clear every list at once. */
  scope?: string;
  pageSize?: number;
  /** Reset and refetch when any of these change — a search term, a store id. */
  deps?: unknown[];
  enabled?: boolean;
  /**
   * Keep the rows across a remount. TRUE for lists, FALSE for searches.
   *
   * A browse list is worth restoring: it answers the same question every time, so what was on
   * screen a moment ago is still the right answer. A search is not — its answer depends on a term
   * that is NOT part of the cache key, so restoring it means showing one query's results under
   * another query's heading.
   */
  persist?: boolean;
}): PaginatedList<T> {
  /*
   * Persisted per list. `scope` groups them so a store switch can drop every list at once, and
   * `key` keeps two lists in the same scope — customers and sales — from overwriting each other.
   */
  const [snapshot, , setSnapshot] = useDemandState<{
    items: T[];
    cursor: unknown | null;
    hasMore: boolean;
  }>(
    { items: [], cursor: null, hasMore: true },
    {
      key: `list:${key}`,
      scope,
      persist,
      deps,
      // A remount reuses what was on screen. Without this, returning from a pushed page threw the
      // list away and refetched from the first page, losing the scroll position with it.
      revalidateOnMount: false,
    },
  );

  const items = snapshot.items;
  const hasMore = snapshot.hasMore;

  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cursorRef = useRef<unknown | null>(snapshot.cursor);
  // Rebuilt from whatever was restored, so a resumed list still refuses duplicates.
  const seenRef = useRef<Set<string>>(new Set());
  // Bumped on every reset. A response carrying an old generation is discarded rather than
  // merged, so a slow first page cannot land after a newer one and rewind the list.
  const genRef = useRef(0);
  const inFlight = useRef(false);

  /*
   * Seed the dedup set from whatever was restored.
   *
   * A resumed list already holds rows; without this the next page would re-add any that came back
   * again, and the same receipt would appear twice. Runs once per restored snapshot identity, not
   * per render.
   */
  const seededFor = useRef<T[] | null>(null);
  if (seededFor.current !== snapshot.items) {
    seededFor.current = snapshot.items;
    if (snapshot.items.length > 0 && seenRef.current.size === 0) {
      cursorRef.current = snapshot.cursor;
      for (const row of snapshot.items) seenRef.current.add(getId(row));
    }
  }

  // The current rows, readable from `refresh` without making it depend on them — it writes them.
  const itemsRef = useRef<T[]>(items);
  itemsRef.current = items;

  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const idRef = useRef(getId);
  idRef.current = getId;

  const load = useCallback(
    async (reset: boolean) => {
      if (!enabled) return;
      if (inFlight.current && !reset) return;

      const gen = reset ? ++genRef.current : genRef.current;
      inFlight.current = true;

      if (reset) {
        cursorRef.current = null;
        seenRef.current = new Set();
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);

      try {
        const { rows, cursor } = await fetchRef.current(reset ? null : cursorRef.current, pageSize);
        if (gen !== genRef.current) return;      // superseded — drop it

        const fresh: T[] = [];
        for (const row of rows) {
          const id = idRef.current(row);
          if (seenRef.current.has(id)) continue;
          seenRef.current.add(id);
          fresh.push(row);
        }

        cursorRef.current = cursor;
        // A short page means the end. Asking for another would return nothing and read to the
        // user as a list that keeps trying to load.
        //
        // Rows, cursor and hasMore are written TOGETHER, in one value. Held apart they can be
        // restored out of step — a list with page three's rows and page one's cursor re-fetches
        // rows it already has, which is how a resumed list ends up with duplicates.
        setSnapshot((prev) => ({
          items: reset ? fresh : [...prev.items, ...fresh],
          cursor,
          hasMore: rows.length >= pageSize,
        }));
      } catch (e: unknown) {
        if (gen !== genRef.current) return;
        /*
         * AN ERROR IS NOT THE END OF THE LIST.
         *
         * This used to set `hasMore: false`, and the snapshot is persisted — so one dropped
         * request convinced a list it had been read to the end, permanently. The sentinel is only
         * rendered while `hasMore`, so it disappeared and never came back: the list looked
         * complete at thirty rows and no amount of scrolling would ask for more, in a session or
         * in any session afterwards.
         *
         * `hasMore` describes the DATA — whether the last page came back full — and a request that
         * never arrived says nothing about that. The failure is reported through `error`, which is
         * what a retry reads.
         */
        setError(e instanceof Error ? e.message : 'Could not load this list');
      } finally {
        /*
         * ALWAYS clear the flags, superseded or not.
         *
         * Guarded by `gen === genRef.current`, a superseded request left `loading` true forever —
         * and `useInfiniteScroll` is enabled on `hasMore && !loading`, so the observer was never
         * attached and the list silently stopped paginating. The sentinel sat on screen doing
         * nothing, which looks exactly like a list that has reached its end.
         *
         * Superseding happens on any generation bump, and `refresh()` bumps on every resume — so
         * one visit to a list was enough to kill scrolling on it for the rest of the session.
         *
         * Clearing unconditionally is safe: a newer request sets these true synchronously before it
         * awaits anything, so an older one finishing cannot leave a live request looking idle.
         */
        setLoading(false);
        setLoadingMore(false);
        inFlight.current = false;
      }
    },
    [enabled, pageSize, setSnapshot],
  );

  /*
   * Load on mount when there is nothing to show — and ALWAYS when the question changed.
   *
   * Those are two different events and this used to treat them as one. The rule was "skip the
   * fetch if rows were restored", which is right for a remount (a restored list is already the
   * right answer, and refetching it threw away the scroll position and flashed an empty screen on
   * the way back from a pushed page) and badly wrong for a `deps` change:
   *
   *   THE PRODUCT PICKER STOPPED SEARCHING. Type "co" and it showed whatever the previous search
   *   had returned — Eva Water, Goldberg, Trophy — because rows existed, so the new term never
   *   fetched. Caught on screen; it had been shipping since the state-stack migration.
   *
   *   A STORE SWITCH WOULD HAVE KEPT THE OLD SHOP'S ROWS, for the same reason and with much worse
   *   consequences: one shop's customers and balances listed under another shop's name.
   *
   * So the deps are compared explicitly. Same question and rows already here → leave them alone.
   * Different question → reset, whatever is on screen.
   */
  const restored = snapshot.items.length > 0;
  const lastDeps = useRef<unknown[] | null>(null);

  useEffect(() => {
    const previous = lastDeps.current;
    const questionChanged =
      previous !== null &&
      (previous.length !== deps.length || previous.some((d, i) => !Object.is(d, deps[i])));
    lastDeps.current = deps;

    if (!questionChanged && restored) return;
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, restored, ...deps]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    void load(false);
  }, [loading, loadingMore, hasMore, load]);

  const reload = useCallback(() => void load(true), [load]);

  /*
   * Re-read the span already on screen, in one request, keeping its length.
   *
   * `reload` resets to page one, and every list screen was calling it from `onResume`. On a list
   * somebody had paged through — a hundred customers, say — tapping the hundredth, coming back,
   * and finding twenty is not a refresh, it is the screen throwing away their place. The row they
   * were looking at is gone and so is the scroll position that led to it.
   *
   * So the refresh asks for as many rows as are already loaded rather than one page of them. One
   * request, because the fetcher takes a limit and the server is better at "give me 100" than this
   * is at asking five times.
   *
   * NO LOADING FLAG. What is on screen is still correct; it is being corrected, not replaced, and
   * a spinner over correct data is the flash this whole migration was about.
   *
   * Capped, because "as many as are loaded" is unbounded and a list nobody has scrolled is not
   * worth a 5,000-row query on the way back to it.
   */
  const refresh = useCallback(() => {
    const loaded = itemsRef.current.length;
    if (loaded === 0) {
      void load(true);
      return;
    }
    if (!enabled || inFlight.current) return;

    const span = Math.min(Math.max(loaded, pageSize), REFRESH_LIMIT);
    const gen = ++genRef.current;
    inFlight.current = true;
    setError(null);

    void (async () => {
      try {
        const { rows, cursor } = await fetchRef.current(null, span);
        if (gen !== genRef.current) return;

        const seen = new Set<string>();
        const fresh: T[] = [];
        for (const row of rows) {
          const id = idRef.current(row);
          if (seen.has(id)) continue;
          seen.add(id);
          fresh.push(row);
        }

        seenRef.current = seen;
        cursorRef.current = cursor;
        setSnapshot({ items: fresh, cursor, hasMore: rows.length >= span });
      } catch (e: unknown) {
        if (gen !== genRef.current) return;
        // Keep the rows. A failed refresh is a network problem, not a reason to empty a list
        // somebody is looking at.
        setError(e instanceof Error ? e.message : 'Could not refresh this list');
      } finally {
        /*
         * ALWAYS release the flag, superseded or not.
         *
         * Guarding this with `gen === genRef.current` leaks it: a refresh that is superseded never
         * clears `inFlight`, and `load(false)` bails on that flag — so pagination dies silently and
         * permanently. It looked exactly like a list that had reached its end, sentinel on screen
         * and all. `load` has always released it unconditionally; this now matches.
         */
        inFlight.current = false;
      }
    })();
  }, [enabled, pageSize, setSnapshot, load]);

  /*
   * Replace the rows without touching the cursor or `hasMore`.
   *
   * For a targeted change — one sale voided, one customer renamed — where re-reading the list
   * would throw away every page already scrolled through and cost a round trip for something the
   * caller already knows. The paging state is deliberately left alone: patching a row says
   * nothing about whether there are more pages, and pretending otherwise is how a list ends up
   * refusing to paginate.
   */
  const setItems = useCallback(
    (next: T[]) => setSnapshot((prev) => ({ ...prev, items: next })),
    [setSnapshot],
  );

  /*
   * Somebody wrote to this scope, so re-read what is on screen.
   *
   * `refresh`, never `reload`: reload resets to page one, which on a list somebody has paged
   * through means tapping the hundredth row, coming back, and finding twenty. Refresh re-asks for
   * the span already loaded, with no loading flag, so the rows stay drawn while they are corrected.
   *
   * This replaces `clearScope`, which deleted the rows outright and blanked the screen.
   */
  useInvalidation(scope, refresh);

  return { items, setItems, loading, loadingMore, error, hasMore, loadMore, reload, refresh };
}

/**
 * Fires when a sentinel element scrolls into view.
 *
 * IntersectionObserver rather than a scroll handler: no work on every scroll frame, which matters
 * on the low-end Android hardware this runs on. `rootMargin` starts the next page slightly before
 * the sentinel is visible, so the list stays ahead of the reader instead of stalling at the
 * bottom.
 */
/**
 * A sentinel that asks for the next page when it comes into view.
 *
 * DELEGATES TO NAVIGATION-STACK, which is the whole point of it. The hand-rolled version built an
 * IntersectionObserver with no root, so it watched the VIEWPORT — and a page's rows do not live in
 * the viewport, they live inside the ColumnBody the stack owns and scrolls. It worked well enough
 * to look right and then quietly stopped asking for pages.
 *
 * The package's observer is told the container (`() => …` because it mounts after this hook runs)
 * and does its own guarding on `hasMore` and `loading`, which is also where the "loadMore fires
 * forty times while one request is in flight" problem is already solved. academix-web has used it
 * for its transaction list all along; this is the same hook.
 */
export function useInfiniteScroll(
  onReachEnd: () => void,
  {
    enabled = true,
    rootMargin = '400px',
    hasMore = true,
    loading = false,
  }: { enabled?: boolean; rootMargin?: string; hasMore?: boolean; loading?: boolean } = {},
) {
  // Held so the root can be found from the sentinel itself — a page that wraps its list in
  // anything still works, because the container is looked up rather than passed down.
  const node = useRef<HTMLDivElement | null>(null);

  const observe = useInfiniteScrollObserver({
    onLoadMore: onReachEnd,
    // `enabled` is how every caller here already expresses "there is more and we are not busy".
    hasMore: enabled && hasMore,
    loading,
    rootMargin,
    root: () => (node.current?.closest('.navstack-column-body') as HTMLElement | null) ?? null,
  });

  /*
   * One callback ref feeding two: ours for the lookup above, the package's for the observing.
   *
   * The package hands back a callback ref, and callers here attach a single `ref` to their
   * sentinel — so the two are joined here rather than every list having to know about both.
   */
  return useCallback(
    (el: HTMLDivElement | null) => {
      node.current = el;
      observe(el);
    },
    [observe],
  );
}
