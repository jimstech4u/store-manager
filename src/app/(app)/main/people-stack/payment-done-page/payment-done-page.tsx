'use client';

import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { DocumentActions } from '@/components/ui/DocumentActions';
import type { ReceiptImageInput } from '@/lib/share';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useResource } from '@/lib/stacks/resource';
import { ACCOUNT_DERIVED_SCOPE } from '@/lib/stacks/customer-account';
import { getSupabase } from '@/lib/supabase/client';
import { formatDateTime, formatMoney } from '@/lib/format';
import styles from './payment-done-page.module.css';

interface Done {
  customerId: string;
  customerName: string;
  phone: string | null;
  amount: number;
  method: string;
  reference: string | null;
  direction: 'in' | 'out';
  at: string;
  /** What the account stands at now. Null when it could not be read — never a made-up 0. */
  balance: number | null;
}

/**
 * THE PAYMENT, CONFIRMED — who, how much, how, when, and where the account stands now.
 *
 * "after recording a payment we could push a confirmation page with customer name, amount paid, time
 * and balance if there is, so we have a professional store manager."
 *
 * It replaces the form it confirms (`swapTo`), so Back from here is the account, never a form for a
 * payment already recorded. Read by the payment's id from the database: it opens the same after a
 * reload, and says what the shop recorded rather than what was typed.
 */
export default function PaymentDonePage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const paymentId = (location?.params?.id as string | undefined) ?? null;
  /*
   * OPENED FROM HISTORY, it is a receipt to send again — not a confirmation of something just done.
   * The balance is today's, so it is said as "now", never as though it were the balance on the day.
   */
  const fromHistory = location?.params?.from === 'history';

  const r = useResource<Done>({
    key: `payment-done:${paymentId ?? 'none'}`,
    scope: ACCOUNT_DERIVED_SCOPE,
    enabled: Boolean(paymentId),
    read: async () => {
      const supabase = getSupabase();
      const { data: pay, error } = await supabase
        .from('payments')
        .select('amount, method, reference, direction, occurred_at, store_customer_id')
        .eq('id', paymentId)
        .maybeSingle();
      if (error) throw error;
      if (!pay) throw new Error('That payment could not be found.');
      const row = pay as {
        amount: string;
        method: string;
        reference: string | null;
        direction: 'in' | 'out';
        occurred_at: string;
        store_customer_id: string;
      };
      const [{ data: who }, { data: bal, error: balErr }] = await Promise.all([
        supabase
          .from('store_customers')
          .select('display_name, identities(phone)')
          .eq('id', row.store_customer_id)
          .maybeSingle(),
        /*
         * THE WHOLE ACCOUNT — `customer_balance_total`, the figure the statement heads with ("They
         * owe you"). `customer_balance` is only the unpaid receipts, and it put ₦28,800 on a receipt
         * for an account that owed ₦52,250 once its opening balance and charges were counted.
         */
        supabase.rpc('customer_balance_total', { p_store_customer_id: row.store_customer_id }),
      ]);
      return {
        customerId: row.store_customer_id,
        customerName: (who as { display_name: string } | null)?.display_name ?? 'Customer',
        phone:
          ((who as { identities?: { phone?: string } | { phone?: string }[] } | null)?.identities as
            | { phone?: string }
            | undefined)?.phone ?? null,
        amount: Number(row.amount) || 0,
        method: row.method,
        reference: row.reference,
        direction: row.direction,
        at: row.occurred_at,
        balance: balErr || bal === null || bal === undefined ? null : Number(bal),
      };
    },
  });

  if (!store) return null;

  const status: PageStatus = !paymentId
    ? { state: 'empty', title: 'No payment chosen', body: 'This page opens after a payment is recorded.' }
    : r.data
      ? { state: 'ready' }
      : r.error
        ? { state: 'error', what: 'the payment', error: r.error, onRetry: r.reload }
        : { state: 'loading', what: 'the payment' };

  const d = r.data;
  const gave = d?.direction === 'out';
  const now = fromHistory ? ' now' : '';
  const standing = (b: number | null) =>
    b === null
      ? 'Could not read their balance just now.'
      : b > 0.005
        ? `Owes${now} ${formatMoney(b)}`
        : b < -0.005
          ? `In credit${now} ${formatMoney(-b)} — the shop owes them`
          : `Paid up${now} — nothing owing`;

  const words = d
    ? `${store.name}: ${gave ? 'we gave' : 'received from'} ${d.customerName} ${formatMoney(d.amount)} ` +
      `(${d.method}) on ${formatDateTime(d.at)}. ${standing(d.balance)}.`
    : '';

  /*
   * THE SAME PAYMENT AS A SLIP — for the picture, the PDF and the roll printer, exactly as a sale's
   * receipt goes out. Built from what the shop recorded, never from what was typed.
   */
  const slip: ReceiptImageInput | null = d
    ? {
        shopName: store.name,
        banner: gave ? 'MONEY GIVEN BACK' : 'PAYMENT RECEIPT',
        meta: [formatDateTime(d.at), d.customerName, `#${(paymentId ?? '').slice(0, 8).toUpperCase()}`],
        lines: [
          {
            name: gave ? 'Given back' : 'Payment received',
            detail: `by ${d.method}${d.reference ? ` · ${d.reference}` : ''}`,
            qty: `by ${d.method}`,
            amount: formatMoney(d.amount),
          },
        ],
        totals: [
          { label: gave ? 'Given back' : 'Paid', value: formatMoney(d.amount), strong: true },
          ...(d.balance === null
            ? []
            : [
                {
                  label:
                    d.balance > 0.005
                      ? `Still owes${now}`
                      : d.balance < -0.005
                        ? `In credit${now}`
                        : `Balance${now}`,
                  value: formatMoney(Math.abs(d.balance)),
                  strong: true,
                },
              ]),
        ],
      }
    : null;

  return (
    <PageScaffold
      onBack={goBack}
      title={fromHistory ? (gave ? 'Money given back' : 'Payment receipt') : gave ? 'Money given back' : 'Payment recorded'}
      subtitle={store.name}
    >
      <PageState status={status}>
        {() =>
          d && (
            <>
              {/* What the browser prints, when the shop prints to a page printer. */}
              <div className={styles.card} data-print-root>
                <p className={styles.tick} aria-hidden="true">
                  ✓
                </p>
                <p className={styles.who}>{d.customerName}</p>
                <p className={styles.amount}>{formatMoney(d.amount)}</p>
                <p className={styles.how}>
                  {gave ? 'Given back' : 'Paid'} by {d.method}
                  {d.reference ? ` · ${d.reference}` : ''}
                </p>
                <p className={styles.when}>{formatDateTime(d.at)}</p>
                <p
                  className={`${styles.balance} ${
                    d.balance !== null && d.balance > 0.005 ? styles.owes : styles.clear
                  }`}
                >
                  {standing(d.balance)}
                </p>
              </div>

              {/*
                EVERYTHING A RECEIPT CAN DO: share, WhatsApp, a picture, print, PDF — the same five,
                in the same order, as a sale's receipt.
              */}
              {slip && (
                <DocumentActions
                  storeId={store.id}
                  doc={slip}
                  filename={`payment-${d.customerName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${d.at.slice(0, 10)}`}
                  title={gave ? 'Money given back' : 'Payment receipt'}
                  message={words}
                  whatsapp={{ phone: d.phone, customerId: d.customerId, customerName: d.customerName }}
                />
              )}

              <div className={styles.actions}>
                <Button variant="secondary" fullWidth onClick={() => void nav.pop()}>
                  {fromHistory ? 'Back' : 'Done'}
                </Button>
              </div>
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
