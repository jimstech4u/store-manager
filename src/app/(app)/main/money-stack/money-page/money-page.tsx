'use client';

import { useCallback, useMemo, useState } from 'react';
import styles from './money-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { SearchField, useDebounced } from '@/components/ui/SearchField';
import { InfoPanel } from '@/components/ui/Explain';
import { CashIcon, ChevronRightIcon } from '@/components/ui/Icon';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useStackBack } from '@/hooks/useStackBack';
import { usePaginatedList, useInfiniteScroll } from '@/hooks/usePaginatedList';
import { getSupabase } from '@/lib/supabase/client';
import { formatDate, formatMoney } from '@/lib/format';
import { Receipt } from '../../sell-stack/sell-page/Receipt';

interface CustomerRow {
  id: string;
  display_name: string;
  business_name: string | null;
  phone: string;
  balance: string;
}

interface StatementRow {
  sale_id: string;
  occurred_at: string;
  total: string;
  paid: string;
  outstanding: string;
  line_count: number;
  note: string | null;
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
  const { store } = useAuth();
  const { can } = usePermission();

  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);

  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [statement, setStatement] = useState<StatementRow[] | null>(null);
  const [openSale, setOpenSale] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'transfer' | 'pos'>('cash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (cursor: unknown | null, limit: number) => {
      if (!store) return { rows: [] as CustomerRow[], cursor: null };
      const c = cursor as { name: string; id: string } | null;
      const { data, error: err } = await getSupabase().rpc('list_customers', {
        p_store_id: store.id,
        p_query: debounced.trim() || null,
        p_after_name: c?.name ?? null,
        p_after_id: c?.id ?? null,
        p_limit: limit,
      });
      if (err) throw err;
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

  const owed = useMemo(
    () => list.items.reduce((sum, c) => sum + Math.max(Number(c.balance), 0), 0),
    [list.items],
  );

  const openCustomer = async (c: CustomerRow) => {
    setCustomer(c);
    setStatement(null);
    const { data } = await getSupabase().rpc('customer_statement', {
      p_store_customer_id: c.id,
    });
    setStatement((data ?? []) as StatementRow[]);
  };

  const recordPayment = async () => {
    if (!customer || !store) return;
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await getSupabase().rpc('record_payment', {
        p_store_id: store.id,
        p_customer_id: customer.id,
        p_amount: Number(amount),
        p_method: method,
      });
      if (err) throw err;

      setPaying(false);
      setAmount('');
      list.reload();
      await openCustomer(customer);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not record this payment');
    } finally {
      setBusy(false);
    }
  };

  if (!store) return null;

  if (list.loading && list.items.length === 0) {
    return <FullPageMessage title="Loading balances" tone="loading" />;
  }

  return (
    <PageScaffold onBack={goBack} title="Money" subtitle="Who owes you, and what has been paid">
      <div className={styles.summary}>
        <span className={styles.summaryLabel}>
          {list.hasMore ? 'Owed by those loaded so far' : 'Owed to you'}
        </span>
        <span className={styles.summaryValue}>{formatMoney(owed)}</span>
      </div>

      <SearchField
        value={query}
        onChange={setQuery}
        placeholder="Search by name or phone"
        label="Search customers"
        resultCount={debounced.trim() ? list.items.length : undefined}
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
                  <button type="button" className={styles.row} onClick={() => openCustomer(c)}>
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

      {/* ── One customer, and the receipts behind their balance ─────────────────── */}
      <Sheet
        open={customer !== null}
        onClose={() => {
          setCustomer(null);
          setStatement(null);
        }}
        title={customer?.display_name ?? ''}
        footer={
          customer && can('payments.record') && Number(customer.balance) > 0 ? (
            <Button size="large" fullWidth onClick={() => setPaying(true)}>
              Record a payment
            </Button>
          ) : undefined
        }
      >
        {customer && (
          <>
            <div className={styles.balanceCard}>
              <span className={styles.summaryLabel}>Currently owes</span>
              <span className={styles.summaryValue}>{formatMoney(customer.balance)}</span>
              <span className={styles.rowMeta}>{customer.phone}</span>
            </div>

            {statement === null ? (
              <FullPageMessage title="Loading their receipts" tone="loading" />
            ) : statement.length === 0 ? (
              <InfoPanel tone="info" title="No receipts yet">
                Nothing has been sold to this customer.
              </InfoPanel>
            ) : (
              <>
                <p className={styles.sectionLabel}>What makes up this balance</p>
                <ul className={styles.list}>
                  {statement.map((s) => (
                    <li key={s.sale_id}>
                      <button
                        type="button"
                        className={styles.row}
                        onClick={() => setOpenSale(s.sale_id)}
                      >
                        <span className={styles.rowMain}>
                          <span className={styles.rowName}>{formatDate(s.occurred_at)}</span>
                          <span className={styles.rowMeta}>
                            {s.line_count} {s.line_count === 1 ? 'item' : 'items'} ·{' '}
                            {formatMoney(s.total)} total · {formatMoney(s.paid)} paid
                          </span>
                        </span>
                        <span
                          className={`${styles.rowBalance} ${
                            Number(s.outstanding) > 0 ? styles.owing : styles.clear
                          }`}
                        >
                          {Number(s.outstanding) > 0 ? formatMoney(s.outstanding) : 'Paid'}
                        </span>
                        <ChevronRightIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </Sheet>

      {/* ── The receipt behind one line ─────────────────────────────────────────── */}
      <Sheet open={openSale !== null} onClose={() => setOpenSale(null)} title="Receipt">
        {openSale && <Receipt saleId={openSale} storeId={store.id} />}
      </Sheet>

      {/* ── Record a payment against the balance ────────────────────────────────── */}
      <Sheet
        open={paying}
        onClose={() => setPaying(false)}
        title="Record a payment"
        footer={
          <Button
            size="large"
            fullWidth
            busy={busy}
            busyLabel="Recording"
            disabled={!amount || Number(amount) <= 0}
            onClick={recordPayment}
          >
            Record {amount ? formatMoney(amount) : 'payment'}
          </Button>
        }
      >
        {error && (
          <InfoPanel tone="danger" title="Could not record this">
            {error}
          </InfoPanel>
        )}

        {customer && (
          <div className={styles.balanceCard}>
            <span className={styles.summaryLabel}>{customer.display_name} owes</span>
            <span className={styles.summaryValue}>{formatMoney(customer.balance)}</span>
          </div>
        )}

        <div className={styles.methods} role="group" aria-label="Payment method">
          {(['cash', 'transfer', 'pos'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`${styles.method} ${method === m ? styles.methodActive : ''}`}
              onClick={() => setMethod(m)}
              aria-pressed={method === m}
            >
              {m === 'pos' ? 'POS' : m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        <Field
          label="How much are they paying?"
          numeric
          prefix="₦"
          autoFocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          hint="Payments go against their oldest receipts first."
        />

        {customer && (
          <Button
            variant="secondary"
            fullWidth
            onClick={() => setAmount(String(Number(customer.balance)))}
          >
            <CashIcon /> Paying it all ({formatMoney(customer.balance)})
          </Button>
        )}
      </Sheet>
    </PageScaffold>
  );
}
