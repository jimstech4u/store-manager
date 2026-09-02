'use client';

import { useEffect, useState } from 'react';
import { useLocation, useNav, useObject } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { useListNotifier } from '@/hooks/useListChannel';
import styles from './customer-form-page.module.css';
import { messageOf } from '@/lib/format';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';

/**
 * Saving somebody as a customer.
 *
 * A PAGE, because it is a form — and it was living inside the customer picker, which is a
 * selection viewer. A viewer is built to show a list you scroll and choose from: it has a search
 * box of its own, a drag handle, snap points, and a height that assumes a list. A form put inside
 * one inherits all of that and needs none of it, and the two fight over the keyboard on a phone.
 *
 * So the picker offers a button and this page holds the form. The picker closes on the way out —
 * a sheet left open underneath a pushed page is a sheet somebody comes back to and has to dismiss.
 *
 * WHAT COMES BACK travels through `provideObject`, the same way the product form returns what it
 * created — but ONLY WHEN THE PUSH ASKED FOR IT.
 *
 * That qualifier is the whole point. `onCustomerCreated` is published once by the sell screen and
 * stays published for the session, so a form opened from anywhere at all found it and handed the
 * new customer over. Adding somebody from the People tab — a screen with no order on it and
 * nothing to do with the till — silently attached them to whatever sale happened to be open, and
 * the seller carried on selling to the wrong person. Seen in a click-through: an order reading
 * "Customer 2" came back reading "Unrelated 91379".
 *
 * So the caller states its intent in the push, and a caller that says nothing gets nothing back.
 * The alternative — a callback per caller — cannot work while the name is session-wide, and
 * making the form guess from which stack it was pushed is exactly the guessing this avoids.
 */
