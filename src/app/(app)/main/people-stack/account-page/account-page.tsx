'use client';

import { useMemo, useState } from 'react';

import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Explain } from '@/components/ui/Explain';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { CashIcon, EditIcon, HistoryIcon, RefreshIcon, ReturnIcon, TrashIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import {
  accountsChanged,
  ledgerPageFor,
  useCustomerAccount,
} from '@/lib/stacks/customer-account';
import { formatMoney, formatQtySpoken, messageOf } from '@/lib/format';
import { rollUpOwed, type OwedRow } from '@/lib/empties-rollup';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { EmptiesBroughtBack } from '@/components/empties/EmptiesBroughtBack';
import { Qty } from '@/components/ui/Qty';
import { emptiesOwed, LEDGERS_SCOPE } from '@/lib/stacks/customer-ledgers';
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
  const { account, history, error, reload } = useCustomerAccount(customerId);

  /*
   * The containers, from the ledger rather than from the account summary: the summary reports a
   * quantity per shape with no side, and the two sides are separate obligations. Same key as the
   * empties screen, so opening either after the other costs nothing.
   */
  const owedArea = useLoadArea<OwedRow[]>(() => emptiesOwed(customerId as string), [customerId], {
    key: `empties-owed:${customerId ?? 'none'}`,
    scope: LEDGERS_SCOPE,
    whenNot: !customerId,
  });
  const rolled = useMemo(
    () => rollUpOwed((owedArea.data ?? []).filter((r) => r.owed > 0)),
    [owedArea.data],
  );
  const theyHold = useMemo(() => rolled.filter((l) => l.side === 'they_hold'), [rolled]);
  const weHold = useMemo(() => rolled.filter((l) => l.side === 'we_hold'), [rolled]);

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

  /*
   * ONE HEADER; the body waits for the account. Its figures are worked out only from an account
   * that has been read — never a ₦0 standing in for one that has not.
   */
  const status: PageStatus = !customerId
    ? {
        state: 'empty',
        title: 'Open a customer from the People list',
        body: 'This page shows one customer’s account.',
      }
    : account
    ? { state: 'ready' }
    : error
      ? { state: 'error', what: 'this account', error, onRetry: () => void reload() }
      : { state: 'loading', what: 'the account' };

  const owed = Number(account?.balance ?? 0);
  const heldTotal = Number(account?.deposits_held) || 0;

  const owes = owed !== 0;

  return (
    <PageScaffold
      onBack={goBack}
      title={account?.customer.name ?? 'Account'}
      subtitle={account?.customer.phone}
      actions={[
        {
          key: 'refresh',
          icon: <RefreshIcon />,
          onClick: () => void reload(),
          ariaLabel: 'Check for changes',
        },
        /*
          CHANGING WHAT THEY ARE CALLED.

          `update_customer` and `update_customer_phone` have both existed, permission-checked, for
          as long as the customers have — and no screen ever called either. So a name typed wrong
          at the counter stayed wrong, and the only way anybody found to change one was to add the
          customer again on the same number, which RENAMED the first (0203) and put two people's
          trade on one book.

          Beside the archive, behind the same permission, because it is the same kind of act: it
          changes what everybody else in the shop sees in every picker.
        */
        ...(account && can('customers.manage')
          ? [
              {
                key: 'edit',
                icon: <EditIcon />,
                onClick: () => void nav.push('customer_edit_page', { id: customerId }),
                ariaLabel: `Edit ${account.customer.name}`,
              },
            ]
          : []),
        /*
          TAKING SOMEBODY OFF THE LIST.

          `archive_customer` has existed since the customer work and nothing has ever called it, so
          a duplicate or a typo stays in the People list and in every picker for ever and the shop's
          answer is to scroll past it.

          Behind the permission that owns customers, because it takes somebody out of everybody
          else's picker too.
        */
        ...(account && can('customers.manage')
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
      <PageState status={status}>
        {() =>
          account && (
          <>
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
            {/*
              ONE FIGURE, not a breakdown by container. A deposit is a round sum agreed between two
              people; which crates it notionally covers is a question nobody at the counter asks.
            */}
            <p className={styles.cardNote}>Give it back, or keep it and say why</p>
          </div>
        )}
      </div>

      {/*
        EMPTIES, IN THE SHAPES THEY LEFT IN.

        This listed pools and split each into "out on trust" and "covered by a deposit" — the old
        model's confusion made visible. A deposit was a quantity of containers at a rate, so crates
        could be sorted into paid-for and not. They cannot: a deposit is a round sum against the
        customer, and a crate is a crate whether or not money sits against it. That is the whole
        reason the two are separate ledgers now.
      */}
      {/*
        WHICH WAY EACH OBLIGATION RUNS.

        `customer_account` reports a quantity per shape and not whose containers they are, so a
        customer holding 55 of our crates while we held 65 of theirs produced two rows that looked
        identical — same product, same shape — and React drew one of them. Read here from the same
        ledger the empties screen uses (`customer_empties_owed`), which carries the side.
      */}
      {/*
        EACH LINE SETTLES WHERE IT IS READ — all of it back after a confirm, or part of it on the
        empties page. "the account page could have the settle click in the line so we know that one
        is settled."
      */}
      {customerId && store && (
        <EmptiesBroughtBack storeId={store.id} customerId={customerId} title="Empties still out" />
      )}

      {weHold.length > 0 && (
        <>
          <h2 className={styles.section}>Theirs, in your yard</h2>
          <ul className={styles.list}>
            {weHold.map((l, i) => (
              <li key={`we-${l.label}-${l.unit}-${i}`} className={styles.row}>
                <div className={styles.rowMain}>
                  <p className={styles.rowName}>
                    {l.label} {l.unit.toLowerCase()}
                  </p>
                  {l.products.length > 1 && <p className={styles.rowNote}>{l.products.join(' + ')}</p>}
                </div>
                <span className={styles.rowQty}><Qty value={l.qty} /></span>
              </li>
            ))}
          </ul>
        </>
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
      {/*
        WHAT YOU OWE THEM — only when there is some, and settled from where it is read.

        "UI visible to settle what we owe the customer in empties or money or deposit, maybe only
        visible when any exist ... instead of single-line buttons, a grid of cards." Each card is one
        thing the shop owes this customer, with its figure, and opens the screen that settles it.
      */}
      {(owed < 0 || heldTotal > 0 || weHold.length > 0) && (
        <>
          <h2 className={styles.section}>What you owe them</h2>
          <div className={styles.tiles}>
            {owed < 0 && can('payments.record') && (
              <button
                type="button"
                className={`${styles.tile} ${styles.tileOwe}`}
                onClick={() => void nav.push('account_action_page', { id: customerId, kind: 'refund' })}
              >
                <span className={styles.tileIcon}><CashIcon /></span>
                <span className={styles.tileLabel}>Money</span>
                <span className={styles.tileValue}>{formatMoney(Math.abs(owed))}</span>
                <span className={styles.tileNote}>Give it back</span>
              </button>
            )}
            {heldTotal > 0 && (
              <button
                type="button"
                className={`${styles.tile} ${styles.tileOwe}`}
                onClick={() => void nav.push('deposit_customer_page', { id: customerId })}
              >
                <span className={styles.tileIcon}><CashIcon /></span>
                <span className={styles.tileLabel}>Their deposit</span>
                <span className={styles.tileValue}>{formatMoney(heldTotal)}</span>
                <span className={styles.tileNote}>Give back, or keep some</span>
              </button>
            )}
            {weHold.length > 0 && (
              <button
                type="button"
                className={`${styles.tile} ${styles.tileOwe}`}
                onClick={() => void nav.push('empties_customer_page', { id: customerId })}
              >
                <span className={styles.tileIcon}><ReturnIcon /></span>
                <span className={styles.tileLabel}>Their empties</span>
                <span className={styles.tileValue}>
                  {weHold
                    .slice(0, 2)
                    .map((l) => `${formatQtySpoken(String(l.qty))} ${l.unit.toLowerCase()}`)
                    .join(', ')}
                  {weHold.length > 2 ? '…' : ''}
                </span>
                <span className={styles.tileNote}>In your yard — give them back</span>
              </button>
            )}
          </div>
        </>
      )}

      {/*
        FIVE THINGS A SHOP DOES ON AN ACCOUNT, and each is one kind of record — as a grid of cards
        rather than a column of full-width buttons, which pushed the history off the screen.

          MONEY THEY OWE     a payment reduces it, a charge adds to it.
          MONEY WE OWE       an excess — an overpayment, a load brought back.
          MONEY WE HOLD      a deposit. Not theirs to spend and not ours to count as takings.
          CONTAINERS         counted in the product's own shape, settled on their own screen.

        Empties and Deposit push onto a ledger screen rather than a one-shot form: both are running
        accounts, and what matters first is what is there and how it got that way.
      */}
      <h2 className={styles.section}>On this account</h2>
      <div className={styles.tiles}>
        {/*
          MONEY, EMPTIES, DEPOSIT — three running accounts, each a ledger with its own records.

          "Too many buttons here: adopt payment and charge as a ledger, just like empties and
          deposit." A payment, a charge, money you owe them and money handed back were four cards
          (and the statement a fifth); they are the buttons on the Money page now, above the
          history they add to.
        */}
        <button
          type="button"
          className={`${styles.tile} ${styles.tilePrimary}`}
          onClick={() => void nav.push('money_customer_page', { id: customerId })}
        >
          <span className={styles.tileIcon}><CashIcon /></span>
          <span className={styles.tileLabel}>Money</span>
          <span className={styles.tileValue}>{formatMoney(Math.abs(owed))}</span>
          <span className={styles.tileNote}>
            {owed > 0.005 ? 'They owe you' : owed < -0.005 ? 'You owe them' : 'Nothing owed'} ·
            payments, charges
          </span>
        </button>
        <button
          type="button"
          className={styles.tile}
          onClick={() => void nav.push('empties_customer_page', { id: customerId })}
        >
          <span className={styles.tileIcon}><ReturnIcon /></span>
          <span className={styles.tileLabel}>Empties</span>
          <span className={styles.tileNote}>Out with them, or theirs with you</span>
        </button>
        <button
          type="button"
          className={styles.tile}
          onClick={() => void nav.push('deposit_customer_page', { id: customerId })}
        >
          <span className={styles.tileIcon}><CashIcon /></span>
          <span className={styles.tileLabel}>Deposit</span>
          <span className={styles.tileNote}>Money held against containers</span>
        </button>
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
                    // Money that lowers what they owe reads as in; what raises it, as out.
                    h.kind === 'payment' || h.kind === 'excess'
                      ? styles.in
                      : h.kind === 'sale' || h.kind === 'charge' || h.kind === 'opening'
                        ? styles.out
                        : ''
                  }`}
                >
                  {h.amount !== null && Number(h.amount) !== 0
                    ? formatMoney(Math.abs(Number(h.amount)))
                    : h.qty_units !== null
                      ? `${formatQtySpoken(Math.abs(Number(h.qty_units)))}`
                      : ''}
                </span>
              </div>
              <p className={styles.eventMeta}>
                {new Date(h.occurred_at).toLocaleString()}
                {h.detail ? ` · ${h.detail}` : ''}
                {h.qty_units !== null && h.amount !== null && Number(h.amount) !== 0
                  ? ` · ${formatQtySpoken(Math.abs(Number(h.qty_units)))} containers`
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
              {/* A payment opens its receipt, to be sent again (see payment_done_page). */}
              {h.ref_table === 'payments' && h.ref_id && (
                <button
                  type="button"
                  className={styles.eventOpen}
                  onClick={() =>
                    void nav.push('payment_done_page', { id: h.ref_id as string, from: 'history' })
                  }
                >
                  See the payment
                </button>
              )}
              {/* A deposit or containers line opens the ledger it moved (0156). */}
              {ledgerPageFor(h.kind) && (
                <button
                  type="button"
                  className={styles.eventOpen}
                  onClick={() => void nav.push(ledgerPageFor(h.kind)!, { id: customerId })}
                >
                  {ledgerPageFor(h.kind) === 'deposit_customer_page' ? 'See the deposit' : 'See the empties'}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
          </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
