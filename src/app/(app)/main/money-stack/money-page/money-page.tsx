'use client';

import { useCallback, useMemo } from 'react';
import styles from './money-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { SearchLauncher } from '@/components/ui/SearchLauncher';
import { SearchSheet } from '@/components/ui/SearchSheet';
import { useSearchController } from '@academix-admin/search-viewer';
import { InfoPanel } from '@/components/ui/Explain';
import { ChartIcon, ChevronRightIcon, ReceiptIcon } from '@/components/ui/Icon';
import { useAuth } from '@/providers/AuthProvider';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useNav } from '@academix-admin/navigation-stack';
import { usePaginatedList, useInfiniteScroll } from '@/hooks/usePaginatedList';
import { useProvideCustomers } from '@/lib/stacks/customer-directory';
import { getSupabase } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/format';

interface CustomerRow {
  id: string;
  display_name: string;
  business_name: string | null;
  phone: string;
  balance: string;
}

/**
 * Who owes you, and what is behind each number.
 *
 * Built around the requirement that records pull each other up: a balance is never a bare figure.
 * Tapping a customer shows the receipts that built it, and tapping a receipt opens the sale
 * itself. A number you cannot trace is exactly what people distrust about accounting software —
 * and why they keep a paper book beside it.
 */
export default function MoneyPage() {
  const goBack = useStackBack();
  const nav = useNav();
  const { store } = useAuth();

  // Browsing here; searching happens in the sheet, where the results get the whole screen.
  const [searchId, searchOps, isSearchOpen] = useSearchController();

  const fetchPage = useCallback(
    async (cursor: unknown | null, limit: number) => {
      if (!store) return { rows: [] as CustomerRow[], cursor: null };
      const c = cursor as { name: string; id: string } | null;
      const { data, error: err } = await getSupabase().rpc('list_customers', {
        p_store_id: store.id,
        p_query: null,
        p_after_name: c?.name ?? null,
        p_after_id: c?.id ?? null,
        p_limit: limit,
      });
      if (err) throw err;
      const rows = (data ?? []) as CustomerRow[];
      const last = rows[rows.length - 1];
      return { rows, cursor: last ? { name: last.display_name, id: last.id } : null };
    },
    [store],
  );

  const list = usePaginatedList<CustomerRow>({
    fetchPage,
    getId: (r) => r.id,
    // Persisted, so returning from a statement or a receipt keeps the list and its cursor.
    key: 'debtors',
    scope: 'money_flow',
    deps: [store?.id],
    enabled: Boolean(store),
  });

  /*
   * Publish these rows so a pushed page can ask for one by id.
   *
   * The statement page used to be handed `{ id, name }`; it now gets `{ id }` and looks the rest
   * up here. See `customer-directory` for why a record has no business being in a URL.
   */
  useProvideCustomers(list.items);

  /*
   * Keep the balances on these cards current.
   *
   * They were loaded once and then left, so a card could advertise a figure that a sale or a
   * payment made untrue minutes earlier — and tapping it opened a statement showing the real
   * number, which is the worst version: two screens, one customer, two answers, with no way to
   * tell which to believe.
   */
  /*
   * Reloaded when this tab is returned to, rather than on a timer.
   *
   * `onResume` fires once, when someone actually comes back — so the list is correct at the moment
   * it is looked at, with no polling in between and no interruption while a search sheet is open
   * (the sheet is not a resume; nothing fires).
   */
  /*
   * `refresh`, not `reload`.
   *
   * `reload` starts again from page one. On a list somebody has paged through, returning to it
   * would collapse a hundred rows back to twenty — losing the row they tapped and the scroll that
   * led to it. `refresh` re-reads the span that is already on screen and keeps its length.
   */
  useLiveRefresh(nav, list.refresh);

  const sentinelRef = useInfiniteScroll(list.loadMore, {
    enabled: list.hasMore && !list.loading,
  });

  const owed = useMemo(
    () => list.items.reduce((sum, c) => sum + Math.max(Number(c.balance), 0), 0),
    [list.items],
  );

  if (!store) return null;

  if (list.loading && list.items.length === 0) {
    return <FullPageMessage title="Loading balances" tone="loading" />;
  }

  return (
    <PageScaffold
      onBack={goBack}
      title="Money"
      subtitle="Who owes you, and what has been paid"
      actions={[
        {
          key: 'reports',
          icon: <ChartIcon />,
          onClick: () => void nav.push('reports_page'),
          ariaLabel: 'Reports you can print or save',
        },
        {
          key: 'sales',
          icon: <ReceiptIcon />,
          onClick: () => void nav.push('sales_page'),
          ariaLabel: 'All sales and receipts',
        },
      ]}
    >
      <div className={styles.summary}>
        <span className={styles.summaryLabel}>
          {list.hasMore ? 'Owed by those loaded so far' : 'Owed to you'}
        </span>
        <span className={styles.summaryValue}>{formatMoney(owed)}</span>
      </div>

      <SearchLauncher
        label="Search customers"
        placeholder="Search by name or phone"
        onOpen={searchOps.open}
      />

      <SearchSheet<CustomerRow>
        id={searchId}
        isOpen={isSearchOpen}
        onClose={searchOps.close}
        placeholder="Search by name or phone"
        onInitialData={(text) => {
          const t = text.trim().toLowerCase();
          if (!t) return list.items;
          return list.items.filter(
            (c) => c.display_name.toLowerCase().includes(t) || c.phone.includes(t),
          );
        }}
        localDataDeps={[list.items]}
        queryData={async (_cursor, text) => {
          const { data, error } = await getSupabase().rpc('list_customers', {
            p_store_id: store.id,
            p_query: text.trim() || null,
            p_after_name: null,
            p_after_id: null,
            p_limit: 50,
          });
          if (error) throw error;
          return { data: (data ?? []) as CustomerRow[] };
        }}
        keyOf={(c) => c.id}
        emptyText="Try part of the name, or the phone number they gave you."
        renderRow={(c) => (
          <button
            type="button"
            className={`${styles.row} ${styles.rowLink}`}
            onClick={async () => {
              // Navigate FIRST, then close. The overlay's history entry is removed on close,
              // and doing that before the push has landed queues a step back that discards the
              // page just pushed — tapping a result dismissed the search and went nowhere.
              await nav.push('statement_page', { id: c.id });
              searchOps.close();
            }}
          >
            <span className={styles.rowMain}>
              <span className={styles.rowName}>{c.display_name}</span>
              <span className={styles.rowMeta}>{c.phone}</span>
            </span>
            <span
              className={`${styles.rowBalance} ${
                Number(c.balance) > 0 ? styles.owing : styles.clear
              }`}
            >
              {Number(c.balance) > 0 ? formatMoney(c.balance) : 'Clear'}
            </span>
          </button>
        )}
      />

      {list.items.length === 0 ? (
        <InfoPanel tone="info" title="Nobody owes you anything yet">
          Customers appear here once you sell to them on credit.
        </InfoPanel>
      ) : (
        <>
          <ul className={styles.list}>
            {list.items.map((c) => {
              const balance = Number(c.balance);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    className={`${styles.row} ${styles.rowLink}`}
                    onClick={() =>
                      void nav.push('statement_page', { id: c.id })
                    }
                  >
                    <span className={styles.rowMain}>
                      <span className={styles.rowName}>{c.display_name}</span>
                      <span className={styles.rowMeta}>{c.phone}</span>
                    </span>
                    <span
                      className={`${styles.rowBalance} ${balance > 0 ? styles.owing : styles.clear}`}
                    >
                      {balance > 0 ? formatMoney(balance) : 'Clear'}
                    </span>
                    <ChevronRightIcon />
                  </button>
                </li>
              );
            })}
          </ul>

          {list.hasMore && (
            <div ref={sentinelRef} className={styles.sentinel}>
              {list.loadingMore ? 'Loading more…' : ''}
            </div>
          )}
        </>
      )}

      {/*
        The customer's statement is a PAGE now, not a dialog here.
        A balance is made of receipts and a receipt of lines; a dialog gives one level of depth and
        then has to stack another over itself, with no back button. See money-stack/statement-page.
      */}

      {/* ── The receipt behind one line ─────────────────────────────────────────── */}
    </PageScaffold>
  );
}