export default function CustomerFormPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  // The name is prefilled from whatever was typed into the picker's search: somebody who has just
  // typed "Irekanmi" and been told there is no such customer should not type it again.
  const prefill = (location?.params?.name as string | undefined) ?? '';

  /*
   * "Put whoever I create onto the sale I have open."
   *
   * Said by the till and by the payment screen; not said by the People tab, which is only filing
   * somebody away.
   */
  const attachToSale = location?.params?.then === 'attach-to-sale';

  const created = useObject<(customer: { id: string; name: string; phone: string }) => void>(
    'onCustomerCreated',
    { global: true, scope: 'people' },
  );

  const notifyPeople = useListNotifier<{
    id: string;
    display_name: string;
    business_name: string | null;
    phone: string;
    balance: string;
  }>('customers');

  const [name, setName] = useState(prefill);
  const [phone, setPhone] = useState('');
  const [business, setBusiness] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = useProblem();

  /*
   * Pushed from a counter with somebody waiting. The caller says so; the form cannot tell.
   *
   * It changes which of the opening figures are REQUIRED — not which exist. A shop that is putting
   * a customer on account mid-sale is the shop most likely to already be owed something by them,
   * and it is the moment they know.
   */
  const minimum = location?.params?.required === 'minimum';

  /*
   * WHAT THEY ALREADY OWED, before this shop started here.
   *
   * Recorded through `backfill_debtor` / `backfill_empties` rather than as a fake sale, so nothing
   * pretends goods moved on a day they did not. They land on the timeline as opening entries, and
   * every later figure is built on top of them.
   */
  const [owes, setOwes] = useState('');
  const [owedThem, setOwedThem] = useState('');
  const [pool, setPool] = useState('');
  const [poolQty, setPoolQty] = useState('');
  /*
   * The lines added so far, and the shop's explicit "none".
   *
   * A quantity can be zero; a list cannot. So the question is asked outright and either answer is
   * accepted — lines, or "none are out". What is refused is neither, because a blank list and an
   * unanswered question look identical afterwards and only one of them is a fact.
   */
  const [openingEmpties, setOpeningEmpties] = useState<{ id: string; name: string; qty: string }[]>(
    [],
  );
  const [noEmpties, setNoEmpties] = useState(false);
  const [openingNote, setOpeningNote] = useState('');
  const [pools, setPools] = useState<{ id: string; name: string; kind: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    void getSupabase()
      .rpc('store_empties_categories', { p_store_id: store?.id })
      .then(({ data }) => {
        if (!cancelled) setPools((data ?? []) as typeof pools);
      });
    return () => {
      cancelled = true;
    };
  }, [store?.id]);

  if (!store) return null;

  const save = async () => {
    /*
     * REQUIRED, AND ZERO IS AN ANSWER.
     *
     * "They owe nothing" is a fact somebody checked. A blank is a question nobody asked, and it
     * looks identical afterwards — which is how a customer's opening balance quietly becomes zero
     * for the rest of the shop's life.
     */
    if (minimum && owes.trim() === '') {
      problem.show('Do they already owe you anything? Put 0 if they do not.');
      return;
    }
    if (minimum && pools.length > 0 && openingEmpties.length === 0 && !noEmpties) {
      problem.show(
        'Are any containers already out with them? Add them, or tick that none are.',
      );
      return;
    }

    setBusy(true);
    try {
      const { data, error } = await getSupabase().rpc('upsert_customer', {
        p_store_id: store.id,
        p_phone: phone.trim(),
        p_display_name: name.trim(),
        /*
         * Asked for on this form and, until now, thrown away.
         *
         * `upsert_customer` has taken a business name all along; this call simply never passed it.
         * The row was then patched into the list WITH the business name, so it appeared to have
         * saved — and vanished on the next refresh, which is the worst way for a field to fail.
         */
        p_business_name: business.trim() || null,
      });
      if (error) throw error;

      const customer = { id: data as string, name: name.trim(), phone: phone.trim() };

      /*
       * The opening position, dated to the day the shop opened its book — not today.
       *
       * `p_as_of` is what keeps a report able to separate "brought forward" from "traded here". A
       * balance stamped with today's date reads as business this shop did, and no later report can
       * tell the difference.
       */
      const asOf = new Date().toISOString().slice(0, 10);

      if (Number(owes) > 0) {
        const { error: e1 } = await getSupabase().rpc('backfill_debtor', {
          p_store_id: store.id,
          p_customer_id: customer.id,
          p_amount: Number(owes),
          p_as_of: asOf,
          p_note: openingNote.trim() || 'What they owed before we started here',
        });
        if (e1) throw e1;
      }

      if (Number(owedThem) > 0) {
        const { error: e2 } = await getSupabase().rpc('backfill_debtor', {
          p_store_id: store.id,
          p_customer_id: customer.id,
          // Negative: the same ledger, the other direction. A shop that owes a customer is an
          // ordinary situation — an overpayment, a returned load — and it belongs on the same line
          // as what they owe, or the two can disagree.
          p_amount: -Number(owedThem),
          p_as_of: asOf,
          p_note: openingNote.trim() || 'What we owed them before we started here',
        });
        if (e2) throw e2;
      }

      /*
       * One call per pool, in order.
       *
       * Sequential rather than parallel so a failure half way through says which line failed — the
       * shop can then add the rest from the account rather than guessing which of four went in.
       */
      for (const line of openingEmpties) {
        if (!(Number(line.qty) > 0)) continue;
        const { error: e3 } = await getSupabase().rpc('backfill_empties', {
          p_store_id: store.id,
          p_customer_id: customer.id,
          p_category_id: line.id,
          p_qty: Number(line.qty),
          p_as_of: asOf,
        });
        if (e3) throw e3;
      }

      /*
       * The list is told about this one customer rather than asked to read itself again.
       *
       * Sent before leaving: the people screen may be the page underneath, and it should already
       * show them by the time the back animation finishes.
       */
      notifyPeople({
        type: 'upsert',
        row: {
          id: customer.id,
          display_name: customer.name,
          business_name: business.trim() || null,
          phone: customer.phone,
          balance: '0',
        },
      });

      if (attachToSale && created.isProvided) created.getter()?.(customer);
      await nav.pop();
    } catch (e) {
      problem.show(messageOf(e, 'That customer could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="Add a customer"
      subtitle="Somebody you sell to more than once"
    >
      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        This was an InfoPanel above the fields. On a phone it is the first thing pushed off the top
        as soon as the keyboard opens, so a save that failed looked exactly like a save that did
        nothing — and the shop presses the button again.
      */}
      <ProblemDialog problem={problem} title="Not saved" />

      <InfoPanel tone="info" title="When to save somebody">
        You only need this for people buying on credit, or regulars you want a history for. An
        ordinary cash sale needs no name at all.
      </InfoPanel>

      <Field
        label="Their name"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Irekanmi"
        autoFocus
      />

      {/*
        REQUIRED, because the shop's own rule says so.
        *
        * `upsert_customer` resolves the number to a shared identity before it saves anything —
        * that is how the same person known to two shops, or recognised from a number typed
        * differently, ends up as one customer rather than two with the debt split between them.
        * Without a number there is nothing to resolve, and the database refuses.
      */}
      <Field
        label="Phone"
        required
        type="tel"
        inputMode="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="0803 000 0000"
        hint="How the shop recognises them again — and where a receipt can be sent."
      />

      <Field
        label="Business name"
        optional
        value={business}
        onChange={(e) => setBusiness(e.target.value)}
        placeholder="Their shop or company"
      />

      {/*
        WHAT THEY ALREADY OWED, asked here because here is where it is known.

        A shop moving off a paper book creates the person and their history in one breath. Asking on
        a second screen afterwards means half of them never get asked — and an opening balance
        nobody entered is indistinguishable from a customer who owes nothing.

        Required with ZERO ACCEPTED when this form was pushed from a counter. "They owe nothing" is
        a fact somebody checked; a blank is a question nobody asked, and the two look identical a
        month later.
      */}
      <h2 className={styles.section}>Before you started here</h2>
      <p className={styles.sectionNote}>
        From your book, if you have been trading with them already. Dated before today, so your
        reports can tell it apart from business done here.
      </p>

      <Field
        label="They already owe you"
        numeric
        prefix="₦"
        required={minimum}
        value={owes}
        onChange={(e) => setOwes(e.target.value)}
        placeholder="0"
        hint={minimum ? 'Put 0 if they owe you nothing.' : 'Leave blank if there is nothing to carry over.'}
      />

      <Field
        label="You owe them"
        optional
        numeric
        prefix="₦"
        value={owedThem}
        onChange={(e) => setOwedThem(e.target.value)}
        placeholder="0"
        hint="An overpayment, or a load they brought back. Rarer, and it still belongs on the account."
      />

      {pools.length > 0 && (
        <>
          <h3 className={styles.subsection}>Containers already out with them</h3>

          {/*
            ONE COMPOSER, and what has been added listed above it — the rule this project already
            follows for fees and payments. A customer can owe crates AND bottles at once, and a
            single select with a single quantity can only ever record the first of them.
          */}
          {openingEmpties.length > 0 && (
            <ul className={styles.lineList}>
              {openingEmpties.map((line) => (
                <li key={line.id} className={styles.lineRow}>
                  <span>
                    {Number(line.qty)} {line.name}
                  </span>
                  <button
                    type="button"
                    className={styles.lineRemove}
                    onClick={() =>
                      setOpeningEmpties((prev) => prev.filter((l) => l.id !== line.id))
                    }
                    aria-label={`Remove ${line.name}`}
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className={styles.poolPick}>
            <label className={styles.poolLabel} htmlFor="opening-pool">
              Which kind
            </label>
            <select
              id="opening-pool"
              className={styles.poolSelect}
              value={pool}
              onChange={(e) => setPool(e.target.value)}
              disabled={noEmpties}
            >
              <option value="">Choose one</option>
              {pools
                .filter((x) => !openingEmpties.some((l) => l.id === x.id))
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
          </div>

          <Field
            label="How many"
            numeric
            value={poolQty}
            onChange={(e) => setPoolQty(e.target.value)}
            placeholder="0"
            disabled={noEmpties}
          />

          <Button
            fullWidth
            disabled={noEmpties || !pool || !(Number(poolQty) > 0)}
            onClick={() => {
              const chosen = pools.find((x) => x.id === pool);
              if (!chosen) return;
              setOpeningEmpties((prev) => [...prev, { id: chosen.id, name: chosen.name, qty: poolQty }]);
              setPool('');
              setPoolQty('');
            }}
          >
            <PlusIcon /> Add these
          </Button>

          {/*
            The other answer, and it has to be as easy to give as the first.
            A shop that ticks this has ANSWERED; a shop that leaves the list empty has not.
          */}
          <label className={styles.toggleRow}>
            <input
              type="checkbox"
              checked={noEmpties}
              onChange={(e) => {
                setNoEmpties(e.target.checked);
                if (e.target.checked) setOpeningEmpties([]);
              }}
            />
            <span>None are out with them</span>
          </label>
        </>
      )}

      <Field
        label="Where this came from"
        optional
        value={openingNote}
        onChange={(e) => setOpeningNote(e.target.value)}
        placeholder="Blue book, page 14"
        hint="For whoever reads the account later and wonders where the figure came from."
      />

      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => void nav.pop()} disabled={busy}>
          Cancel
        </Button>
        <Button busy={busy} disabled={!name.trim() || !phone.trim()} onClick={() => void save()}>
          Save customer
        </Button>
      </div>
    </PageScaffold>
  );
}
