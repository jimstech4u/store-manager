'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
  pageSize = 30,
  deps = [],
  enabled = true,
}: {
  /** Fetch one page. `cursor` is null for the first. */
  fetchPage: (cursor: unknown | null, limit: number) => Promise<PageResult<T>>;
  getId: (row: T) => string;
  pageSize?: number;
  /** Reset and refetch when any of these change — a search term, a store id. */
  deps?: unknown[];
  enabled?: boolean;
}): PaginatedList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const cursorRef = useRef<unknown | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  // Bumped on every reset. A response carrying an old generation is discarded rather than
  // merged, so a slow first page cannot land after a newer one and rewind the list.
  const genRef = useRef(0);
  const inFlight = useRef(false);

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
        setHasMore(true);
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
        setHasMore(rows.length >= pageSize);
        setItems((prev) => (reset ? fresh : [...prev, ...fresh]));
      } catch (e: unknown) {
        if (gen !== genRef.current) return;
        setError(e instanceof Error ? e.message : 'Could not load this list');
        setHasMore(false);
      } finally {
        if (gen === genRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
        inFlight.current = false;
      }
    },
    [enabled, pageSize],
  );

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

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
