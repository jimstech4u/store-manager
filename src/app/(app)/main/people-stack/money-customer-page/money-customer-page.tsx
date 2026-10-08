'use client';

import { useMemo } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { usePermission } from '@/hooks/usePermission';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useCustomerAccount, type HistoryEvent } from '@/lib/stacks/customer-account';
import { formatMoney } from '@/lib/format';
import styles from './money-customer-page.module.css';

/**
 * ONE CUSTOMER'S MONEY, and every move of it — the ledger Empties and Deposit already have.
 *
 * "We have too many buttons here. Can we adopt payment and charge as a ledger, just like empties and
 * deposit, that have a button to record what was returned, or more of it." The account kept a card
 * for every kind of money record (a payment, a charge, money we owe them, money handed back, the
 * statement); it keeps one — Money — and the records live here, beside the history they add to.
 *
 * Read from the account's own cached figures (`useCustomerAccount`), so this opens on the balance
 * the account was showing, and a record made on a page pushed over this one is read again on the
 * way back.
 */
const MONEY_KINDS = new Set<HistoryEvent['kind']>(['sale', 'payment', 'refund', 'charge', 'excess', 'opening']);

export default function MoneyCustomerPage() {
  const { canOpen } = usePermission();
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const customerId = (location?.params?.id as string | undefined) ?? null;

  const { account, history, error, reload } = useCustomerAccount(customerId);
  useLiveRefresh(nav, () => reload());

  const owed = Number(account?.balance ?? 0);
  const moves = useMemo(() => history.filter((h) => MONEY_KINDS.has(h.kind)), [history]);

  const status: PageStatus = account
    ? { state: 'ready' }
    : error
      ? { state: 'error', what: 'their money', error: String(error), onRetry: reload }
      : { state: 'loading', what: 'their money' };

  const record = (kind: 'payment' | 'charge' | 'excess' | 'refund') =>
    void nav.push('account_action_page', { id: customerId, kind });

  return (
    <PageScaffold
      onBack={goBack}
      title="Money"
      subtitle="What they owe you, what you owe them, and every move of it"
    >
      <PageState status={status}>
        {() => (
          <>
            <div className={styles.headline}>
              <span className={styles.headlineLabel}>
                {owed > 0.005 ? 'They owe you' : owed < -0.005 ? 'You owe them' : 'Nothing owed either way'}
              </span>
              <span className={`${styles.headlineValue} ${owed < -0.005 ? styles.weOwe : ''}`}>
                {formatMoney(Math.abs(owed))}
              </span>
            </div>

            {/*
              ONE BUTTON FOR EACH KIND OF RECORD, each pushing the form that makes it — the same
              forms the account's cards opened. Money going back to them is only offered while the
              shop owes them some, as Deposit only offers "give some back" while it holds some.
            */}
            {canOpen('account_action_page') && (
              <div className={styles.actions}>
                <Button fullWidth onClick={() => record('payment')}>
                  Record a payment
                </Button>
                <Button fullWidth variant="secondary" onClick={() => record('charge')}>
                  Record a charge
                </Button>
                <Button fullWidth disabled={!(owed < -0.005)} onClick={() => record('refund')}>
                  Return money to them
                </Button>
                <Button fullWidth variant="secondary" onClick={() => record('excess')}>
                  Record what you owe them
                </Button>
              </div>
            )}


            <h2 className={styles.section}>Every move of it</h2>
            {moves.length === 0 ? (
              <InfoPanel tone="info" title="Nothing recorded yet">
                Sales, payments and charges on this account will be listed here.
              </InfoPanel>
            ) : (
              <ul className={styles.ledger}>
                {moves.map((m, i) => {
                  // What lowers what they owe reads as in; what raises it, as out.
                  const lowers = m.kind === 'payment' || m.kind === 'excess';
                  const raises = m.kind === 'sale' || m.kind === 'charge' || m.kind === 'opening';
                  return (
                    <li key={`${m.ref_table}-${m.ref_id}-${i}`} className={styles.move}>
                      <span
                        className={`${styles.dot} ${lowers ? styles.lowers : raises ? styles.raises : styles.back}`}
                        aria-hidden="true"
                      />
                      <span className={styles.moveBody}>
                        <span className={styles.moveWhat}>{m.label}</span>
                        {m.detail ? <span className={styles.moveWhy}>{m.detail}</span> : null}
                        <span className={styles.moveWhy}>
                          {/* A person, not an email: the part before the @, as stock history says it. */}
                          {new Date(m.occurred_at).toLocaleString()} · {m.actor.split('@')[0]}
                        </span>
                        {m.ref_table === 'sales' && m.ref_id && (
                          <button
                            type="button"
                            className={styles.open}
                            onClick={() => void nav.push('receipt_page', { id: m.ref_id })}
                          >
                            See the receipt
                          </button>
                        )}
                        {m.ref_table === 'payments' && m.ref_id && (
                          <button
                            type="button"
                            className={styles.open}
                            onClick={() =>
                              void nav.push('payment_done_page', { id: m.ref_id as string, from: 'history' })
                            }
                          >
                            See the payment
                          </button>
                        )}
                      </span>
                      <span className={`${styles.moveAmount} ${lowers ? styles.in : raises ? styles.out : ''}`}>
                        {m.amount !== null ? formatMoney(Math.abs(Number(m.amount))) : ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* THEIR STATEMENT — the statement page: a period, what goes on it, printed or sent (0255). */}
            {account && (
              <Button
                variant="secondary"
                fullWidth
                onClick={() => void nav.push('account_statement_page', { id: customerId })}
              >
                Print or send their statement
              </Button>
            )}
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
