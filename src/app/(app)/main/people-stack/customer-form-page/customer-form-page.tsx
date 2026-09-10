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
import { BottomSheet } from '@/components/ui/BottomSheet';
import { productEmptiesOut, type ShapeOut } from '@/lib/stacks/empties';
import {
  groupsWithReturnables,
  productsWithReturnables,
  recordEmpties,
  recordGroupEmpties,
  takeDeposit,
  type ReturnableGroup,
  type ReturnableProduct,
  type GroupUnit,
  groupReturnUnits,
} from '@/lib/stacks/customer-ledgers';
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
/**
 * One line of "what they are holding", ready to be written.
 *
 * Either a product's SHAPE or a maker plus a shape-word — the two things `customer_empties` accepts
 * since 0118, and the two ways a shop actually knows this. `what` is the sentence a person reads
 * back on the form, which is not the same as what the writer needs.
 */
interface OpeningEmpty {
  key: string;
  what: string;
  qty: string;
  productUnitId?: string;
  categoryId?: string;
  storeUnitId?: string;
  /**
   * Whose containers.
   *
   *   `they_hold`  ours, out with them — what the form has always asked.
   *   `we_hold`    theirs, left here. Routine, and previously unrecordable, so a shop knew what it
   *                was owed and never what it owed.
   */
  side: 'they_hold' | 'we_hold';
}

