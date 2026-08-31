'use client';

import { useEffect, useState } from 'react';
import { InfoPanel, Explain } from '@/components/ui/Explain';
import { Field } from '@/components/ui/Field';
import { UnitPicker } from '@/components/catalog/UnitPicker';
import { unitGaps, type ProductUnit, type StoreUnit } from '@/lib/stacks/product-units';
import { TrashIcon, PlusIcon } from '@/components/ui/Icon';
import styles from './UnitsEditor.module.css';

/**
 * What a product is bought in and sold in — the editor, without a page around it.
 *
 * Lifted out of the units screen so the product form can hold the same thing. A shop adding an
 * item and a shop correcting one are answering the same question, and two arrangements of it is
 * two things to keep right — the mistake the product form was already making by asking about "the
 * pack" as though every trade had one shape.
 *
 * IT OWNS NO DATA. The list comes in and changes go out, so whoever renders it decides when any of
 * it reaches the shop: the form saves it alongside the name, the units screen saves it on its own.
 */

/**
 * The unit everything else on an item is measured in.
 *
 * THE ONE THAT IS NOT MEASURED AGAINST ANYTHING. That, and not size, is what makes a unit the
 * ruler — and reading it off the relationships is what lets a shop turn one round. Picked by size
 * alone, a swap was undone the moment it was made: the normalising effect below saw the newly
 * freed unit as unanchored and pointed it straight back where it came from.
 *
 * Among the sold ones, because the ruler is the unit exempt from having to be measured, and a
 * bought-only unit is exactly the kind that must be answered for. That distinction was a dead end
 * once already: the screen said "nothing is sold in piece" and offered no way to say what a piece
 * was worth, having declared the piece the ruler.
 *
 * Falls back to the smallest of anything when nothing is sold yet — the page says so separately,
 * and a half-built item should still lay out.
 */
function measuringUnit(units: ProductUnit[]): ProductUnit | null {
  const smallestOf = (list: ProductUnit[]) =>
    list.length === 0 ? null : list.reduce((a, b) => (b.baseQty < a.baseQty ? b : a));

  const sold = units.filter((u) => u.isSold);
  const unmeasured = sold.filter((u) => u.definedAgainst === null);

  return smallestOf(unmeasured) ?? smallestOf(sold) ?? smallestOf(units);
}

export function UnitsEditor({
  units,
  setUnits,
  storeUnits,
  onCreateUnit,
}: {
  units: ProductUnit[];
  setUnits: (next: ProductUnit[]) => void;
  /** The words this shop already has for how much of something there is. */
  storeUnits: StoreUnit[];
  /** Hands over to whoever can push the form that invents a new one. */
  onCreateUnit: (name: string) => void;
}) {
  const [picking, setPicking] = useState<null | 'bought' | 'sold'>(null);

  const patch = (storeUnitId: string, change: Partial<ProductUnit>) =>
    setUnits(units.map((u) => (u.storeUnitId === storeUnitId ? { ...u, ...change } : u)));

  const addUnit = (unit: StoreUnit, side: 'bought' | 'sold') => {
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
         * The first unit measures everything else; anything after it has to say what it is worth.
         * Left blank rather than guessed at — a wrong conversion nobody was asked about is worse
         * than a question, because it silently misprices every delivery.
         */
        definedAgainst: units.length === 0 ? null : (units[0]?.storeUnitId ?? null),
        definedQty: '',
      },
    ]);
  };

  /*
   * A unit with no relationship, which is not the measuring one, is measured against it.
   *
   * WITHOUT THIS THE FORM IS A TRAP. The select shows its first option because a browser has to
   * show something for a value of null, so the sentence reads "One bag is [ ] litres" while the
   * state behind it still says the bag is measured against nothing. Typing 24 then fills the box,
   * changes nothing that matters, and leaves Save greyed out with the screen insisting the
   * question has been answered.
   */
  useEffect(() => {
    const ruler = measuringUnit(units);
    if (!ruler) return;
    const stray = units.filter(
      (u) => u.storeUnitId !== ruler.storeUnitId && u.definedAgainst === null,
    );
    if (stray.length === 0) return;

    setUnits(
      units.map((u) =>
        u.storeUnitId !== ruler.storeUnitId && u.definedAgainst === null
          ? { ...u, definedAgainst: ruler.storeUnitId }
          : u,
      ),
    );
  }, [units, setUnits]);

  /*
   * "One bottle is 12 crates" is what the form asked, and it is backwards.
   *
   * Every unit but the ruler says what it is worth in another, and the ruler is whichever was
   * added first — so a shop that adds the crate and then the bottle is asked how many CRATES a
   * bottle is. The honest answer is a twelfth, which nobody types into a shop screen.
   *
   * The relationship is symmetric; which side holds it is bookkeeping. So it can be turned round:
   * the unit that was doing the measuring becomes the measured one, and the sentence reads the
   * way somebody would say it out loud.
   */
  const swapDirection = (u: ProductUnit) => {
    const other = units.find((x) => x.storeUnitId === u.definedAgainst);
    if (!other) return;

    setUnits(
      units.map((x) => {
        if (x.storeUnitId === u.storeUnitId) return { ...x, definedAgainst: null, definedQty: '' };
        if (x.storeUnitId === other.storeUnitId) {
          return { ...x, definedAgainst: u.storeUnitId, definedQty: u.definedQty };
        }
        return x;
      }),
    );
  };

  const smallest = measuringUnit(units);
  const gaps = unitGaps(units);
  const sold = units.filter((u) => u.isSold);
  const bought = units.filter((u) => u.isBought);

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

          {/*
            Which way round the sentence goes.

            It was a bare link reading "Say it the other way round", which says what the control
            does to ITSELF and nothing about why anybody would press it. Written out, the shop can
            see both sentences and pick the one that is true — and the one with a whole number in
            it is almost always the one they mean.
          */}
          <button
            type="button"
            className={styles.swap}
            onClick={() => swapDirection(u)}
          >
            <span className={styles.swapLead}>Wrong way round?</span>
            <span className={styles.swapDetail}>
              Say “one {units.find((x) => x.storeUnitId === u.definedAgainst)?.name.toLowerCase() ?? 'unit'} is
              … {u.plural.toLowerCase()}” instead
            </span>
          </button>
        </div>
      )}

      {smallest && u.storeUnitId === smallest.storeUnitId && (
        <p className={styles.smallest}>
          Everything else on this item is measured in {u.plural.toLowerCase()}.
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
    <>
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
            Either tick <strong>Customers buy this</strong> on {gaps.length === 1 ? 'it' : 'them'},
            or say what one is worth in something you do sell — one bag is 24 litres, and so on.
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
          onCreateUnit(name);
        }}
      />
    </>
  );
}

/** Everything the caller must fix before this product can be saved. */
export function unitProblems(units: ProductUnit[]): string | null {
  if (units.length === 0) return 'Say what this is bought and sold in.';
  if (!units.some((u) => u.isSold)) return 'Say what a customer can buy.';
  if (unitGaps(units).length > 0) {
    return `Nothing is sold in ${unitGaps(units).map((u) => u.name.toLowerCase()).join(', ')}.`;
  }
  const unmeasured = units.filter(
    (u) => u.definedAgainst !== null && (u.definedQty.trim() === '' || Number(u.definedQty) <= 0),
  );
  if (unmeasured.length > 0) {
    return `Say how many, for ${unmeasured.map((u) => u.name.toLowerCase()).join(', ')}.`;
  }
  return null;
}
