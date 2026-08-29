'use client';

import { useCallback, useState } from 'react';
import styles from '../../money-stack/money-page/money-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { useStackBack } from '@/hooks/useStackBack';
import { useListChannel } from '@/hooks/useListChannel';
import { useNav } from '@academix-admin/navigation-stack';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { SearchLauncher } from '@/components/ui/SearchLauncher';
import { SearchSheet } from '@/components/ui/SearchSheet';
import { useSearchController } from '@academix-admin/search-viewer';
import { InfoPanel } from '@/components/ui/Explain';
import { ChevronRightIcon, PlusIcon } from '@/components/ui/Icon';
import { CustomerPicker } from '@/components/customers/CustomerPicker';
import { useAuth } from '@/providers/AuthProvider';
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
 * Customers.
 *
 * Deliberately not a place you are pushed to before selling — most buyers are anonymous, and a
 * customer only needs saving when they buy on credit. This is where the ones who were saved live.
 */
export default function PeoplePage() {
  const goBack = useStackBack();
  const nav = useNav();
  const { store } = useAuth();
  const [adding, setAdding] = useState(false);

  /*
   * The list browses; searching happens in the SearchViewer sheet.
   *
   * The page used to swap its own list between browsing and results, which put the matches under
   * the box that produced them with the phone keyboard over the top. The sheet gets the screen.
   */
  const [searchId, searchOps, isSearchOpen] = useSearchController();

  const fetchPage = useCallback(
    async (cursor: unknown | null, limit: number) => {
      if (!store) return { rows: [] as CustomerRow[], cursor: null };
      const c = cursor as { name: string; id: string } | null;
      const { data, error } = await getSupabase().rpc('list_customers', {
        p_store_id: store.id,
        p_query: null,
        p_after_name: c?.name ?? null,
        p_after_id: c?.id ?? null,
        p_limit: limit,
      });
      if (error) throw error;
      const rows = (data ?? []) as CustomerRow[];
      const last = rows[rows.length - 1];
      return { rows, cursor: last ? { name: last.display_name, id: last.id } : null };
    },
    [store],
  );

  const list = usePaginatedList<CustomerRow>({
    fetchPage,
    getId: (r) => r.id,
    key: 'customers',
    scope: 'customer_flow',
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
  /*
   * Not re-read on the way back — see the debtor list for why. Changes arrive one row at a time
   * through the channel below, which is the only thing that actually happened.
   */

  /*
   * One row at a time, from wherever it changed.
   *
   * A customer renamed on the account screen, or created at the till, used to mean re-reading this
   * whole list — a round trip for something the other page already knew, and every page scrolled
   * through thrown away with it. The row that changed is the row to change.
   */
  useListChannel<CustomerRow>('customers', list.items, list.setItems);

  const sentinelRef = useInfiniteScroll(list.loadMore, {
    enabled: list.hasMore && !list.loading,
  });

  if (!store) return null;

  if (list.loading && list.items.length === 0) {
    return <FullPageMessage title="Loading customers" tone="loading" />;
  }

  return (
    <PageScaffold
      onBack={goBack}
      title="People"
      subtitle="Your customers"
      // Was a bar pinned to the bottom of the page, which covered the last customer in the list.
      actions={[
        {
          key: 'add',
          icon: <PlusIcon />,
          onClick: () => setAdding(true),
          ariaLabel: 'Add a customer',
        },
      ]}
    >
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
            (c) =>
              c.display_name.toLowerCase().includes(t) ||
              (c.business_name ?? '').toLowerCase().includes(t) ||
              c.phone.includes(t),
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
              // Navigate first, then close — see money-page for why the order matters.
              await nav.push('account_page', { id: c.id });
              searchOps.close();
            }}
          >
            <span className={styles.rowMain}>
              <span className={styles.rowName}>{c.display_name}</span>
              <span className={styles.rowMeta}>
                {c.phone}
                {c.business_name ? ` · ${c.business_name}` : ''}
              </span>
            </span>
            <span
              className={`${styles.rowBalance} ${
                Number(c.balance) > 0 ? styles.owing : styles.clear
              }`}
            >
              {Number(c.balance) > 0 ? formatMoney(c.balance) : 'Clear'}
            </span>
            <ChevronRightIcon />
          </button>
        )}
      />

      {list.items.length === 0 ? (
        <InfoPanel tone="info" title="No customers saved yet">
          You only need to save someone when they are buying on credit. Cash sales need nothing.
        </InfoPanel>
      ) : (
        <>
          <ul className={styles.list}>
            {list.items.map((c) => {
              const balance = Number(c.balance);
              return (
                <li key={c.id}>
                  {/* The chevron has always been here promising a detail page that did not
                      exist. It exists now. */}
                  <button
                    type="button"
                    className={`${styles.row} ${styles.rowLink}`}
                    onClick={() => nav.push('account_page', { id: c.id })}
                  >
                    <span className={styles.rowMain}>
                      <span className={styles.rowName}>{c.display_name}</span>
                      <span className={styles.rowMeta}>
                        {c.phone}
                        {c.business_name ? ` · ${c.business_name}` : ''}
                      </span>
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

      <CustomerPicker
        open={adding}
        onClose={() => setAdding(false)}
        storeId={store.id}
        onPick={() => {
          setAdding(false);
          list.reload();
        }}
      />
    </PageScaffold>
  );
}
