'use client';

import { useCallback, useEffect } from 'react';
import styles from './money-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { SearchLauncher } from '@/components/ui/SearchLauncher';
import { SearchSheet } from '@/components/ui/SearchSheet';
import { useSearchController } from '@academix-admin/search-viewer';
import { InfoPanel } from '@/components/ui/Explain';
import { ChartIcon, ChevronRightIcon, ReceiptIcon } from '@/components/ui/Icon';
import { useAuth } from '@/providers/AuthProvider';
import { useStackBack } from '@/hooks/useStackBack';
import { useListChannel } from '@/hooks/useListChannel';
import { useNav } from '@academix-admin/navigation-stack';
import { useDemandState } from '@academix-admin/state-stack';
import { useInvalidation } from '@/lib/stacks/invalidation';
import { ACCOUNT_DERIVED_SCOPE } from '@/lib/stacks/customer-account';
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
/** What the whole shop is owed, and what it is holding — `store_money_owed`, 0091. */
interface OwedSummary {
  owed: string;
  owed_by: number;
  in_credit: string;
  credit_to: number;
}

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
   * NOTHING IS RE-READ ON THE WAY BACK.
   *
   * This used to call `refresh` on resume, which re-fetches the span already on screen and
   * replaces every row in it. It keeps the LENGTH, which is why it looked reasonable — but the
   * rows are new objects in whatever order the database returns them now, so a list somebody had
   * paged through three times visibly shifted the moment they came back from a statement, and the
   * row they had just tapped was no longer where they left it.
   *
   * A change now arrives as a change: the screen that made it says which row it touched, and only
   * that row moves. Coming back from looking at something is not an event that requires re-reading
   * anything, and treating it as one was the whole problem.
   */
  useListChannel<CustomerRow>('debtors', list.items, list.setItems);

  const sentinelRef = useInfiniteScroll(list.loadMore, {
    enabled: list.hasMore && !list.loading,
  });

  /*
   * THE WHOLE SHOP'S RECEIVABLES, computed where the rows are.
   *
   * This was a sum over `list.items` — whatever pages of a PAGED list were in memory — so the
   * headline grew as somebody scrolled and settled on a different answer each time. It read
   * ₦7,492,810 against a real ₦23,254,747.50. The label said "loaded so far", which is honest about
   * a figure that should not have been on the screen at all: it is the first and largest thing on
   * it, which is to say it is the one somebody writes down.
   *
   * Not persisted and revalidated on mount: it is a headline figure that must be right when the
   * screen is looked at, and it is one small row.
   */
  const [owedRow, demandOwed] = useDemandState<OwedSummary | null>(null, {
    key: `money-owed:${store?.id ?? 'none'}`,
    scope: ACCOUNT_DERIVED_SCOPE,
    deps: [store?.id ?? ''],
  });

  const loadOwed = useCallback(() => {
    if (!store) return;
    void demandOwed(async ({ set }: { set: (v: OwedSummary, o?: { override?: boolean }) => void }) => {
      const { data } = await getSupabase().rpc('store_money_owed', { p_store_id: store.id });
      const row = ((data ?? []) as OwedSummary[])[0];
      if (row) set(row, { override: true });
    });
  }, [store, demandOwed]);

  useEffect(loadOwed, [loadOwed]);
  // A payment recorded anywhere in the app changes this figure, so it re-reads rather than sitting
  // on a total that was true when the screen was opened.
  useInvalidation(ACCOUNT_DERIVED_SCOPE, loadOwed);

  const owed = owedRow ? Number(owedRow.owed) : null;

  if (!store) return null;

  if (list.loading && list.items.length === 0) {
    return <FullPageMessage title="Loading balances" tone="loading" />;
  }

  /*
   * A failed load says so, and offers a way out.
   *
   * Without this the screen showed an empty list: a shop with two hundred debtors, looking for all
   * the world like a shop with none. Nothing said the request had failed and nothing could be done
   * about it but leave the page and come back.
   *
   * Only when there is nothing to show. A failure while paging further into a list somebody is
   * already reading must not replace what they can see — they keep the rows they have, and the
   * next scroll tries again.
   */
  if (list.error && list.items.length === 0) {
    return (
      <FullPageMessage
        title="Could not load who owes you"
        tone="error"
        action={
          <Button fullWidth onClick={() => list.reload()}>
            Try again
          </Button>
        }
      >
        {list.error}
      </FullPageMessage>
    );
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
          Owed to you
          {owedRow && Number(owedRow.owed_by) > 0 && (
            <span className={styles.summaryBy}>
              {' '}
              by {owedRow.owed_by} {Number(owedRow.owed_by) === 1 ? 'customer' : 'customers'}
            </span>
          )}
        </span>
        <span className={styles.summaryValue}>
          {owed == null ? '—' : formatMoney(owed)}
        </span>

        {/*
          AND WHAT THE SHOP OWES BACK, on its own line rather than netted off.

          A customer in credit is money the shop is holding. It cannot be spent covering somebody
          else's debt, so subtracting it would understate the debt and hide the deposit at once.
        */}
        {owedRow && Number(owedRow.in_credit) > 0 && (
          <span className={styles.summaryCredit}>
            {formatMoney(owedRow.in_credit)} in credit to {owedRow.credit_to}{' '}
            {Number(owedRow.credit_to) === 1 ? 'customer' : 'customers'}
          </span>
        )}
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
