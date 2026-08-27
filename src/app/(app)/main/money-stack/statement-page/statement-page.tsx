'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { useDemandState } from '@academix-admin/state-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { InfoPanel } from '@/components/ui/Explain';
import { usePermission } from '@/hooks/usePermission';
import { CashIcon, ChevronRightIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { accountsChanged, type HistoryEvent } from '@/lib/stacks/customer-account';
import { useCustomerFromList } from '@/lib/stacks/customer-directory';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import styles from '../money-page/money-page.module.css';

/**
 * What makes up one customer's balance — every receipt behind it, each opening its own page.
 *
 * This was a dialog, and a dialog is the wrong shape for it. A balance is made of receipts, a
 * receipt is made of lines, and a customer may have dozens: a dialog gives one level of depth and
 * then has to stack a second dialog over itself to go further, with no back button and nothing to
 * return to. As a page it gets a back button and room, and tapping a receipt pushes the receipt
 * rather than layering over what is already open.
 */

interface StatementRow {
  sale_id: string;
  occurred_at: string;
  total: string;
  paid: string;
  outstanding: string;
  line_count: number;
}

export default function StatementPage() {
  const goBack = useStackBack();
  const nav = useNav();
  const location = useLocation();
  const { store } = useAuth();

  const customerId = (location?.params?.id as string | undefined) ?? null;

  const { can } = usePermission();

  /*
   * Everything this page shows lives in state-stack, keyed by customer.
   *
   * A stack page unmounts when another is pushed on top of it. Held in `useState`, this page came
   * back EMPTY from a receipt: the balance flashed ₦0, the timeline flashed nothing, and both then
   * refilled a moment later. On a screen whose entire job is to state what someone owes, a
   * momentary ₦0 is not a loading state — it is a wrong number, shown confidently.
   *
   * `revalidateOnMount: false` because the loader below runs on mount anyway; leaving it true made
   * the demand fire twice on the same arrival.
   */
  const [snapshot, demand] = useDemandState<{
    rows: StatementRow[];
    history: HistoryEvent[];
    balance: number | null;
    /** From this page's own read — the fallback when no list has published these customers. */
    name: string | null;
    error: string | null;
    settled: boolean;
  }>(
    { rows: [], history: [], balance: null, name: null, error: null, settled: false },
    {
      key: `statement:${customerId ?? 'none'}`,
      scope: 'money_flow',
      persist: true,
      deps: [customerId ?? ''],
      ttl: 30_000,
      revalidateOnMount: false,
    },
  );

  const rows = snapshot.rows;
  const history = snapshot.history;
  const balance = snapshot.balance;
  const error = snapshot.error;

  /*
   * The customer's name — from the list that has them, then from this page's own read.
   *
   * It used to arrive in the URL beside the id. That made the page title a string anybody could
   * type, and it meant a rename showed the old name until the link was rebuilt. Now the id is the
   * only thing that travels: `useCustomerFromList` covers the ordinary case where the Money or
   * People list published these rows a moment ago, and `customer_account` covers the cold start,
   * the deep link and the hard refresh, where nothing has published anything at all.
   */
  const fromList = useCustomerFromList(customerId);
  const name = fromList?.display_name ?? snapshot.name ?? 'Customer';

  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!customerId) return;
    demand(async ({ set }) => {
      try {
        const supabase = getSupabase();
        /*
         * Receipts AND everything else that moved the balance.
         *
         * `customer_statement` returns sales only, so this page — headed "What makes up this
         * balance" — showed "nothing has been sold" for anyone whose balance came from an opening
         * figure or a deposit. `customer_history` already unions the rest.
         */
        const [sales, events, account] = await Promise.all([
          supabase.rpc('customer_statement', { p_store_customer_id: customerId }),
          supabase.rpc('customer_history', { p_store_customer_id: customerId, p_limit: 100 }),
          supabase.rpc('customer_account', { p_store_customer_id: customerId }),
        ]);
        if (sales.error) throw sales.error;
        set(
          {
            rows: (sales.data ?? []) as StatementRow[],
            // A history failure must not blank the receipts: those are the part a customer is
            // standing there asking for.
            history: events.error ? [] : ((events.data ?? []) as HistoryEvent[]),
            balance: account.error
              ? null
              : Number(
                  (account.data as { balance: string } | null)?.balance ?? 0,
                ),
            name: account.error
              ? null
              : ((account.data as { customer?: { name?: string } } | null)?.customer?.name ??
                null),
            error: null,
            settled: true,
          },
          { override: true },
        );
      } catch (e) {
        set(
          {
            rows: [],
            history: [],
            balance: null,
            name: null,
            error: e instanceof Error ? e.message : 'Could not load this statement.',
            settled: true,
          },
          { override: true },
        );
      }
    });
  }, [customerId, demand]);

  useEffect(() => {
    load();
  }, [load]);

  useLiveRefresh(nav, load);

  if (!store || !customerId) return null;

  if (error) {
    return (
      <FullPageMessage
        title="Could not load this statement"
        tone="error"
        action={
          <Button fullWidth onClick={() => void load()}>
            Try again
          </Button>
        }
      >
        {error}
      </FullPageMessage>
    );
  }

  if (rows === null) return <FullPageMessage title="Loading their receipts" tone="loading" />;

  const owed = rows.reduce((sum, r) => sum + Number(r.outstanding), 0);

  return (
    <PageScaffold
      onBack={goBack}
      title={name}
      subtitle="What makes up this balance"
      /*
       * Recording a payment is a header action, like every other page's primary action.
       *
       * It was a bar pinned to the foot of this page, which on a phone sat on top of the last few
       * entries in the very list it was explaining — the timeline that says what the balance is
       * made of. It still belongs on this screen rather than on the money list, because it settles
       * the figure shown here; it just does not need to cover it.
       */
      actions={
        can('payments.record') && owed > 0
          ? [
              {
                key: 'pay',
                icon: <CashIcon />,
                onClick: () => {
                  setPayError(null);
                  setAmount('');
                  setPaying(true);
                },
                ariaLabel: 'Record a payment',
              },
            ]
          : undefined
      }
    >
      {/*
        The customer's REAL balance, not the receipts' share of it.
        
        This card used to total the unpaid amounts on the receipts below. For anyone whose balance
        came from an opening figure or a charge that showed ₦0 while the card that led here said
        ₦400,000 — two screens, one customer, two different answers, and the one on this page was
        the wrong one. The receipts figure is still shown, as the component it is.
      */}
      <div className={styles.balanceCard}>
        <span className={styles.summaryLabel}>
          {balance !== null && balance < 0 ? 'You owe them' : 'They owe you'}
        </span>
        <span className={styles.summaryValue}>
          {formatMoney(Math.abs(balance ?? owed))}
        </span>
        {owed !== Math.abs(balance ?? owed) && (
          <span className={styles.summaryNote}>
            {owed > 0
              ? `${formatMoney(owed)} of it is unpaid on the receipts below`
              : 'None of it is against a receipt — see below for what it is'}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <InfoPanel tone="info" title="No receipts">
          Nothing has been sold to this customer through the app. If they owe money it came from
          an opening balance or a charge — those are listed below.
        </InfoPanel>
      ) : (
        <ul className={styles.list}>
          {rows.map((s) => (
            <li key={s.sale_id}>
              <button
                type="button"
                className={`${styles.row} ${styles.rowLink}`}
                onClick={() => void nav.push('receipt_page', { id: s.sale_id })}
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
      )}
      <BottomSheet
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
            onClick={async () => {
              setBusy(true);
              setPayError(null);
              try {
                const { error: e } = await getSupabase().rpc('record_payment', {
                  p_store_id: store.id,
                  p_customer_id: customerId,
                  p_amount: Number(amount),
                  p_method: method,
                  p_reference: null,
                  p_occurred_at: new Date().toISOString(),
                  p_client_uuid: crypto.randomUUID(),
                  p_bank_account_id: null,
                });
                if (e) throw e;
                // Same announcement every other write makes, so the lists and the account agree.
                accountsChanged();
                setPaying(false);
                await load();
              } catch (e) {
                setPayError(e instanceof Error ? e.message : 'Could not record this payment.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Record {amount ? formatMoney(amount) : 'payment'}
          </Button>
        }
      >
        {payError && (
          <InfoPanel tone="danger" title="Not recorded">
            {payError}
          </InfoPanel>
        )}

        <Field
          label="How much are they paying?"
          numeric
          prefix="₦"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          hint={`${formatMoney(owed)} is still owed across these receipts.`}
          autoFocus
        />

        <div className={styles.methods} role="group" aria-label="How the money came in">
          {(['cash', 'transfer', 'pos'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`${styles.method} ${method === m ? styles.methodActive : ''}`}
              aria-pressed={method === m}
              onClick={() => setMethod(m)}
            >
              {m === 'pos' ? 'Card / POS' : m === 'cash' ? 'Cash' : 'Transfer'}
            </button>
          ))}
        </div>
      </BottomSheet>

      {/*
        Everything else that moved this balance.

        Receipts alone cannot explain a figure that includes an opening balance, a payment on
        account, a deposit taken or a breakage kept — and this page's whole job is to explain the
        figure. Sales are shown above as receipts a customer can open; these are the rest.
      */}
      {history.filter((h) => h.kind !== 'sale').length > 0 && (
        <>
          <h2 className={styles.section}>Everything else on this account</h2>
          <ul className={styles.list}>
            {history
              .filter((h) => h.kind !== 'sale')
              .map((h, i) => (
                <li key={`${h.ref_table}-${h.ref_id}-${i}`} className={styles.row}>
                  <span className={styles.rowMain}>
                    <span className={styles.rowName}>{h.label}</span>
                    <span className={styles.rowMeta}>
                      {formatDateTime(h.occurred_at)}
                      {h.detail ? ` · ${h.detail}` : ''}
                      {` · ${h.actor}`}
                    </span>
                  </span>
                  <span className={styles.rowMoney}>
                    {h.amount !== null && Number(h.amount) !== 0
                      ? formatMoney(Math.abs(Number(h.amount)))
                      : ''}
                  </span>
                </li>
              ))}
          </ul>
        </>
      )}

    </PageScaffold>
  );
}
