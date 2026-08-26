'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { InfoPanel } from '@/components/ui/Explain';
import { usePermission } from '@/hooks/usePermission';
import { ChevronRightIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import type { HistoryEvent } from '@/lib/stacks/customer-account';
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
  const name = (location?.params?.name as string | undefined) ?? 'Customer';

  const { can } = usePermission();

  const [rows, setRows] = useState<StatementRow[] | null>(null);
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  /*
   * Receipts AND everything else that moved the balance.
   *
   * `customer_statement` returns sales only, so this page — headed "What makes up this balance" —
   * showed "Nothing has been sold to this customer" for anyone whose balance came from an opening
   * figure entered when the shop started using the app, or whose sales had all been paid off and
   * whose remaining balance was a deposit. A customer plainly owing money, with nothing on screen
   * to say why.
   *
   * `customer_history` already unions sales, payments, refunds, deposits taken and given back, and
   * breakages kept — the same timeline the account page shows. Both are read here: the receipts
   * are what a customer asks to see, and the rest is what explains the number.
   */
  const load = useCallback(async () => {
    if (!customerId) return;
    setError(null);
    const supabase = getSupabase();
    const [sales, events, account] = await Promise.all([
      supabase.rpc('customer_statement', { p_store_customer_id: customerId }),
      supabase.rpc('customer_history', { p_store_customer_id: customerId, p_limit: 100 }),
      supabase.rpc('customer_account', { p_store_customer_id: customerId }),
    ]);
    if (sales.error) {
      setError(sales.error.message);
      return;
    }
    setRows((sales.data ?? []) as StatementRow[]);
    // A history failure must not blank the receipts: the receipts are the part a customer is
    // standing there asking for.
    setHistory(events.error ? [] : ((events.data ?? []) as HistoryEvent[]));
    setBalance(
      account.error ? null : Number((account.data as { balance: string } | null)?.balance ?? 0),
    );
  }, [customerId]);

  useEffect(() => {
    void load();
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
      footer={
        // Recording a payment belongs with the balance it settles, which is this screen. It used
        // to sit in a dialog on the money list, one level away from the figure it changed.
        can('payments.record') && owed > 0 ? (
          <Button
            size="large"
            fullWidth
            onClick={() => {
              setPayError(null);
              setAmount('');
              setPaying(true);
            }}
          >
            Record a payment
          </Button>
        ) : undefined
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
