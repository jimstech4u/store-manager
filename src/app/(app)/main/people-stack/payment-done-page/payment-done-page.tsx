'use client';

import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { ShareIcon } from '@/components/ui/Icon';
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
  const [note, setNote] = useState<string | null>(null);

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
        supabase.from('store_customers').select('display_name').eq('id', row.store_customer_id).maybeSingle(),
        supabase.rpc('customer_balance', { p_store_customer_id: row.store_customer_id }),
      ]);
      return {
        customerId: row.store_customer_id,
        customerName: (who as { display_name: string } | null)?.display_name ?? 'Customer',
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
  const standing = (b: number | null) =>
    b === null
      ? 'Could not read their balance just now.'
      : b > 0.005
        ? `Still owes ${formatMoney(b)}`
        : b < -0.005
          ? `In credit ${formatMoney(-b)} — the shop owes them`
          : 'Paid up — nothing owing';

  const words = d
    ? `${store.name}: ${gave ? 'we gave' : 'received from'} ${d.customerName} ${formatMoney(d.amount)} ` +
      `(${d.method}) on ${formatDateTime(d.at)}. ${standing(d.balance)}.`
    : '';

  return (
    <PageScaffold onBack={goBack} title={gave ? 'Money given back' : 'Payment recorded'} subtitle={store.name}>
      <PageState status={status}>
        {() =>
          d && (
            <>
              <div className={styles.card}>
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

              {note && (
                <p className={styles.note} role="status">
                  {note}
                </p>
              )}

              <div className={styles.actions}>
                <Button fullWidth onClick={() => void nav.pop()}>
                  Done
                </Button>
                <Button
                  variant="secondary"
                  fullWidth
                  onClick={async () => {
                    setNote(null);
                    // Text, not a link: the phone's own share sheet, or the clipboard where there is none.
                    try {
                      if (typeof navigator.share === 'function') {
                        await navigator.share({ title: gave ? 'Money given back' : 'Payment received', text: words });
                        return;
                      }
                      await navigator.clipboard.writeText(words);
                      setNote('Copied. Paste it into a chat.');
                    } catch {
                      // A cancelled share sheet is not a failure.
                    }
                  }}
                >
                  <ShareIcon /> Share
                </Button>
              </div>
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
