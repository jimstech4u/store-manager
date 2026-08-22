'use client';

import { useMemo, useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { InfoPanel } from '@/components/ui/Explain';
import { SearchField, useDebounced } from '@/components/ui/SearchField';
import { Button } from '@/components/ui/Button';
import { ChevronRightIcon, PlusIcon } from '@/components/ui/Icon';
import { useNav } from '@academix-admin/navigation-stack';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useStackBack } from '@/hooks/useStackBack';
import { useProductList, useProductSearch } from '@/lib/stacks/catalog-stack';
import { useInfiniteScroll } from '@/hooks/usePaginatedList';
import { formatMoney, formatQty, pluralUnit } from '@/lib/format';
import { ProductForm } from '@/components/catalog/ProductForm';
import styles from './stock-page.module.css';

/**
 * What is on the shelf, what it cost, and what it is worth.
 *
 * Two data sources behind one list: typing switches to relevance-ordered search, an empty box
 * browses the whole catalogue with a cursor. A 300-line distributor cannot scroll to find
 * anything, and paging through fuzzy matches is not how anyone looks for a product.
 */
export default function StockPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const debounced = useDebounced(query);
  const searching = debounced.trim() !== '';

  const browse = useProductList(store?.id ?? null);
  const search = useProductSearch(store?.id ?? null, searching ? debounced : null);

  const products = searching ? search.products : browse.products;
  const loading = searching ? search.status === 'loading' : browse.loading;
  const error = searching ? search.error : browse.error;

  const sentinelRef = useInfiniteScroll(browse.loadMore, {
    enabled: !searching && browse.hasMore && !browse.loading,
  });

  // Deliberately the value of what is LOADED, not of the whole catalogue: claiming a total while
  // holding one page of it would be a confidently wrong number, which is worse than none.
  const loadedValue = useMemo(
    () => products.reduce((sum, p) => sum + Number(p.onHand) * Number(p.avgUnitCost), 0),
    [products],
  );
  const anyEstimated = products.some((p) => p.costIsEstimated);

  if (!store) return null;

  if (loading && products.length === 0) {
    return <FullPageMessage title="Loading your stock" tone="loading" />;
  }

  if (error && products.length === 0) {
    return (
      <FullPageMessage
        title="Could not load your stock"
        tone="error"
        action={
          <Button fullWidth onClick={searching ? search.reload : browse.reload}>
            Try again
          </Button>
        }
      >
        {error}
      </FullPageMessage>
    );
  }

  return (
    <PageScaffold
      onBack={goBack}
      title="Stock"
      subtitle={store.name}
      actions={
        can('products.manage')
          ? [
              {
                key: 'add',
                icon: <PlusIcon />,
                onClick: () => setAdding(true),
                ariaLabel: 'Add an item you sell',
              },
            ]
          : undefined
      }
      footer={
        can('stock.receive') ? (
          <Button size="large" fullWidth onClick={() => nav.push('receive_page')}>
            <PlusIcon /> Record a delivery
          </Button>
        ) : undefined
      }
    >
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder="Search products or a category"
        label="Search your stock"
        resultCount={searching ? products.length : undefined}
      />

      <ProductForm
        open={adding}
        onClose={() => setAdding(false)}
        storeId={store.id}
        initialName={searching ? query : ''}
        onSaved={() => {
          setQuery('');
          void browse.reload();
        }}
      />

      {products.length === 0 ? (
        <InfoPanel tone="info" title={searching ? 'Nothing found' : 'Nothing here yet'}>
          {searching
            ? 'Try part of the name, or a category like “water”.'
            : 'Add what you sell and it will show up here with what it cost and what you have left.'}
        </InfoPanel>
      ) : (
        <>
          {!searching && (
            <div className={styles.summary}>
              <span className={styles.summaryLabel}>
                {browse.hasMore ? 'Loaded so far, worth' : 'Stock is worth'}
              </span>
              <span className={styles.summaryValue}>{formatMoney(loadedValue)}</span>
              <span className={styles.summaryNote}>
                at what it cost you, not what you sell it for
              </span>
            </div>
          )}

          {anyEstimated && (
            <InfoPanel tone="warning" title="Some costs are still estimates">
              Items marked <strong>estimated</strong> use the figure entered at setup. The next
              delivery you record replaces it with the real cost, including fees.
            </InfoPanel>
          )}

          <ul className={styles.list}>
            {products.map((p) => {
              const out = Number(p.onHand) <= 0;
              return (
                <li key={p.id}>
                  {/* A button, not a div with onClick: this has to be reachable by keyboard and
                      announced as an action, and the whole row is the target so it is easy to hit
                      without aiming. */}
                  <button
                    type="button"
                    className={styles.item}
                    onClick={() => nav.push('product_page', { id: p.id })}
                  >
                  <div className={styles.itemMain}>
                    <p className={styles.itemName}>{p.name}</p>
                    <p className={styles.itemMeta}>
                      {formatMoney(p.avgUnitCost, 2)} per {p.baseUnit} cost
                      {p.categoryName && <span>· {p.categoryName}</span>}
                      {p.costIsEstimated && <span className={styles.estimate}>estimated</span>}
                    </p>
                  </div>
                  <div className={styles.itemQty}>
                    <span className={`${styles.qtyValue} ${out ? styles.qtyLow : ''}`}>
                      {formatQty(p.onHand)}
                    </span>
                    <span className={styles.qtyUnit}>
                      {pluralUnit(p.baseUnit, Number(p.onHand))}
                    </span>
                  </div>
                  <ChevronRightIcon className={styles.itemChevron} />
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Sentinel: loading starts before this is visible, so the list stays ahead of the
              reader rather than stalling at the bottom. */}
          {!searching && browse.hasMore && (
            <div ref={sentinelRef} className={styles.sentinel}>
              {browse.loadingMore ? 'Loading more…' : ''}
            </div>
          )}
        </>
      )}
    </PageScaffold>
  );
}
