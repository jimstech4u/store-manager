'use client';

import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { CashIcon, HistoryIcon, RefreshIcon, ReturnIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { useCustomerAccount, useEmptiesPools } from '@/lib/stacks/customer-account';
import { formatMoney, formatQty } from '@/lib/format';
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

type ActionKind =
  | 'payment'
  | 'return'
  | 'deposit'
  | 'refund'
  | 'breakage'
  | 'opening'
  | null;

export default function AccountPage() {
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const { can } = usePermission();

  const customerId = (location?.params?.id as string | undefined) ?? null;
  const { account, history, loading, error, reload } = useCustomerAccount(customerId);
  const pools = useEmptiesPools(store?.id ?? null);

  const nav = useNav();
  // Same staleness problem as the statement page, same answer — see the hook for why a single
  // lifecycle signal was not enough.
  useLiveRefresh(nav, reload);

  const [action, setAction] = useState<ActionKind>(null);
  const [amount, setAmount] = useState('');
  const [qty, setQty] = useState('');
  const [poolId, setPoolId] = useState('');
  const [method, setMethod] = useState('cash');
  const [refundMode, setRefundMode] = useState<'credit' | 'cash' | 'none'>('credit');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

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

  const openAction = (kind: ActionKind) => {
    setProblem(null);
    setAmount('');
    setQty('');
    setNote('');
    setPoolId(pools[0]?.id ?? '');
    setMethod('cash');
    setRefundMode('credit');
    setAction(kind);
  };

  const run = async () => {
    setBusy(true);
    setProblem(null);
    const supabase = getSupabase();
    try {
      if (action === 'payment') {
        const { error: e } = await supabase.rpc('record_payment', {
          p_store_id: store.id,
          p_customer_id: customerId,
          p_amount: Number(amount),
          p_method: method,
          p_reference: note.trim() || null,
          p_occurred_at: new Date().toISOString(),
          p_client_uuid: crypto.randomUUID(),
          p_bank_account_id: null,
        });
        if (e) throw e;
      } else if (action === 'return') {
        const { error: e } = await supabase.rpc('return_empties', {
          p_store_id: store.id,
          p_customer_id: customerId,
          p_category_id: poolId,
          p_qty: Number(qty),
          p_occurred_at: new Date().toISOString(),
          p_client_uuid: crypto.randomUUID(),
          p_refund_mode: refundMode,
        });
        if (e) throw e;
      } else if (action === 'deposit') {
        const { error: e } = await supabase.rpc('take_deposit', {
          p_store_id: store.id,
          p_customer_id: customerId,
          p_category_id: poolId,
          p_qty: Number(qty),
          p_per_unit: amount.trim() === '' ? null : Number(amount),
          p_note: note.trim() || null,
          p_occurred_at: new Date().toISOString(),
        });
        if (e) throw e;
      } else if (action === 'refund') {
        const { error: e } = await supabase.rpc('refund_deposit', {
          p_store_id: store.id,
          p_customer_id: customerId,
          p_category_id: poolId,
          p_qty: Number(qty),
          p_note: note.trim() || null,
          p_occurred_at: new Date().toISOString(),
        });
        if (e) throw e;
      } else if (action === 'opening') {
        /*
         * Opening position: what this customer already owed before the shop started using this
         * app at all.
         *
         * Recorded through `backfill_debtor` / `backfill_empties` rather than as a fake sale, so
         * it never pretends goods moved on a day they did not. It lands on the timeline as an
         * opening entry, which is what it is, and every later figure is built on top of it.
         */
        if (amount.trim() !== '' && Number(amount) !== 0) {
          const { error: e } = await supabase.rpc('backfill_debtor', {
            p_store_id: store.id,
            p_customer_id: customerId,
            p_amount: Number(amount),
            p_as_of: new Date().toISOString().slice(0, 10),
            p_note: note.trim() || 'Opening balance',
          });
          if (e) throw e;
        }
        if (qty.trim() !== '' && Number(qty) !== 0 && poolId) {
          const { error: e } = await supabase.rpc('backfill_empties', {
            p_store_id: store.id,
            p_customer_id: customerId,
            p_category_id: poolId,
            p_qty: Number(qty),
            p_as_of: new Date().toISOString().slice(0, 10),
          });
          if (e) throw e;
        }
      } else if (action === 'breakage') {
        const { error: e } = await supabase.rpc('forfeit_deposit', {
          p_store_id: store.id,
          p_customer_id: customerId,
          p_category_id: poolId,
          p_qty: Number(qty),
          p_amount: Number(amount),
          p_note: note.trim() || null,
          p_occurred_at: new Date().toISOString(),
        });
        if (e) throw e;
      }
      setAction(null);
      await reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  const poolName = (id: string | null) =>
    pools.find((p) => p.id === id)?.name ?? account.empties.find((e) => e.category_id === id)?.category ?? '';

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
      ]}
    >
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

      {can('payments.record') && (
        <div className={styles.actions}>
          <Button size="large" fullWidth onClick={() => openAction('payment')}>
            <CashIcon /> Record a payment
          </Button>
          <Button variant="secondary" fullWidth onClick={() => openAction('return')}>
            <ReturnIcon /> They brought empties back
          </Button>
          <Button variant="secondary" fullWidth onClick={() => openAction('deposit')}>
            Take a deposit instead
          </Button>
          {can('customers.manage') && (
            <Button variant="ghost" fullWidth onClick={() => openAction('opening')}>
              Enter what they already owed
            </Button>
          )}
          {heldTotal !== 0 && (
            <>
              <Button variant="secondary" fullWidth onClick={() => openAction('refund')}>
                Give a deposit back
              </Button>
              <Button variant="secondary" fullWidth onClick={() => openAction('breakage')}>
                Keep some for breakage
              </Button>
            </>
          )}
        </div>
      )}

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
            </li>
          ))}
        </ol>
      )}

      {/* ── Action sheet ────────────────────────────────────────────────────── */}

      <BottomSheet
        open={action !== null}
        onClose={() => setAction(null)}
        title={
          action === 'payment'
            ? 'Record a payment'
            : action === 'return'
              ? 'Empties brought back'
              : action === 'deposit'
                ? 'Take a deposit'
                : action === 'refund'
                  ? 'Give a deposit back'
                  : action === 'opening'
                    ? 'What they already owed'
                    : 'Keep some for breakage'
        }
        footer={
          <div className={styles.sheetActions}>
            <Button variant="secondary" onClick={() => setAction(null)} disabled={busy}>
              Cancel
            </Button>
            <Button busy={busy} onClick={() => void run()}>
              Record it
            </Button>
          </div>
        }
      >
        {problem && (
          <InfoPanel tone="danger" title="Not recorded">
            {problem}
          </InfoPanel>
        )}

        {action === 'payment' && (
          <>
            <Field
              label="How much did they pay?"
              numeric
              prefix="₦"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              hint={`They owe ${formatMoney(Math.abs(owed))}.`}
              autoFocus
            />
            <div className={styles.field}>
              <label className={styles.label} htmlFor="pay-method">
                How did it come in?
              </label>
              <select
                id="pay-method"
                className={styles.select}
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              >
                <option value="cash">Cash</option>
                <option value="transfer">Bank transfer</option>
                <option value="pos">Card / POS</option>
                <option value="other">Something else</option>
              </select>
            </div>
            <Field
              label="Reference"
              optional
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Teller number, or who brought it"
            />
          </>
        )}

        {action === 'opening' && (
          <>
            <InfoPanel tone="info" title="Only for what happened before you started here">
              Use this once per customer, to bring in what they already owed you and what of yours
              they already had. It is recorded as an opening entry, not as a sale — nothing moves
              on your shelf.
            </InfoPanel>
            <Field
              label="Money they already owed"
              optional
              numeric
              prefix="₦"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
            />
          </>
        )}

        {action !== 'payment' && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="pool">
              {action === 'opening' ? 'Which of yours do they already have?' : 'Which ones?'}
            </label>
            <select
              id="pool"
              className={styles.select}
              value={poolId}
              onChange={(e) => setPoolId(e.target.value)}
            >
              {pools.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {Number(p.deposit) > 0 ? ` — ${formatMoney(p.deposit)} each` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {action !== 'payment' && (
          <Field
            label="How many?"
            optional={action === 'opening'}
            numeric
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="0"
          />
        )}

        {action === 'return' &&
          Number(account.empties.find((e) => e.category_id === poolId)?.held ?? 0) > 0 && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="refund-mode">
                You are holding a deposit on these — what happens to it?
              </label>
              <select
                id="refund-mode"
                className={styles.select}
                value={refundMode}
                onChange={(e) => setRefundMode(e.target.value as 'credit' | 'cash' | 'none')}
              >
                <option value="credit">Take it off what they owe</option>
                <option value="cash">Give them the cash</option>
                <option value="none">Leave it on deposit — they are taking more</option>
              </select>
              <p className={styles.rowNote}>
                Whichever you choose is written down with the time and your name, so it can be
                explained later.
              </p>
            </div>
          )}

        {action === 'deposit' && (
          <Field
            label="Deposit for each"
            optional
            numeric
            prefix="₦"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={formatMoney(pools.find((p) => p.id === poolId)?.deposit ?? 0)}
            hint="Leave empty to use this shop's usual deposit for that pool."
          />
        )}

        {action === 'breakage' && (
          <Field
            label="How much are you keeping?"
            numeric
            prefix="₦"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            hint="The rest of their deposit for these goes back to them."
          />
        )}

        {action !== 'payment' && (
          <Field
            label="Why / note"
            optional
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={action === 'breakage' ? '3 bottles cracked' : 'Anything worth remembering'}
          />
        )}
      </BottomSheet>
    </PageScaffold>
  );
}
