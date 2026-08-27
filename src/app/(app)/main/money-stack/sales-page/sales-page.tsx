'use client';

import { useCallback } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { SearchLauncher } from '@/components/ui/SearchLauncher';
import { SearchSheet } from '@/components/ui/SearchSheet';
import { useSearchController } from '@academix-admin/search-viewer';
import { InfoPanel } from '@/components/ui/Explain';
import { ChevronRightIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { usePaginatedList, useInfiniteScroll } from '@/hooks/usePaginatedList';
import { getSupabase } from '@/lib/supabase/client';
import { formatDateTime, formatMoney } from '@/lib/format';
import styles from './sales-page.module.css';

/**
 * Every sale this shop has recorded, newest first — and the way back to any receipt.
 *
 * "Print that one again" is an ordinary counter request that had no answer: a receipt could only
 * be seen in the moment it was created, and once dismissed it was gone. A customer who loses their
 * copy, a disputed line, an end-of-day check against the cash box — all of them need to reach a
 * finished sale, and all of them were dead ends.
 *
 * Cursor-paginated on `(occurred_at, id)` rather than offset: a shop adds sales while this list is
 * open, and an offset page-2 would silently skip whatever arrived in the meantime.
 */

interface SaleRow {
  id: string;
  occurred_at: string;
  total: string;
  paid: string;
  outstanding: string;
  customer_id: string | null;
  customer_name: string | null;
  note: string | null;
  line_count: number;
}

export default function SalesPage() {
  const goBack = useStackBack();
  const nav = useNav();
  const { store } = useAuth();

  // Browsing here; searching happens in the sheet, where the results get the whole screen.
  const [searchId, searchOps, isSearchOpen] = useSearchController();

  const fetchPage = useCallback(
    async (cursor: unknown | null, limit: number) => {
      if (!store) return { rows: [] as SaleRow[], cursor: null };
      const c = cursor as { at: string; id: string } | null;

      const { data, error } = await getSupabase().rpc('list_sales', {
        p_store_id: store.id,
        p_query: null,
        p_after_at: c?.at ?? null,
        p_after_id: c?.id ?? null,
        p_limit: limit,
      });
      if (error) throw error;

      const rows = (data ?? []) as SaleRow[];
      const last = rows[rows.length - 1];
      return { rows, cursor: last ? { at: last.occurred_at, id: last.id } : null };
    },
    [store],
  );

  const list = usePaginatedList<SaleRow>({
    fetchPage,
    getId: (s) => s.id,
    key: 'sales',
    scope: 'money_flow',
    deps: [store?.id ?? ''],
    enabled: Boolean(store),
  });

  const sentinelRef = useInfiniteScroll(list.loadMore, {
    enabled: list.hasMore && !list.loading,
  });

  if (!store) return null;
  if (list.loading && list.items.length === 0) {
    return <FullPageMessage title="Loading sales" tone="loading" />;
  }

  if (list.error && list.items.length === 0) {
    return (
      <FullPageMessage
        title="Could not load your sales"
        tone="error"
        action={<Button fullWidth onClick={() => list.reload()}>Try again</Button>}
      >
        {list.error}
      </FullPageMessage>
    );
  }

  return (
    <PageScaffold onBack={goBack} title="Sales" subtitle="Every receipt you have issued">
      <SearchLauncher
        label="Search sales"
        placeholder="Search by customer or note"
        onOpen={searchOps.open}
      />

      <SearchSheet<SaleRow>
        id={searchId}
        isOpen={isSearchOpen}
        onClose={searchOps.close}
        placeholder="Search by customer or note"
        onInitialData={(text) => {
          const t = text.trim().toLowerCase();
          if (!t) return list.items;
          return list.items.filter((r) =>
            (r.customer_name ?? 'Walk-in customer').toLowerCase().includes(t),
          );
        }}
        localDataDeps={[list.items]}
        queryData={async (_cursor, text) => {
          const { data, error } = await getSupabase().rpc('list_sales', {
            p_store_id: store.id,
            p_query: text.trim() || null,
            p_after_at: null,
            p_after_id: null,
            p_limit: 50,
          });
          if (error) throw error;
          return { data: (data ?? []) as SaleRow[] };
        }}
        keyOf={(r) => r.id}
        emptyText="Try a customer name, or part of a note you added to the sale."
        renderRow={(r) => (
          <button
            type="button"
            className={styles.row}
            onClick={async () => {
              // Navigate first, then close — see money-page for why the order matters.
              await nav.push('receipt_page', { id: r.id });
              searchOps.close();
            }}
          >
            <span className={styles.rowMain}>
              <span className={styles.rowName}>{r.customer_name ?? 'Walk-in customer'}</span>
              <span className={styles.rowMeta}>
                {formatDateTime(r.occurred_at)} · {r.line_count}{' '}
                {Number(r.line_count) === 1 ? 'item' : 'items'}
              </span>
            </span>
            <span className={styles.rowMoney}>
              <span className={styles.rowTotal}>{formatMoney(r.total)}</span>
              {Number(r.outstanding) > 0 && (
                <span className={styles.rowOwing}>{formatMoney(r.outstanding)} unpaid</span>
              )}
            </span>
          </button>
        )}
      />

      {list.items.length === 0 ? (
        <InfoPanel tone="info" title="No sales yet">
          Sales appear here as soon as you take a payment.
        </InfoPanel>
      ) : (
        <>
          <ul className={styles.list}>
            {list.items.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={styles.row}
                  onClick={() => void nav.push('receipt_page', { id: s.id })}
                >
                  <span className={styles.rowMain}>
                    <span className={styles.rowName}>
                      {s.customer_name ?? 'Walk-in customer'}
                    </span>
                    <span className={styles.rowMeta}>
                      {formatDateTime(s.occurred_at)} · {s.line_count}{' '}
                      {Number(s.line_count) === 1 ? 'item' : 'items'}
                    </span>
                  </span>

                  <span className={styles.rowMoney}>
                    <span className={styles.rowTotal}>{formatMoney(s.total)}</span>
                    {Number(s.outstanding) > 0 && (
                      <span className={styles.rowOwing}>
                        {formatMoney(s.outstanding)} unpaid
                      </span>
                    )}
                  </span>

                  <ChevronRightIcon className={styles.chevron} />
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
    </PageScaffold>
  );
}
