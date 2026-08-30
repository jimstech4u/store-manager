'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { InfoPanel, Explain } from '@/components/ui/Explain';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { UnitPicker } from '@/components/catalog/UnitPicker';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useProduct } from '@/lib/stacks/catalog-stack';
import {
  saveProductUnits,
  unitGaps,
  useProductUnits,
  useStoreUnits,
  type ProductUnit,
  type StoreUnit,
} from '@/lib/stacks/product-units';
import { TrashIcon, PlusIcon } from '@/components/ui/Icon';
import styles from './units-page.module.css';

/**
 * How a shop buys and sells one thing.
 *
 * The screen this whole model existed for and never had. A product could be bought in bags and
 * kilogrammes and sold in litres since the tables were built, but nothing anywhere let anybody
 * SAY so, and the old form still asked the one question it could — "what is a pack?" — as though
 * every trade had exactly one answer.
 *
 * THE HARD PART IS ONE SENTENCE, and it is the only thing on this page that is compulsory. If the
 * shop takes delivery in a unit it never sells in, it has to say what one of them is worth in a
 * unit it does: ONE BAG IS 24 LITRES. Without it those bags arrive and can never leave — no sale
 * can move them, and every stock count afterwards is an argument about a number that only climbs.
 * The database refuses the save; this page asks the question before it comes to that, in the
 * shop's own words rather than as a field called `base_qty`.
 */
