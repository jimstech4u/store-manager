'use client';

import { useState } from 'react';

import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { CashIcon, HistoryIcon, RefreshIcon, ReturnIcon, TrashIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import {
  accountsChanged,
  type EmptiesPool,
  useCustomerAccount,
  useEmptiesPools,
} from '@/lib/stacks/customer-account';
import { formatMoney, formatQty, messageOf } from '@/lib/format';
import { getSupabase } from '@/lib/supabase/client';
import { useListNotifier } from '@/hooks/useListChannel';
import styles from './account-page.module.css';

/**
 * Everything one customer owes, holds, and has done — on one page.
 *
 * Three obligations, shown apart and never added together:
 *
 *   MONEY   what they owe for goods and charges, less what they have paid
 *   EMPTIES containers still out, per fungible pool
 *   HELD    money the shop is sitting on, which it owes back
 *
 * They are separate because they settle separately. Cash clears money. Crates clear empties. A
 * refund clears what is held. A single "balance" that mixed them would be a number nobody could
 * act on, and the whole reason a shop keeps these records is to be able to act on them.
 *
 * Everything below the balances is a timeline, because a figure with no events behind it cannot
 * be argued with — and every one of these figures eventually is, months later, across a counter,
 * by someone who remembers it differently.
 */

export default function AccountPage() {
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const { can } = usePermission();

  const customerId = (location?.params?.id as string | undefined) ?? null;
  const { account, history, loading, error, reload } = useCustomerAccount(customerId);
  const pools = useEmptiesPools(store?.id ?? null);

  const nav = useNav();

  /*
   * Taking somebody off the list.
   *
   * `useProblem` returns a fresh object every render, so `show` is bound to a local const — the
   * hook itself is never a safe dependency and a memo over it quietly does nothing.
   */
  const removeDialog = useConfirm();
  const removeProblem = useProblem();
  const showRemoveProblem = removeProblem.show;
  const [removing, setRemoving] = useState(false);

  // Told which customer went, so the People list loses them without being re-read.
  const notifyCustomers = useListNotifier('customers');
  // Same staleness problem as the statement page, same answer — see the hook for why a single
  // lifecycle signal was not enough.
  /*
   * Re-read on the way back in. NOTHING is dropped on the way out.
   *
   * This used to clear ACCOUNT_SCOPE on exit — and the People list and the customer picker both
   * live in that scope, so opening somebody's account and pressing Back deleted the list of
   * everybody.
   */
  useLiveRefresh(nav, reload);


  if (!store) return null;
  if (!customerId) {
    return (
      <PageScaffold onBack={goBack} title="No customer chosen">
        <InfoPanel tone="info" title="Open a customer from the People list">
          This page shows one customer&apos;s account.
        </InfoPanel>
      </PageScaffold>
    );
  }

  if (loading && !account) return <FullPageMessage title="Loading the account" tone="loading" />;

  if (error && !account) {
    return (
      <FullPageMessage
        title="Could not load this account"
        tone="error"
        action={<Button fullWidth onClick={() => void reload()}>Try again</Button>}
      >
        {error}
      </FullPageMessage>
    );
  }
  if (!account) return null;

  const owed = Number(account.balance);
  const heldTotal = account.deposits_held.reduce((s, d) => s + Number(d.amount), 0);

  const poolName = (id: string | null) =>
    pools.find((p: EmptiesPool) => p.id === id)?.name ?? account.empties.find((e) => e.category_id === id)?.category ?? '';

  const owes = Number(account.balance) !== 0;

  return (
    <PageScaffold
      onBack={goBack}
      title={account.customer.name}
      subtitle={account.customer.phone}
      actions={[
        {
          key: 'refresh',
          icon: <RefreshIcon />,
          onClick: () => void reload(),
          ariaLabel: 'Check for changes',
        },
        /*
          TAKING SOMEBODY OFF THE LIST.

          `archive_customer` has existed since the customer work and nothing has ever called it, so
          a duplicate or a typo stays in the People list and in every picker for ever and the shop's
          answer is to scroll past it.

          Behind the permission that owns customers, because it takes somebody out of everybody
          else's picker too.
        */
        ...(can('customers.manage')
          ? [
              {
                key: 'archive',
                icon: <TrashIcon />,
                onClick: () => setRemoving(true),
                ariaLabel: `Stop showing ${account.customer.name}`,
              },
            ]
          : []),
      ]}
    >
      <ProblemDialog problem={removeProblem} title="Not removed" />

      {/*
        Mounted only while the question is being asked — the dialog package leaves its overlay in
        the page after closing, and that overlay swallows taps meant for what is behind it.
      */}
      {removing && (
        <ConfirmDialog
          controller={removeDialog}
          title={`Stop showing ${account.customer.name}?`}
          message={
            owes
              ? `They still have ${formatMoney(account.balance)} running with you. Taking them off ` +
                `the list does not clear it — the history stays and the money is still owed.`
              : 'They come off the People list and out of the pickers. Everything they have already ' +
                'bought stays exactly where it is.'
          }
          confirmText={owes ? 'Take them off anyway' : 'Take them off'}
          tone="danger"
          onDismiss={() => setRemoving(false)}
          onConfirm={() => {
            void (async () => {
              try {
                /*
                  `p_force` because the server refuses somebody with a balance unless it is asked
                  twice — a customer who owes you money is not one to lose track of. The screen has
                  just said so in as many words, so the second asking is honest.
                */
                const { error: err } = await getSupabase().rpc('archive_customer', {
                  p_customer_id: account.customer.id,
                  p_force: owes,
                });
                if (err) throw err;
                notifyCustomers({ type: 'remove', id: account.customer.id });
                accountsChanged();
                await nav.pop();
              } catch (e) {
                showRemoveProblem(messageOf(e, 'That customer could not be taken off the list.'));
              } finally {
                setRemoving(false);
              }
            })();
          }}
        />
      )}

      <Explain label="How to read this page">
        This customer has up to three separate things running with you, and they are kept apart on
        purpose.
        <br />
        <br />
        <strong>Money</strong> is what they owe for goods and charges, less what they have paid.
        <br />
        <strong>Empties</strong> are containers still with them — crates, bottles, kegs — counted
        per pool, because any Nigerian Breweries crate settles any other.
        <br />
        <strong>Held</strong> is money you are sitting on because they paid instead of bringing
        something back. You owe that back, or you keep part of it for breakage and record why.
        <br />
        <br />
        Nothing here is ever edited. Every change adds a line to the history below with the time
        and who did it.
      </Explain>

      {/* ── The three positions ─────────────────────────────────────────────── */}

      <div className={styles.cards}>
        <div className={`${styles.card} ${owed > 0 ? styles.cardOwing : ''}`}>
          <p className={styles.cardLabel}>{owed < 0 ? 'You owe them' : 'They owe you'}</p>
          <p className={styles.cardValue}>{formatMoney(Math.abs(owed))}</p>
          <p className={styles.cardNote}>
            {formatMoney(account.money.goods)} goods
            {account.charges.length > 0 &&
              ` · ${account.charges.map((c) => `${c.label} ${formatMoney(c.amount)}`).join(' · ')}`}
            {' · '}
            {formatMoney(account.money.paid)} paid
          </p>
        </div>

        {heldTotal !== 0 && (
          <div className={styles.card}>
            <p className={styles.cardLabel}>You are holding their money</p>
            <p className={styles.cardValue}>{formatMoney(heldTotal)}</p>
            <p className={styles.cardNote}>
              {account.deposits_held
                .map((d) => `${formatQty(d.qty)} ${d.category}`)
                .join(' · ')}
              {' — refund it when they bring them back'}
            </p>
          </div>
        )}
      </div>

      {/* ── Empties, per pool ───────────────────────────────────────────────── */}

      <h2 className={styles.section}>Empties still out</h2>
      {account.empties.length === 0 ? (
        <p className={styles.sectionNote}>Nothing of yours is with this customer.</p>
      ) : (
        <ul className={styles.list}>
          {account.empties.map((e) => {
            /*
             * Split the pool into what is out on trust and what is covered by a deposit.
             *
             * They settle completely differently — one comes back or is written off, the other
             * comes back or the money is kept — so a single count is a number the seller cannot
             * act on. The first version showed "13" for three crates lent on trust plus ten paid
             * for, with a note implying the deposit covered all thirteen.
             */
            const held = account.deposits_held.find((d) => d.category_id === e.category_id);
            const onDeposit = Number(held?.qty ?? 0);
            const onTrust = Number(e.qty) - onDeposit;
            return (
              <li key={e.category_id} className={styles.row}>
                <div className={styles.rowMain}>
                  <p className={styles.rowName}>{e.category}</p>
                  <p className={styles.rowNote}>
                    {onTrust > 0 && `${formatQty(onTrust)} out on trust`}
                    {onTrust > 0 && onDeposit > 0 && ' · '}
                    {onDeposit > 0 &&
                      `${formatQty(onDeposit)} covered by ${formatMoney(held?.amount ?? 0)} deposit`}
                    {onTrust <= 0 && onDeposit <= 0 && 'Nothing outstanding'}
                  </p>
                </div>
                <span className={styles.rowQty}>{formatQty(e.qty)}</span>
              </li>
            );
          })}
        </ul>
      )}

      {/* ── Actions ─────────────────────────────────────────────────────────── */}

      {/*
        FIVE THINGS A SHOP DOES ON AN ACCOUNT, and each is one kind of record.

        The old set was six buttons across three different models pretending to be one. "They
        brought empties back", "Take a deposit instead", "Give a deposit back" and "Keep some for
        breakage" all wrote to a ledger that recorded a QUANTITY OF CONTAINERS at a rate — so a
        return moved money and a deposit had to be expressed in crates. "Enter what they already
        owed" was an opening balance masquerading as an action anybody might take on a Tuesday.

        What is left says what each is:

          MONEY THEY OWE     a payment reduces it, a charge adds to it.
          MONEY WE OWE       an excess — an overpayment, a load brought back.
          MONEY WE HOLD      a deposit. Not theirs to spend and not ours to count as takings.
          CONTAINERS         counted in the product's own shape, settled on their own screen.

        The last two are deep screens rather than a single action, because both are ledgers with a
        history somebody needs to read before deciding anything.
      */}
      <div className={styles.actions}>
        {can('payments.record') && (
          <Button
            size="large"
            fullWidth
            onClick={() =>
              void nav.push('account_action_page', { id: customerId, kind: 'payment' })
            }
          >
            <CashIcon /> Record a payment
          </Button>
        )}

        {can('payments.record') && (
          <Button
            variant="secondary"
            fullWidth
            onClick={() =>
              void nav.push('account_action_page', { id: customerId, kind: 'charge' })
            }
          >
            Record a charge
          </Button>
        )}

        {can('payments.record') && (
          <Button
            variant="secondary"
            fullWidth
            onClick={() =>
              void nav.push('account_action_page', { id: customerId, kind: 'excess' })
            }
          >
            Record what you owe them
          </Button>
        )}

        {/*
          Both of these PUSH ONTO A LEDGER SCREEN rather than opening a one-shot form. A deposit and
          a pile of crates are running accounts: what matters first is what is there and how it got
          that way, and only then what to do about it.
        */}
        <Button
          variant="secondary"
          fullWidth
          onClick={() => void nav.push('empties_customer_page', { id: customerId })}
        >
          <ReturnIcon /> Empties
        </Button>

        <Button
          variant="secondary"
          fullWidth
          onClick={() => void nav.push('deposit_customer_page', { id: customerId })}
        >
          Deposit
        </Button>
      </div>

      {/* ── History ─────────────────────────────────────────────────────────── */}

      <h2 className={styles.section}>
        <HistoryIcon size="1em" /> Everything that has happened
      </h2>
      {history.length === 0 ? (
        <p className={styles.sectionNote}>Nothing recorded yet.</p>
      ) : (
        <ol className={styles.timeline}>
          {history.map((h, i) => (
            <li key={`${h.ref_table}-${h.ref_id}-${i}`} className={styles.event}>
              <div className={styles.eventHead}>
                <span className={styles.eventLabel}>{h.label}</span>
                <span
                  className={`${styles.eventAmount} ${
                    h.kind === 'payment' ? styles.in : h.kind === 'sale' ? styles.out : ''
                  }`}
                >
                  {h.amount !== null && Number(h.amount) !== 0
                    ? formatMoney(Math.abs(Number(h.amount)))
                    : h.qty_units !== null
                      ? `${formatQty(Math.abs(Number(h.qty_units)))}`
                      : ''}
                </span>
              </div>
              <p className={styles.eventMeta}>
                {new Date(h.occurred_at).toLocaleString()}
                {h.detail ? ` · ${h.detail}` : ''}
                {h.qty_units !== null && h.amount !== null && Number(h.amount) !== 0
                  ? ` · ${formatQty(Math.abs(Number(h.qty_units)))} ${poolName(h.category_id)}`
                  : ''}
                {` · ${h.actor}`}
              </p>

              {/*
                The receipt behind the line.

                `customer_history` has returned `ref_table` and `ref_id` all along and the screen
                used them only to build a React key. "Owes ₦21,500" and then no way to see what
                for is the point at which somebody rings the shop — the answer is one join away.
              */}
              {h.ref_table === 'sales' && h.ref_id && (
                <button
                  type="button"
                  className={styles.eventOpen}
                  onClick={() => void nav.push('receipt_page', { id: h.ref_id })}
                >
                  See the receipt
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

    </PageScaffold>
  );
}
