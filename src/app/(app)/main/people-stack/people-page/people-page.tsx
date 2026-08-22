'use client';

import { useCallback, useState } from 'react';
import styles from '../../money-stack/money-page/money-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { useStackBack } from '@/hooks/useStackBack';
import { useNav } from '@academix-admin/navigation-stack';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { SearchField, useDebounced } from '@/components/ui/SearchField';
import { InfoPanel } from '@/components/ui/Explain';
import { ChevronRightIcon, PlusIcon } from '@/components/ui/Icon';
import { CustomerPicker } from '@/components/customers/CustomerPicker';
import { useAuth } from '@/providers/AuthProvider';
import { usePaginatedList, useInfiniteScroll } from '@/hooks/usePaginatedList';
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
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
  const [adding, setAdding] = useState(false);

  const fetchPage = useCallback(
    async (cursor: unknown | null, limit: number) => {
      if (!store) return { rows: [] as CustomerRow[], cursor: null };
      const c = cursor as { name: string; id: string } | null;
      const { data, error } = await getSupabase().rpc('list_customers', {
        p_store_id: store.id,
        p_query: debounced.trim() || null,
        p_after_name: c?.name ?? null,
        p_after_id: c?.id ?? null,
        p_limit: limit,
      });
      if (error) throw error;
      const rows = (data ?? []) as CustomerRow[];
      const last = rows[rows.length - 1];
      return { rows, cursor: last ? { name: last.display_name, id: last.id } : null };
    },
    [store, debounced],
  );

  const list = usePaginatedList<CustomerRow>({
    fetchPage,
    getId: (r) => r.id,
    deps: [store?.id, debounced],
    enabled: Boolean(store),
  });

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
      footer={
        <Button size="large" fullWidth onClick={() => setAdding(true)}>
          <PlusIcon /> Add a customer
        </Button>
      }
    >
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder="Search by name or phone"
        label="Search customers"
        resultCount={debounced.trim() ? list.items.length : undefined}
      />

      {list.items.length === 0 ? (
        <InfoPanel tone="info" title={debounced.trim() ? 'Nobody by that name' : 'No customers saved yet'}>
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