export default function UnitsPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const productId = (location?.params?.id as string | undefined) ?? null;
  const { product, settled } = useProduct(productId);
  const { units: storeUnits, reload: reloadStoreUnits } = useStoreUnits(store?.id ?? null);
  const { units, setUnits, loaded } = useProductUnits(productId);

  const [picking, setPicking] = useState<null | 'bought' | 'sold'>(null);
  const [state, setState] = useState<AsyncState>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  /*
   * A unit the shop has just invented, on its way back from the form page.
   *
   * A pushed page has no return value — `nav.push` resolves when the page is SHOWN, not when it is
   * finished with — so the answer comes back through an object the form looks up by name.
   *
   * Through a ref, because the callback is published once and must not go stale: it has to add the
   * new unit to whichever side of the item the shop was adding to, and that is state which changes
   * while the form page is open on top.
   */
  const onUnitCreatedRef = useRef<(unit: StoreUnit) => void>(() => {});
  useEffect(() => {
    const cleanup = nav.provideObject(
      'onUnitCreated',
      () => (unit: StoreUnit) => onUnitCreatedRef.current(unit),
      { global: true, scope: 'catalog' },
    );
    return cleanup;
  }, [nav]);

  /*
   * A unit with no relationship, which is not the smallest, is measured against the smallest.
   *
   * WITHOUT THIS THE PAGE IS A TRAP. The select showed its first option because a browser has to
   * show something for a value of null, so the sentence read "One bag is [ ] litres" while the
   * state behind it still said the bag was measured against nothing. Typing 24 filled the box,
   * changed nothing that mattered, and left Save greyed out with the screen insisting the question
   * had been answered. Seen on the first click-through, which is exactly what click-throughs are
   * for.
   */
  useEffect(() => {
    const smallest =
      units.length === 0 ? null : units.reduce((a, b) => (b.baseQty < a.baseQty ? b : a));
    if (!smallest) return;
    const stray = units.filter(
      (u) => u.storeUnitId !== smallest.storeUnitId && u.definedAgainst === null,
    );
    if (stray.length === 0) return;

    setUnits(
      units.map((u) =>
        u.storeUnitId !== smallest.storeUnitId && u.definedAgainst === null
          ? { ...u, definedAgainst: smallest.storeUnitId }
          : u,
      ),
    );
  }, [units, setUnits]);


  if (!store) return null;
  if (productId && !settled) return <FullPageMessage title="Loading this item" tone="loading" />;
  if (!productId || !product) {
    return <FullPageMessage title="That item is gone" tone="error" />;
  }
  if (!loaded && units.length === 0) {
    return <FullPageMessage title="Loading how you buy and sell it" tone="loading" />;
  }

  const patch = (storeUnitId: string, change: Partial<ProductUnit>) =>
    setUnits(units.map((u) => (u.storeUnitId === storeUnitId ? { ...u, ...change } : u)));

  function addUnit(unit: StoreUnit, side: 'bought' | 'sold') {
    const existing = units.find((u) => u.storeUnitId === unit.id);
    if (existing) {
      // Already on the item, just not on this side of it. A shop that buys and sells in crates has
      // one crate, not two.
      patch(unit.id, side === 'bought' ? { isBought: true } : { isSold: true });
      return;
    }

    setUnits([
      ...units,
      {
        id: null,
        storeUnitId: unit.id,
        name: unit.name,
        plural: unit.plural,
        baseQty: 1,
        isBought: side === 'bought',
        isSold: side === 'sold',
        sellPrice: '',
        isReturnable: false,
        wholeDigit: true,
        allowQuarter: false,
        allowHalf: false,
        allowThreeQuarter: false,
        /*
         * The FIRST unit on an item measures everything else; anything after it has to say what it
         * is worth. Left blank rather than guessed at — a wrong conversion nobody was asked about
         * is worse than a question, because it silently misprices every delivery.
         */
        definedAgainst: units.length === 0 ? null : (units[0]?.storeUnitId ?? null),
        definedQty: '',
      },
    ]);
  }

  onUnitCreatedRef.current = (unit: StoreUnit) => {
    reloadStoreUnits();
    addUnit(unit, picking ?? 'sold');
  };

  /*
   * The one everything else is measured in.
   *
   * The SMALLEST, picked by size rather than by whichever row came back first. More than one unit
   * can arrive with no relationship on it — a catalogue built before 0067, or an import — and
   * "the first one with nothing set" then landed on whichever the database happened to return.
   */
  const smallest =
    units.length === 0
      ? null
      : units.reduce((a, b) => (b.baseQty < a.baseQty ? b : a));

  const gaps = unitGaps(units);

  /** Units that are still missing the sentence that would give them a size. */
  const unmeasured = units.filter(
    (u) => u.definedAgainst !== null && (u.definedQty.trim() === '' || Number(u.definedQty) <= 0),
  );

  const sold = units.filter((u) => u.isSold);
  const bought = units.filter((u) => u.isBought);

  const blocked =
    sold.length === 0 || gaps.length > 0 || unmeasured.length > 0 || units.length === 0;

  const save = async () => {
    setState('busy');
    setProblem(null);
    try {
      await saveProductUnits(productId, units);
      setState('idle');
      void nav.pop();
    } catch (e) {
      setState('failed');
      // The database's own sentence, which names the unit. Far better than anything generic this
      // page could invent, and it is the last word on whether the set adds up.
      setProblem(e instanceof Error ? e.message : 'Could not save this.');
    }
  };

  const unitRow = (u: ProductUnit) => (
    <li key={u.storeUnitId} className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardName}>{u.name}</span>
        <button
          type="button"
          className={styles.remove}
          aria-label={`Remove ${u.name}`}
          onClick={() => setUnits(units.filter((x) => x.storeUnitId !== u.storeUnitId))}
        >
          <TrashIcon />
        </button>
      </div>

      <div className={styles.checks}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={u.isBought}
            onChange={(e) => patch(u.storeUnitId, { isBought: e.target.checked })}
          />
          <span>It arrives in this</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={u.isSold}
            onChange={(e) => patch(u.storeUnitId, { isSold: e.target.checked })}
          />
          <span>Customers buy this</span>
        </label>
      </div>

      {/*
        What one of these IS.

        Missing from every screen before this one, and the reason stock could strand. Written the
        way somebody would say it out loud — "One Bag is 24 Litres" — rather than as a number in a
        box called base quantity, which is a figure nobody in a shop has any means of checking.
      */}
      {smallest && u.storeUnitId !== smallest.storeUnitId && (
        <div className={styles.sentence}>
          <span className={styles.sentencePart}>One {u.name.toLowerCase()} is…</span>
          <Field
            label="How many"
            aria-label={`One ${u.name.toLowerCase()} is how many ${(units.find((x) => x.storeUnitId === u.definedAgainst)?.plural ?? '').toLowerCase()}`}
            numeric
            value={u.definedQty}
            onChange={(e) => patch(u.storeUnitId, { definedQty: e.target.value })}
            error={
              u.definedQty.trim() === '' || Number(u.definedQty) <= 0
                ? 'Say how many, or this stock can never be sold'
                : null
            }
          />
          <select
            className={styles.select}
            aria-label={`What one ${u.name.toLowerCase()} is measured in`}
            value={u.definedAgainst ?? ''}
            onChange={(e) => patch(u.storeUnitId, { definedAgainst: e.target.value })}
          >
            {units
              // Not itself, and not something already measured against it: those two together are
              // a circle, which the database refuses and the shop should never be offered.
              .filter((x) => x.storeUnitId !== u.storeUnitId && x.definedAgainst !== u.storeUnitId)
              .map((x) => (
                <option key={x.storeUnitId} value={x.storeUnitId}>
                  {x.plural}
                </option>
              ))}
          </select>
        </div>
      )}

      {smallest && u.storeUnitId === smallest.storeUnitId && (
        <p className={styles.smallest}>
          The smallest one. Everything else on this item is measured in {u.plural.toLowerCase()}.
        </p>
      )}

      {u.isSold && (
        <>
          <Field
            label={`Price for one ${u.name.toLowerCase()}`}
            numeric
            prefix="₦"
            value={u.sellPrice}
            onChange={(e) => patch(u.storeUnitId, { sellPrice: e.target.value })}
            hint="You can still change it on the receipt."
          />

          <div className={styles.howSold}>
            <span className={styles.howSoldLabel}>How much can somebody buy at a time?</span>
            {/*
              A step, not three separate buttons.

              Saying quarters means a quarter, a half and three-quarters are all sellable, because
              they are all quarters. Whole numbers stay sellable whatever is chosen — somebody who
              sells three-quarter bags certainly sells one bag.
            */}
            {(
              [
                ['Whole ones only', { wholeDigit: true, allowQuarter: false, allowHalf: false, allowThreeQuarter: false }],
                ['Halves too', { wholeDigit: true, allowQuarter: false, allowHalf: true, allowThreeQuarter: false }],
                ['Quarters too', { wholeDigit: true, allowQuarter: true, allowHalf: false, allowThreeQuarter: false }],
                ['Any amount — it is weighed', { wholeDigit: false, allowQuarter: false, allowHalf: false, allowThreeQuarter: false }],
              ] as [string, Partial<ProductUnit>][]
            ).map(([label, change]) => {
              const on =
                u.wholeDigit === change.wholeDigit &&
                u.allowQuarter === change.allowQuarter &&
                u.allowHalf === change.allowHalf;
              return (
                <button
                  key={label}
                  type="button"
                  className={`${styles.choice} ${on ? styles.choiceOn : ''}`}
                  aria-pressed={on}
                  onClick={() => patch(u.storeUnitId, change)}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <label className={styles.check}>
            <input
              type="checkbox"
              checked={u.isReturnable}
              onChange={(e) => patch(u.storeUnitId, { isReturnable: e.target.checked })}
            />
            <span>The {u.name.toLowerCase()} comes back empty</span>
          </label>
        </>
      )}
    </li>
  );

  return (
    <PageScaffold
      onBack={goBack}
      title="How you buy and sell it"
      subtitle={product.name}
      footer={
        <AsyncAction state={state} problem={problem} label="Saving how you buy and sell this">
          <Button onClick={() => void save()} disabled={blocked} fullWidth>
            Save
          </Button>
        </AsyncAction>
      }
    >
      <Explain label="Why does this matter?">
        A shop takes delivery in one unit and sells in another all the time — oil arrives in bags
        and leaves by the litre. As long as you say what one bag holds, every delivery lands as
        litres you can actually sell, and the shelf figure stays a figure somebody can check.
      </Explain>

      {gaps.length > 0 && (
        <InfoPanel tone="danger" title="This stock could come in and never go out">
          <p>
            You take delivery in {gaps.map((g) => g.name.toLowerCase()).join(', ')}, and nothing is
            sold in {gaps.length === 1 ? 'it' : 'them'}.
          </p>
          <p>
            Either tick <strong>Customers buy this</strong> on{' '}
            {gaps.length === 1 ? 'it' : 'them'}, or say what one is worth in something you do sell
            — one bag is 24 litres, and so on.
          </p>
        </InfoPanel>
      )}

      {sold.length === 0 && units.length > 0 && (
        <InfoPanel tone="warning" title="Nothing here is sold yet">
          Tick <strong>Customers buy this</strong> on at least one, or it can never reach a receipt.
        </InfoPanel>
      )}

      <h2 className={styles.heading}>Sold in</h2>
      <ul className={styles.list}>{sold.map(unitRow)}</ul>
      <button type="button" className={styles.add} onClick={() => setPicking('sold')}>
        <PlusIcon /> Add a unit you sell in
      </button>

      <h2 className={styles.heading}>Bought in</h2>
      <p className={styles.headingNote}>
        Only what arrives in a shape you do not sell. Anything you buy and sell the same way is
        already above.
      </p>
      <ul className={styles.list}>{bought.filter((u) => !u.isSold).map(unitRow)}</ul>
      <button type="button" className={styles.add} onClick={() => setPicking('bought')}>
        <PlusIcon /> Add a unit it arrives in
      </button>

      <UnitPicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        units={storeUnits}
        taken={units.filter((u) => u.isBought && u.isSold).map((u) => u.storeUnitId)}
        title={picking === 'bought' ? 'What does it arrive in?' : 'What do customers buy?'}
        onPick={(unit) => addUnit(unit, picking ?? 'sold')}
        onCreate={(name) => {
          setPicking(null);
          void nav.push('unit_form_page', { name });
        }}
      />
    </PageScaffold>
  );
}
