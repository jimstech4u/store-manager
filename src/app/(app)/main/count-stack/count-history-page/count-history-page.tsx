'use client';

import { useCallback, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { PinnedTools } from '@/components/ui/PinnedTools';
import { SearchLauncher } from '@/components/ui/SearchLauncher';
import { SearchSheet } from '@/components/ui/SearchSheet';
import { useSearchController } from '@academix-admin/search-viewer';
import { ListFilters } from '@/components/ui/ListFilters';
import { InfoPanel } from '@/components/ui/Explain';
import { ChevronRightIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { usePaginatedList, useInfiniteScroll } from '@/hooks/usePaginatedList';
import { useSayInShapes } from '@/lib/stacks/selling-units';
import { csvName, fetchAllPages, shareCsv, toCsv } from '@/lib/export-csv';
import { listDocument, usePrintShare } from '@/components/ui/PrintShare';
import { getSupabase } from '@/lib/supabase/client';
import { formatDateTime } from '@/lib/format';
import styles from './count-history-page.module.css';

/**
 * EVERY COUNT THE SHOP HAS MADE, in one history.
 *
 * "Also count history in full, with all products, with filter — and stock history also carries that,
 * so we can see how we counted." Each item's stock history shows its own counts (0232); this is the
 * whole shop's (0239): the item, who counted and when, what was on the shelf against what the
 * records expected, and whether it matched — said in the shapes the shop counts in. A row opens the
 * item's stock history, where the same count sits among everything else that moved it.
 *
 * An item's OPENING count is not listed: it is the opening, not a count anybody made afterwards.
 */

type CountFilter = 'all' | 'today' | 'week' | 'matched' | 'off';

interface CountRow {
  id: string;
  product_id: string;
  product_name: string;
  base_unit: string;
  counted_at: string;
  counted_by_name: string;
  counted: number | string;
  expected: number | string | null;
  variance: number | string | null;
  status: string;
}

/** A member with no name is known by their email; the part before the @ is enough. */
const person = (name: string | null | undefined) => (name ?? 'Someone').split('@')[0];

export default function CountHistoryPage() {
  const goBack = useStackBack();
  const nav = useNav();
  const { store } = useAuth();
  const say = useSayInShapes(store?.id ?? null);
  const printList = usePrintShare();
  const [searchId, searchOps, isSearchOpen] = useSearchController();
  const [filter, setFilter] = useState<CountFilter>('all');

  const fetchPage = useCallback(
    async (cursor: unknown | null, limit: number) => {
      if (!store) return { rows: [] as CountRow[], cursor: null };
      const c = cursor as { at: string; id: string } | null;
      const { data, error } = await getSupabase().rpc('count_history_page', {
        p_store_id: store.id,
        p_filter: filter,
        p_query: null,
        p_before_at: c?.at ?? null,
        p_before_id: c?.id ?? null,
        p_limit: limit,
      });
      if (error) throw error;
      const rows = (data ?? []) as CountRow[];
      const last = rows[rows.length - 1];
      return { rows, cursor: last ? { at: last.counted_at, id: last.id } : null };
    },
    [store, filter],
  );

  const list = usePaginatedList<CountRow>({
    fetchPage,
    getId: (r) => r.id,
    key: `count-history:${filter}`,
    scope: 'count_flow',
    deps: [store?.id ?? '', filter],
    enabled: Boolean(store),
  });
  const sentinelRef = useInfiniteScroll(list.loadMore, { enabled: list.hasMore && !list.loading });

  if (!store) return null;

  const status: PageStatus =
    list.error && list.items.length === 0
      ? { state: 'error', what: 'the counts', error: list.error, onRetry: () => void list.reload() }
      : list.loading && list.items.length === 0
        ? { state: 'loading', what: 'the counts' }
        : { state: 'ready' };

  /** What a count found, in the item's own shapes. */
  const found = (r: CountRow) => {
    const gap = Number(r.variance ?? 0);
    if (gap === 0) return { text: 'Matched', tone: styles.same };
    return {
      text: `${say(r.product_id, Math.abs(gap), r.base_unit)} ${gap < 0 ? 'short' : 'over'}`,
      tone: gap < 0 ? styles.short : styles.over,
    };
  };

  const rowBody = (r: CountRow) => {
    const f = found(r);
    return (
      <>
        <span className={styles.rowMain}>
          <span className={styles.rowHead}>
            <span className={styles.rowName}>{r.product_name}</span>
            <span className={`${styles.found} ${f.tone}`}>{f.text}</span>
          </span>
          <span className={styles.rowMeta}>
            {formatDateTime(r.counted_at)} · {person(r.counted_by_name)}
          </span>
          <span className={styles.rowMeta}>
            Counted <strong>{say(r.product_id, Number(r.counted), r.base_unit)}</strong>
            {r.expected != null && Number(r.variance ?? 0) !== 0 && (
              <> · records said {say(r.product_id, Number(r.expected), r.base_unit)}</>
            )}
          </span>
        </span>
        <ChevronRightIcon className={styles.chevron} />
      </>
    );
  };

  return (
    <PageScaffold headerScrolls onBack={goBack} title="Count history" subtitle="Every count, and what it found">
      <PageState status={status}>
        {() => (
          <>
            {/* Search, filters and export stay in reach as the list scrolls — see PinnedTools. */}
            <PinnedTools>
              <SearchLauncher label="Search counts" placeholder="Search an item" onOpen={searchOps.open} />
              <ListFilters<CountFilter>
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'today', label: 'Today' },
                  { value: 'week', label: 'This week' },
                  { value: 'matched', label: 'Matched' },
                  { value: 'off', label: 'Off' },
                ]}
                value={filter}
                onChange={setFilter}
                onPrint={() =>
                  printList({
                    title: 'Counts',
                    filename: csvName('counts', filter).replace(/\.csv$/, ''),
                    build: async () => {
                      const rows = await fetchAllPages(fetchPage);
                      return listDocument({
                        shopName: store?.name ?? '',
                        title: 'Counts',
                        meta: [`${rows.length} ${rows.length === 1 ? 'count' : 'counts'} · ${filter}`, new Date().toLocaleString()],
                        rows: rows.map((r) => ({
                          name: r.product_name,
                          detail: `${new Date(r.counted_at).toLocaleString()} · ${person(r.counted_by_name)} · counted ${say(
                            r.product_id,
                            Number(r.counted),
                            r.base_unit,
                          )}${r.expected == null ? '' : `, records ${say(r.product_id, Number(r.expected), r.base_unit)}`}`,
                          amount: found(r).text,
                        })),
                      });
                    },
                  })
                }
                onExport={async () => {
                  const rows = await fetchAllPages(fetchPage);
                  const csv = toCsv(rows, [
                    { head: 'Counted at', value: (r) => new Date(r.counted_at).toLocaleString() },
                    { head: 'Item', value: (r) => r.product_name },
                    { head: 'Counted by', value: (r) => person(r.counted_by_name) },
                    { head: 'Counted', value: (r) => say(r.product_id, Number(r.counted), r.base_unit) },
                    { head: 'Records said', value: (r) => (r.expected == null ? '' : say(r.product_id, Number(r.expected), r.base_unit)) },
                    { head: 'Found', value: (r) => found(r).text },
                    { head: `Difference (${'base units'})`, value: (r) => Number(r.variance ?? 0) },
                  ]);
                  const how = await shareCsv(csvName('counts', filter), csv);
                  return how === 'downloaded' ? `${rows.length} counts saved to your downloads.` : how === 'shared' ? `${rows.length} counts shared.` : null;
                }}
              />
            </PinnedTools>

            <SearchSheet<CountRow>
              id={searchId}
              isOpen={isSearchOpen}
              onClose={searchOps.close}
              placeholder="Search an item"
              onInitialData={(text) => {
                const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
                if (words.length === 0) return list.items;
                return list.items.filter((r) => words.every((w) => r.product_name.toLowerCase().includes(w)));
              }}
              localDataDeps={[list.items]}
              queryData={async (_cursor, text) => {
                const { data, error } = await getSupabase().rpc('count_history_page', {
                  p_store_id: store.id,
                  p_filter: 'all',
                  p_query: text.trim() || null,
                  p_before_at: null,
                  p_before_id: null,
                  p_limit: 50,
                });
                if (error) throw error;
                return { data: (data ?? []) as CountRow[] };
              }}
              keyOf={(r) => r.id}
              emptyText="No count of an item by that name."
              renderRow={(r) => (
                <button
                  type="button"
                  className={styles.row}
                  onClick={async () => {
                    await nav.push('stock_history_page', { id: r.product_id });
                    searchOps.close();
                  }}
                >
                  {rowBody(r)}
                </button>
              )}
            />

            {list.items.length === 0 ? (
              <InfoPanel tone="info" title={filter === 'all' ? 'No counts yet' : 'None here'}>
                {filter === 'off'
                  ? 'Every count matched the records.'
                  : filter === 'matched'
                    ? 'No count has matched the records yet.'
                    : 'Counts appear here as soon as somebody counts a shelf.'}
              </InfoPanel>
            ) : (
              <>
                <ul className={styles.list}>
                  {list.items.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className={styles.row}
                        onClick={() => void nav.push('stock_history_page', { id: r.product_id })}
                      >
                        {rowBody(r)}
                      </button>
                    </li>
                  ))}
                </ul>
                {list.hasMore && (
                  <div ref={sentinelRef} className={styles.sentinel}>
                    {list.loadingMore ? 'Loading more…' : ''}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
