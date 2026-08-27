'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDemandState } from '@academix-admin/state-stack';

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

export interface PageResult<T> {
  rows: T[];
  /** Cursor for the next page, taken from the last row. */
  cursor: unknown;
}

export interface PaginatedList<T> {
  items: T[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
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
        setError(e instanceof Error ? e.message : 'Could not load this list');
        setSnapshot((prev) => ({ ...prev, hasMore: false }));
      } finally {
        if (gen === genRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
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

  return { items, loading, loadingMore, error, hasMore, loadMore, reload };
}

/**
 * Fires when a sentinel element scrolls into view.
 *
 * IntersectionObserver rather than a scroll handler: no work on every scroll frame, which matters
 * on the low-end Android hardware this runs on. `rootMargin` starts the next page slightly before
 * the sentinel is visible, so the list stays ahead of the reader instead of stalling at the
 * bottom.
 */
export function useInfiniteScroll(
  onReachEnd: () => void,
  { enabled = true, rootMargin = '400px' }: { enabled?: boolean; rootMargin?: string } = {},
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cbRef = useRef(onReachEnd);
  cbRef.current = onReachEnd;

  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) cbRef.current();
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, rootMargin]);

  return ref;
}
