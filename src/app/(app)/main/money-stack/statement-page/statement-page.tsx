'use client';

import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { InfoPanel } from '@/components/ui/Explain';
import { usePermission } from '@/hooks/usePermission';
import { CashIcon, ChevronRightIcon, PeopleIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { ACCOUNT_DERIVED_SCOPE, type HistoryEvent } from '@/lib/stacks/customer-account';
import { useCustomerFromList } from '@/lib/stacks/customer-directory';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';
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
  /*
   * A RESOURCE (0 is an answer; "not read yet" is not).
   *
   * This started as `{ rows: [] }`, so before the first answer the page drew "They owe you ₦0" and
   * an empty timeline — no receipts, no payments, no deposit — exactly the confident wrong number
   * the note above warns about. Its `load` was also handed to the refresh on resume and to Try
   * again, and neither re-read: the demand was already spent. And a failed read replaced what was
   * on screen with nothing. Now: loading until read, kept through a failed refresh, and re-read
   * whenever a sale or a payment invalidates the account figures.
   *
   * New key (`statement:v2`): the old cached value could be a failure record with no rows.
   */
  const statement = useResource<{
    rows: StatementRow[];
    history: HistoryEvent[];
    balance: number | null;
    /** From this page's own read — the fallback when no list has published these customers. */
    name: string | null;
  }>({
    key: `statement:v2:${customerId ?? 'none'}`,
    scope: ACCOUNT_DERIVED_SCOPE,
    enabled: Boolean(customerId),
    read: async () => {
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
      return {
        rows: (sales.data ?? []) as StatementRow[],
        // A history failure must not blank the receipts: those are the part a customer is
        // standing there asking for.
        history: events.error ? [] : ((events.data ?? []) as HistoryEvent[]),
        balance: account.error
          ? null
          : Number((account.data as { balance: string } | null)?.balance ?? 0),
        name: account.error
          ? null
          : ((account.data as { customer?: { name?: string } } | null)?.customer?.name ?? null),
      };
    },
  });

  const rows = statement.data?.rows ?? [];
  const history = statement.data?.history ?? [];
  const balance = statement.data?.balance ?? null;

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
  const name = fromList?.display_name ?? statement.data?.name ?? 'Customer';

  // Another till's payment arrives on the next look; `reload` actually reads.
  useLiveRefresh(nav, statement.reload);

  if (!store || !customerId) return null;

  /*
   * ONE HEADER; the body waits for their receipts, or says it could not read them.
   */
  const status: PageStatus = statement.loaded
    ? { state: 'ready' }
    : statement.error
      ? { state: 'error', what: 'this statement', error: statement.error, onRetry: statement.reload }
      : { state: 'loading', what: 'their statement' };

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
      /*
       * Gated on the REAL balance, not on the receipts' share of it.
       *
       * `owed` totals the unpaid amounts on the receipts below, and a customer can owe a great deal
       * with no receipts at all — an opening balance, a charge, a deposit. One of them owed
       * ₦600,000 and this page offered no way to record a payment against it, because the receipts
       * summed to zero. The balance card two lines down already draws this distinction; the action
       * had not been told.
       */
      actions={[
        // UP TO THE RECORD THIS BELONGS TO: the customer, with their empties and deposit.
        ...(customerId
          ? [
              {
                key: 'account',
                icon: <PeopleIcon />,
                onClick: () => void nav.push('account_page', { id: customerId }),
                ariaLabel: 'Their account',
              },
            ]
          : []),
        ...(can('payments.record') && Math.abs(balance ?? owed) > 0
          ? [
              {
                key: 'pay',
                icon: <CashIcon />,
                onClick: () =>
                  void nav.push('account_action_page', { id: customerId, kind: 'payment' }),
                ariaLabel: 'Record a payment',
              },
            ]
          : []),
      ]}
    >
      <PageState status={status}>
        {() => (
          <>
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
              .map((h, i) => {
                const said = (
                  <>
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
                  </>
                );
                return (
                <li key={`${h.ref_table}-${h.ref_id}-${i}`}>
                  {/* A deposit line opens the deposit it moved; anything else has no page of its own. */}
                  {h.kind.startsWith('deposit') || h.kind === 'forfeit' ? (
                    <button
                      type="button"
                      className={`${styles.row} ${styles.rowLink}`}
                      onClick={() => void nav.push('deposit_customer_page', { id: customerId })}
                    >
                      {said}
                      <ChevronRightIcon />
                    </button>
                  ) : (
                    <div className={styles.row}>
                      {said}
                    </div>
                  )}
                </li>
                );
              })}
          </ul>
        </>
      )}
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
