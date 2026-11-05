'use client';

import { useMemo, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { ListFilters } from '@/components/ui/ListFilters';
import { InfoPanel } from '@/components/ui/Explain';
import { ChevronRightIcon } from '@/components/ui/Icon';
import { listDocument, PrintShareButton } from '@/components/ui/PrintShare';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useItemDebts } from '@/lib/stacks/product-debts';
import { useSayInShapes } from '@/lib/stacks/selling-units';
import { formatDate, formatMoney } from '@/lib/format';
import styles from './item-debts-page.module.css';

type Show = 'owing' | 'took';

/**
 * WHO TOOK THIS — an item's customers, from the item. "Say Zitar: we look for the receipts that took
 * it and payment has not been completed, so the record can come out."
 *
 * Grouped by customer, because the next thing done with the answer is ringing somebody, and each
 * receipt opens itself.
 */
export default function ItemDebtsPage() {
  const goBack = useStackBack();
  const nav = useNav();
  const location = useLocation();
  const { store } = useAuth();
  const productId = (location?.params?.id as string | undefined) ?? null;
  const [show, setShow] = useState<Show>('owing');
  const data = useItemDebts(store?.id ?? null, productId);
  const say = useSayInShapes(store?.id ?? null);

  const people = useMemo(() => {
    const byCustomer = new Map<string, NonNullable<typeof data.data>['debts']>();
    for (const d of data.data?.debts ?? []) {
      byCustomer.set(d.customerId, [...(byCustomer.get(d.customerId) ?? []), d]);
    }
    return [...byCustomer.values()].sort(
      (a, b) => b.reduce((t, r) => t + r.open, 0) - a.reduce((t, r) => t + r.open, 0),
    );
  }, [data.data]);

  const openTotal = (data.data?.debts ?? []).reduce((t, d) => t + d.open, 0);
  const name = data.data?.name ?? '';

  const status: PageStatus = !data.loaded
    ? { state: 'loading', what: 'who took this' }
    : data.error
      ? { state: 'error', what: 'who took this', error: String(data.error), onRetry: () => data.reload() }
      : { state: 'ready' };

  return (
    <PageScaffold layout="wide" onBack={goBack} title="Who took this" subtitle={name}>
      <PageState status={status}>
        {() => (
          <>
            <ListFilters<Show>
              options={[
                { value: 'owing', label: 'Still owing' },
                { value: 'took', label: 'Everyone who took it' },
              ]}
              value={show}
              onChange={setShow}
            />

            {show === 'owing' ? (
              people.length === 0 ? (
                <InfoPanel tone="info" title="Nobody owes for this">
                  Every receipt with this item on it has been paid.
                </InfoPanel>
              ) : (
                <>
                  <p className={styles.headline}>
                    {people.length} {people.length === 1 ? 'customer' : 'customers'} ·{' '}
                    <strong>{formatMoney(openTotal)}</strong> open on these receipts
                  </p>
                  {people.map((receipts) => {
                    const first = receipts[0];
                    return (
                      <section key={first.customerId} className={styles.person}>
                        <button
                          type="button"
                          className={styles.who}
                          onClick={() => void nav.push('account_page', { id: first.customerId })}
                        >
                          <span className={styles.body}>
                            <span className={styles.name}>{first.customerName}</span>
                            <span className={styles.meta}>Owes {formatMoney(first.balance)} in all</span>
                          </span>
                          <ChevronRightIcon />
                        </button>
                        <ul className={styles.list} data-grid>
                          {receipts.map((r) => (
                            <li key={r.saleId}>
                              <button
                                type="button"
                                className={styles.row}
                                onClick={() => void nav.push('receipt_page', { id: r.saleId })}
                              >
                                <span className={styles.body}>
                                  <span className={styles.name}>Took {r.took}</span>
                                  <span className={styles.meta}>
                                    {formatDate(r.occurredAt)} · #{r.saleId.slice(0, 8).toUpperCase()} · receipt{' '}
                                    {formatMoney(r.receiptTotal)}
                                  </span>
                                </span>
                                <span className={styles.amount}>{formatMoney(r.open)} open</span>
                                <ChevronRightIcon />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                  <p className={styles.meta}>
                    A part payment is against the whole receipt, not one item, so a receipt with other
                    items on it may be open for those.
                  </p>
                  <PrintShareButton
                    spec={() => ({
                      title: 'Still owing',
                      filename: 'still-owing',
                      build: () =>
                        listDocument({
                          shopName: store?.name ?? '',
                          title: 'Still owing',
                          meta: [name, new Date().toLocaleString()],
                          rows: (data.data?.debts ?? []).map((d) => ({
                            name: d.customerName,
                            detail: `#${d.saleId.slice(0, 8).toUpperCase()} ${formatDate(d.occurredAt)}, took ${d.took}`,
                            amount: formatMoney(d.open),
                          })),
                          totals: [{ label: 'Open on these receipts', value: formatMoney(openTotal), strong: true }],
                        }),
                    })}
                  />
                </>
              )
            ) : (data.data?.buyers ?? []).length === 0 ? (
              <InfoPanel tone="info" title="Nobody yet">
                This item has not been sold.
              </InfoPanel>
            ) : (
              <ul className={styles.list} data-grid>
                {(data.data?.buyers ?? []).map((b) => (
                  <li key={b.customerId ?? 'walk-in'}>
                    <button
                      type="button"
                      className={styles.row}
                      disabled={!b.customerId}
                      onClick={() => b.customerId && void nav.push('account_page', { id: b.customerId })}
                    >
                      <span className={styles.body}>
                        <span className={styles.name}>{b.customerName}</span>
                        <span className={styles.meta}>
                          {say(productId ?? '', b.soldBase, '')} · {b.receipts}{' '}
                          {b.receipts === 1 ? 'receipt' : 'receipts'} · last {formatDate(b.lastAt)}
                        </span>
                      </span>
                      <span className={styles.amount}>{formatMoney(b.amount)}</span>
                      {b.customerId && <ChevronRightIcon />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