const newLineKey = () => Math.random().toString(36).slice(2, 10);

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

  /*
   * Whether there is anybody for the rest of the form to be about.
   *
   * Everything below the name asks about a PERSON — what they already owe, what containers they are
   * holding. Trimmed, so whitespace is not a name; not otherwise validated, because a form that
   * hides itself again when somebody backspaces to fix a typo is worse than one that shows early.
   */
  const named = name.trim() !== '';
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
  const [deposit, setDeposit] = useState('');
  /** Which way the shop is entering it: by the item, or by the maker. */
  const [tab, setTab] = useState<'product' | 'group'>('product');
  /*
   * Which way the containers are going.
   *
   * Separate from the tab above, which is about how the shop KNOWS the obligation — by item or by
   * maker. This is about WHOSE crates they are, and the two are independent: a shop can know "24
   * NBL crates of theirs are here" exactly as easily as "24 of ours are with them".
   */
  const [side, setSide] = useState<'they_hold' | 'we_hold'>('they_hold');
  /** Which picker is open, if any — the same tab names, so one piece of state cannot disagree. */
  const [picking, setPicking] = useState<null | 'product' | 'group'>(null);

  /*
   * The item or maker chosen, and the quantities being typed against it.
   *
   * Held here rather than added straight to the list, because a shape's box can be left blank —
   * "three crates and no bottles" is one answer, and it is entered by filling one box of two.
   */
  const [chosenItem, setChosenItem] = useState<ReturnableProduct | null>(null);
  const [itemShapes, setItemShapes] = useState<ShapeOut[]>([]);
  const [chosenMaker, setChosenMaker] = useState<ReturnableGroup | null>(null);
  const [makerUnits, setMakerUnits] = useState<GroupUnit[]>([]);
  const [byShape, setByShape] = useState<Record<string, string>>({});
  /*
   * The lines added so far, and the shop's explicit "none".
   *
   * A quantity can be zero; a list cannot. So the question is asked outright and either answer is
   * accepted — lines, or "none are out". What is refused is neither, because a blank list and an
   * unanswered question look identical afterwards and only one of them is a fact.
   */
  /*
   * WHAT THEY ARE HOLDING, as lines ready to be written.
   *
   * Each carries the ids the writer needs and the words the seller reads, because the two are
   * different: `record_customer_empties` wants a shape id, and the person checking the form wants
   * "3 Goldberg crates".
   */
  const [openingEmpties, setOpeningEmpties] = useState<OpeningEmpty[]>(
    [],
  );
  const [noEmpties, setNoEmpties] = useState(false);
  /*
   * WHAT CAN BE OWED, read once when the form opens.
   *
   * Products with at least one shape ticked "comes back", and makers with at least one such
   * product. Both are answers the shop has already given on the product form — this asks nothing
   * new, which is the point: the pools were a second vocabulary that could disagree with the first.
   */
  const [items, setItems] = useState<ReturnableProduct[]>([]);
  const [makers, setMakers] = useState<ReturnableGroup[]>([]);

  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    void (async () => {
      try {
        const [ps, gs] = await Promise.all([
          productsWithReturnables(store.id),
          groupsWithReturnables(store.id),
        ]);
        if (cancelled) return;
        setItems(ps);
        setMakers(gs);
      } catch {
        /*
         * Left empty and NOT treated as "nothing comes back".
         *
         * The composer below is guarded on `items.length`, so a failed read shows no picker rather
         * than an empty one — and the required-answer guard only fires when there is something to
         * answer about, so a shop is never blocked by a request that did not arrive.
         */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  /** Every returnable shape of the chosen item — a box each, the way the count screen asks. */
  useEffect(() => {
    if (!chosenItem) return;
    let cancelled = false;
    void (async () => {
      const rows = await productEmptiesOut(chosenItem.productId).catch(() => []);
      if (!cancelled) {
        setItemShapes(rows);
        setByShape({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chosenItem]);

  /** And the shape-words a maker's containers come back in, so "24 NBL" says 24 of what. */
  useEffect(() => {
    if (!chosenMaker) return;
    let cancelled = false;
    void (async () => {
      const rows = await groupReturnUnits(chosenMaker.id).catch(() => []);
      if (!cancelled) {
        setMakerUnits(rows);
        setByShape({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chosenMaker]);


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
    if (minimum && items.length > 0 && openingEmpties.length === 0 && !noEmpties) {
      problem.show(
        'Is anything of yours out with them? Add it, or tick that there is nothing.',
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
          p_note: 'What they owed before we started here',
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
          p_note: 'What we owed them before we started here',
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

        /*
         * A LINE KNOWS WHICH KIND IT IS, and there are only two.
         *
         * A product's shape when the shop named the item, a maker plus a shape-word when it did
         * not. `backfill_empties` wrote to the pool ledger and is not called here any more — pools
         * are the vocabulary 0108 replaced, and writing to both would leave two answers to
         * "what are they holding" that drift apart from the first sale onwards.
         */
        if (line.productUnitId) {
          await recordEmpties({
            storeId: store.id,
            customerId: customer.id,
            productUnitId: line.productUnitId,
            direction: 'out',
            qty: Number(line.qty),
            reason:
              line.side === 'we_hold'
                ? 'Theirs, already here when the account opened'
                : 'What they already had when the account opened',
            side: line.side,
          });
        } else if (line.categoryId && line.storeUnitId) {
          await recordGroupEmpties({
            storeId: store.id,
            customerId: customer.id,
            categoryId: line.categoryId,
            storeUnitId: line.storeUnitId,
            qty: Number(line.qty),
            reason: 'What they already had when the account opened',
          });
        }
      }

      /*
       * AND THE DEPOSIT, which is money and has nothing to do with the containers.
       *
       * Its own ledger, on purpose: the old model made a deposit a quantity of containers at a
       * rate, so a shop holding a round twenty thousand could not say so. Zero writes nothing —
       * "we hold none" is recorded by the absence of a row, and a nought would be a movement that
       * never happened.
       */
      if (Number(deposit) > 0) {
        await takeDeposit(
          store.id,
          customer.id,
          Number(deposit),
          'Held when the account opened',
        );
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
      {/*
        NOTHING BELOW THIS UNTIL SOMEBODY IS NAMED.

        What they already owe, and what containers they are holding, are questions about a person.
        With the name still empty they are questions about nobody — and when this form is pushed
        from a counter they are marked REQUIRED, so the quickest way through it asked for answers it
        had not yet made answerable.
      */}
      {!named && (
        <p className={styles.waiting}>
          Give them a name first. What they already owe, and anything of yours they are holding,
          will appear here.
        </p>
      )}

      {named && (
      <>
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
        numeric
        prefix="₦"
        required={minimum}
        value={owedThem}
        onChange={(e) => setOwedThem(e.target.value)}
        placeholder="0"
        hint="An overpayment, or a load they brought back. Rarer, and it still belongs on the account."
      />

      {/*
        MONEY YOU ARE HOLDING, which is not money they owe and not empties.
        
        The three are settled separately and by different people at different times, so they are
        asked separately here. A deposit is the shop's to give back or to keep against breakage;
        it is not a payment and must never be netted off what is owed.
      */}
      <Field
        label="Deposit you are holding"
        numeric
        prefix="₦"
        required={minimum}
        value={deposit}
        onChange={(e) => setDeposit(e.target.value)}
        placeholder="0"
        hint="Money of theirs you are keeping against what they take away. Put 0 if you hold none."
      />

      <h3 className={styles.subsection}>What of yours are they holding?</h3>

      {/*
        TWO TABS, because a shop knows this two ways.

        By PRODUCT when it remembers the item — three Goldberg crates and four bottles, a box per
        returnable shape, the way the count screen asks. By MAKER when it does not: twenty-four NBL
        crates carried across from a book, where nobody recorded which beer they were.

        The second is not a lesser answer. It is what the shop actually knows, and forcing it into a
        product would put twenty-four crates against Goldberg because Goldberg sells most — a fact
        nobody stated.
      */}
      {/*
        WHOSE CONTAINERS, asked before how they are counted.

        A customer holding four of the shop's crates while the shop holds two of theirs owes four
        and is owed two. Netting them gives a figure neither party recognises, so they are entered
        and settled separately all the way down.
      */}
      <div className={styles.tabs} role="tablist" aria-label="Whose containers">
        <button
          type="button"
          role="tab"
          aria-selected={side === 'they_hold'}
          className={`${styles.tab} ${side === 'they_hold' ? styles.tabOn : ''}`}
          onClick={() => setSide('they_hold')}
        >
          Yours, with them
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={side === 'we_hold'}
          className={`${styles.tab} ${side === 'we_hold' ? styles.tabOn : ''}`}
          onClick={() => setSide('we_hold')}
        >
          Theirs, with you
        </button>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="How to enter what they are holding">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'product'}
          className={`${styles.tab} ${tab === 'product' ? styles.tabOn : ''}`}
          onClick={() => setTab('product')}
        >
          By item
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'group'}
          className={`${styles.tab} ${tab === 'group' ? styles.tabOn : ''}`}
          onClick={() => setTab('group')}
        >
          By maker
        </button>
      </div>

      {openingEmpties.length > 0 && (
        <ul className={styles.lineList}>
          {openingEmpties.map((line) => (
            <li key={line.key} className={styles.lineRow}>
              <span>
                {line.qty} {line.what}
                {/* Which way it goes, on the line, because the list holds both. */}
                <span className={styles.lineSide}>
                  {line.side === 'we_hold' ? ' · theirs, with you' : ' · yours, with them'}
                </span>
              </span>
              <button
                type="button"
                className={styles.lineRemove}
                onClick={() => setOpeningEmpties((prev) => prev.filter((l) => l.key !== line.key))}
                aria-label={`Remove ${line.what}`}
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className={styles.addEmpties}
        disabled={noEmpties}
        onClick={() => setPicking(tab)}
      >
        <PlusIcon /> {tab === 'product' ? 'Add an item they have' : 'Add a maker they owe'}
      </button>

      {/*
        THE QUANTITIES, once something is chosen — a box per shape, on the page.

        Not in the sheet. The sheet's job was choosing, and it closed when the choice was made; a
        form put inside one fights the keyboard and loses everything typed on a rotation.
      */}
      {chosenItem && (
        <div className={styles.composer}>
          <p className={styles.composerWho}>{chosenItem.productName}</p>
          <div className={styles.shapeBoxes}>
            {itemShapes.map((sh) => (
              <Field
                key={sh.productUnitId}
                label={sh.unitPlural}
                numeric
                value={byShape[sh.productUnitId] ?? ''}
                onChange={(e) =>
                  setByShape((prev) => ({ ...prev, [sh.productUnitId]: e.target.value }))
                }
                placeholder="0"
                hint={sh.baseQty > 1 ? `one is ${sh.baseQty}` : undefined}
              />
            ))}
          </div>
          <div className={styles.composerActions}>
            <Button variant="secondary" onClick={() => setChosenItem(null)}>
              Cancel
            </Button>
            <Button
              disabled={!itemShapes.some((sh) => Number(byShape[sh.productUnitId]) > 0)}
              onClick={() => {
                setOpeningEmpties((prev) => [
                  ...prev,
                  ...itemShapes
                    .filter((sh) => Number(byShape[sh.productUnitId]) > 0)
                    .map((sh) => ({
                      key: newLineKey(),
                      what: `${chosenItem.productName} ${sh.unitPlural.toLowerCase()}`,
                      qty: byShape[sh.productUnitId],
                      productUnitId: sh.productUnitId,
                      side,
                    })),
                ]);
                setChosenItem(null);
              }}
            >
              Add
            </Button>
          </div>
        </div>
      )}

      {chosenMaker && (
        <div className={styles.composer}>
          <p className={styles.composerWho}>{chosenMaker.name}</p>
          <div className={styles.shapeBoxes}>
            {makerUnits.map((u) => (
              <Field
                key={u.storeUnitId}
                label={u.plural}
                numeric
                value={byShape[u.storeUnitId] ?? ''}
                onChange={(e) =>
                  setByShape((prev) => ({ ...prev, [u.storeUnitId]: e.target.value }))
                }
                placeholder="0"
              />
            ))}
          </div>
          <p className={styles.composerWhy}>
            For containers you know are theirs but cannot say which item they came from — what a
            book carries across.
          </p>
          <div className={styles.composerActions}>
            <Button variant="secondary" onClick={() => setChosenMaker(null)}>
              Cancel
            </Button>
            <Button
              disabled={!makerUnits.some((u) => Number(byShape[u.storeUnitId]) > 0)}
              onClick={() => {
                setOpeningEmpties((prev) => [
                  ...prev,
                  ...makerUnits
                    .filter((u) => Number(byShape[u.storeUnitId]) > 0)
                    .map((u) => ({
                      key: newLineKey(),
                      what: `${chosenMaker.name} ${u.plural.toLowerCase()}`,
                      qty: byShape[u.storeUnitId],
                      categoryId: chosenMaker.id,
                      storeUnitId: u.storeUnitId,
                      side,
                    })),
                ]);
                setChosenMaker(null);
              }}
            >
              Add
            </Button>
          </div>
        </div>
      )}

      <label className={styles.none}>
        <input
          type="checkbox"
          checked={noEmpties}
          onChange={(e) => {
            setNoEmpties(e.target.checked);
            if (e.target.checked) setOpeningEmpties([]);
          }}
        />
        <span>Nothing of yours is with them, and nothing of theirs is here</span>
      </label>


      </>
      )}

      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => void nav.pop()} disabled={busy}>
          Cancel
        </Button>
        <Button busy={busy} disabled={!name.trim() || !phone.trim()} onClick={() => void save()}>
          Save customer
        </Button>
      </div>

      {/*
        A CHOICE IS A SHEET — the other half of the rule. Picking one of a list is exactly what a
        selection viewer is for, and it closes the moment something is chosen.
      */}
      <BottomSheet
        open={picking === 'product'}
        onClose={() => setPicking(null)}
        title="Which of your items?"
      >
        <ul className={styles.pickList}>
          {items.map((it) => (
            <li key={it.productId}>
              <button
                type="button"
                className={styles.pickRow}
                onClick={() => {
                  setChosenItem(it);
                  setChosenMaker(null);
                  setPicking(null);
                }}
              >
                <span className={styles.pickName}>{it.productName}</span>
                <span className={styles.pickMeta}>
                  {it.groupName ?? 'no maker set'} · {it.shapes}{' '}
                  {it.shapes === 1 ? 'shape' : 'shapes'} come back
                </span>
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>

      <BottomSheet
        open={picking === 'group'}
        onClose={() => setPicking(null)}
        title="Whose containers?"
      >
        <ul className={styles.pickList}>
          {makers.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className={styles.pickRow}
                onClick={() => {
                  setChosenMaker(m);
                  setChosenItem(null);
                  setPicking(null);
                }}
              >
                <span className={styles.pickName}>{m.name}</span>
                <span className={styles.pickMeta}>
                  {m.products} {m.products === 1 ? 'item' : 'items'} come back
                </span>
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>

    </PageScaffold>
  );
}
