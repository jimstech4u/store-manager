'use client';

import { useState } from 'react';
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

  /*
   * Shapes whose container has been asked for and not yet chosen.
   *
   * The link is stored ON the container — the crate records that it is twelve bottles — so until a
   * container is picked there is nothing to write anywhere. A question half answered belongs in the
   * component, not in the data.
   */
  const [awaitingParent, setAwaitingParent] = useState<string[]>([]);
  /** And the count typed into a row whose container has not been chosen yet. */
  const [pendingQty, setPendingQty] = useState<Record<string, string>>({});

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
        /*
         * A NEW SHAPE STARTS SOLD, and is otherwise unassigned.
         *
         * There is one list now, so "which side did they press" no longer means anything — a shape
         * is added, then the shop says what it is for. Sold is the one role a product cannot do
         * without (nothing reaches a receipt otherwise), so it is the honest default; counting and
         * deposits are answers only the shop has.
         */
        isBought: false,
        isSold: true,
        isCounted: false,
        isDeposit: false,
        sellPrice: '',
        isReturnable: false,
        wholeDigit: true,
        allowQuarter: false,
        allowHalf: false,
        allowThreeQuarter: false,
        /*
         * NOT LINKED TO ANYTHING. The shop says what goes inside what.
         *
         * This used to point a new shape at the first one — "the first unit measures everything
         * else" — which was true when each shape declared what it was MADE OF. It is exactly
         * backwards now that a shape declares what it GOES INSIDE: adding a crate and then a bottle
         * wrote "one bottle is N crates", so the crate's card ticked "crates go inside something
         * bigger" and offered the bottle as the thing it goes in.
         *
         * A guess about which of two shapes contains the other is not one the form can make. Adding
         * a bottle to a crate and adding a crate to a bottle are the same two shapes in the same
         * two orders, and only the shop knows which way round it goes.
         */
        definedAgainst: null,
        definedQty: '',
      },
    ]);
  };

  /*
   * NOTHING LINKS A SHAPE ON THE SHOP'S BEHALF.
   *
   * An effect here used to measure every unlinked shape against the ruler — the first one added —
   * and it is what put the tick back on the crate. Fixing `addUnit` was not enough: the effect
   * re-made the link on the next render, so the box could not be unticked either. Unticking
   * cleared the relationship, the effect saw a stray shape, and pointed it straight back.
   *
   * It was written when a shape declared what it was MADE OF, where "the first unit measures
   * everything else" is at least arguable. A shape now declares what it GOES INSIDE, so the same
   * link read backwards: adding a crate then a bottle wrote "one bottle is N crates", and the
   * crate's card ticked itself and offered the bottle as the thing a crate goes inside.
   *
   * Its stated reason was a select showing its first option while the state behind it said null —
   * a form that looks answered and saves nothing. That is now handled where it belongs: an
   * unlinked shape renders no select at all, and the row being answered carries an explicit
   * "choose one…" that writes the link the moment it is picked.
   */


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

  /*
   * WHO HOLDS THIS SHAPE, and who could.
   *
   * The table records a container declaring what it is made of — a crate IS twelve bottles — so the
   * bottle's containers are simply the shapes pointing at it. Reading it this way round costs a
   * filter and lets the shop say the sentence it actually says.
   */
  const parentsOf = (u: ProductUnit) => units.filter((x) => x.definedAgainst === u.storeUnitId);

  /** Everything this shape could go inside — not itself, not already holding it, and no circle. */
  const candidateParents = (u: ProductUnit) => {
    // What u is (transitively) made of. A crate made of bottles cannot then go inside a bottle.
    const below = new Set<string>();
    let walk: string | null = u.definedAgainst;
    while (walk && !below.has(walk)) {
      below.add(walk);
      walk = units.find((x) => x.storeUnitId === walk)?.definedAgainst ?? null;
    }
    return units.filter(
      (x) =>
        x.storeUnitId !== u.storeUnitId &&
        x.definedAgainst !== u.storeUnitId &&
        !below.has(x.storeUnitId),
    );
  };

  /** Say that `holderId` holds `qty` of `insideId` — or, with a null inside, that it holds nothing. */
  const setParent = (holderId: string, insideId: string | null, qty: string) =>
    setUnits(
      units.map((x) =>
        x.storeUnitId === holderId ? { ...x, definedAgainst: insideId, definedQty: qty } : x,
      ),
    );

  const clearParents = (insideId: string) =>
    setUnits(
      units.map((x) =>
        x.definedAgainst === insideId ? { ...x, definedAgainst: null, definedQty: '' } : x,
      ),
    );

  const smallest = measuringUnit(units);
  const anythingLinked = units.some((u) => u.definedAgainst !== null);
  const gaps = unitGaps(units);
  // `sold` still guards the "nothing is sold yet" warning; the old `bought` list had no reader
  // left once the two lists became one.
  const sold = units.filter((u) => u.isSold);

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

      {/*
        WHAT THIS SHAPE IS FOR — four answers, all about the same shape.

        Two lists became one. A crate a shop both buys and sells used to be a row under "Sold in"
        plus a note under "Bought in" explaining that anything you also sell is "already above" —
        an explanation the design needed because the design was wrong. Define the shape once; say
        what it does.
      */}
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
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={u.isCounted}
            onChange={(e) => patch(u.storeUnitId, { isCounted: e.target.checked })}
          />
          {/*
            A distributor counts crates, not bottles, even when it sells both. Asking for the wrong
            one on a count screen gets a guess instead of a figure.
          */}
          <span>You count the shelf in this</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={u.isDeposit}
            onChange={(e) => patch(u.storeUnitId, { isDeposit: e.target.checked })}
          />
          {/*
            Nobody holds money against a single bottle. Offering one on a deposit screen invites an
            amount nobody agreed.
          */}
          <span>Deposits are held in this</span>
        </label>
      </div>

      {/*
        WHAT THIS GOES INSIDE, said as the sentence a shop says.

        The card you are on is always the CHILD — the thing that goes in — and the dropdown is
        always the container. Written out because "How many fit" beside a dropdown does not say
        which way round it goes, and on the crate's card it cheerfully offered "bottle" as the thing
        a crate goes inside.

        The table stores the other end of the same sentence: the crate records that it IS twelve
        bottles. So this asks the shop's way and writes the table's way, and every trigger and reader
        is untouched.

        SEVERAL containers are allowed and need nothing new — a bottle in a crate and in a pack is
        just the crate and the pack each recording what they hold.
      */}
      {/*
        Said only once something IS measured in it. With nothing linked yet, `measuringUnit` still
        has to answer, and it answers with whichever shape was added first — so an item one shape
        old announced that everything else was measured in crates before a shop had said anything
        of the kind.
      */}
      {anythingLinked && smallest && u.storeUnitId === smallest.storeUnitId && (
        <p className={styles.smallest}>
          Everything else on this item is measured in {u.plural.toLowerCase()}.
        </p>
      )}

      {units.length > 1 && (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={parentsOf(u).length > 0 || awaitingParent.includes(u.storeUnitId)}
            onChange={(e) => {
              if (e.target.checked) {
                // An EMPTY row. Which container it goes in is the question; picking one for them
                // is a guess written into the tree.
                setAwaitingParent((prev) => [...prev, u.storeUnitId]);
              } else {
                setAwaitingParent((prev) => prev.filter((x) => x !== u.storeUnitId));
                clearParents(u.storeUnitId);
              }
            }}
            disabled={candidateParents(u).length === 0 && parentsOf(u).length === 0}
          />
          <span>{u.plural} go inside something bigger</span>
        </label>
      )}

      {(parentsOf(u).length > 0 || awaitingParent.includes(u.storeUnitId)) && (
        <div className={styles.parents}>
          {parentsOf(u).map((p) => (
            <div className={styles.parentRow} key={p.storeUnitId}>
              <Field
                label={`How many ${u.plural.toLowerCase()}`}
                aria-label={`How many ${u.plural.toLowerCase()} fit inside one ${p.name.toLowerCase()}`}
                numeric
                value={p.definedQty}
                onChange={(e) => setParent(p.storeUnitId, u.storeUnitId, e.target.value)}
                error={
                  p.definedQty.trim() === '' || Number(p.definedQty) <= 0
                    ? 'Say how many, or this stock can never be sold'
                    : null
                }
              />

              <span className={styles.parentJoin}>fit inside one</span>

              <select
                className={styles.select}
                aria-label={`What ${u.plural.toLowerCase()} go inside`}
                value={p.storeUnitId}
                onChange={(e) => {
                  // Moved to a different container: the old one stops holding these.
                  setParent(p.storeUnitId, null, '');
                  setParent(e.target.value, u.storeUnitId, p.definedQty);
                }}
              >
                {[p, ...candidateParents(u)].map((x) => (
                  <option key={x.storeUnitId} value={x.storeUnitId}>
                    {x.name.toLowerCase()}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className={styles.remove}
                aria-label={`${u.plural} do not go inside a ${p.name.toLowerCase()}`}
                onClick={() => setParent(p.storeUnitId, null, '')}
              >
                <TrashIcon />
              </button>
            </div>
          ))}

          {/*
            Another container, when a shape goes in more than one — a bottle in a crate and in a
            pack. Only offered while there is something left to choose.
          */}
          {/*
            The row being answered: a count, and a container not yet chosen.
            It becomes real — and moves into the data — the moment a container is picked.
          */}
          {awaitingParent.includes(u.storeUnitId) && (
            <div className={styles.parentRow}>
              <Field
                label={`How many ${u.plural.toLowerCase()}`}
                numeric
                value={pendingQty[u.storeUnitId] ?? ''}
                onChange={(e) =>
                  setPendingQty((prev) => ({ ...prev, [u.storeUnitId]: e.target.value }))
                }
              />

              <span className={styles.parentJoin}>fit inside one</span>

              <select
                className={styles.select}
                aria-label={`What ${u.plural.toLowerCase()} go inside`}
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  setParent(e.target.value, u.storeUnitId, pendingQty[u.storeUnitId] ?? '');
                  setAwaitingParent((prev) => prev.filter((x) => x !== u.storeUnitId));
                  setPendingQty((prev) => ({ ...prev, [u.storeUnitId]: '' }));
                }}
              >
                <option value="">choose one…</option>
                {candidateParents(u).map((x) => (
                  <option key={x.storeUnitId} value={x.storeUnitId}>
                    {x.name.toLowerCase()}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className={styles.remove}
                aria-label="Cancel this one"
                onClick={() =>
                  setAwaitingParent((prev) => prev.filter((x) => x !== u.storeUnitId))
                }
              >
                <TrashIcon />
              </button>
            </div>
          )}

          {/*
            ANOTHER CONTAINER — a bottle in a crate AND in a pack.

            Shown whenever this shape is already in something, INCLUDING when there is nothing left
            to put it in. Gated on having a candidate, it was invisible on exactly the item where a
            shop would go looking for it: a crate and a bottle, linked, leaves the crate already
            holding the bottles and nothing else on the item — so the button appeared only AFTER a
            third shape had been added, which is the thing the shop would have needed the button to
            know it could do.

            Disabled says the capability exists and what it is waiting for. A missing control says
            neither, and reads as the form refusing.
          */}
          {parentsOf(u).length > 0 && !awaitingParent.includes(u.storeUnitId) && (
            <>
              <button
                type="button"
                className={styles.addParent}
                disabled={candidateParents(u).length === 0}
                onClick={() => setAwaitingParent((prev) => [...prev, u.storeUnitId])}
              >
                <PlusIcon /> They also go inside another
              </button>
              {candidateParents(u).length === 0 && (
                <p className={styles.addParentWhy}>
                  Add the shape first — anything else on this item can hold {u.plural.toLowerCase()}.
                </p>
              )}
            </>
          )}
        </div>
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
              SEVERAL AT ONCE, because a shop sells several at once.

              These were four buttons and one choice, so a beer shop that sells whole crates AND
              half crates could say only one of them — picking halves silently unpicked whole. Ticked
              together they mean 1, 1.5, 2, 2.5, which is what the crate actually sells as.

              "Any amount" is the exception and clears the rest: a thing that is weighed has no
              steps at all, and saying "weighed, and also halves" describes nothing.
            */}
            {(
              [
                ['Whole ones only', 'wholeDigit'],
                ['Halves too', 'allowHalf'],
                ['Quarters too', 'allowQuarter'],
                ['Three-quarters too', 'allowThreeQuarter'],
              ] as [string, 'wholeDigit' | 'allowHalf' | 'allowQuarter' | 'allowThreeQuarter'][]
            ).map(([label, key]) => {
              const on = Boolean(u[key]);
              return (
                <button
                  key={label}
                  type="button"
                  className={`${styles.choice} ${on ? styles.choiceOn : ''}`}
                  aria-pressed={on}
                  onClick={() =>
                    patch(u.storeUnitId, {
                      [key]: !on,
                      // Ticking any step means this is counted, not weighed.
                      ...(on ? {} : { wholeDigit: key === 'wholeDigit' ? true : u.wholeDigit }),
                    } as Partial<ProductUnit>)
                  }
                >
                  {label}
                </button>
              );
            })}

            <button
              type="button"
              className={`${styles.choice} ${!u.wholeDigit ? styles.choiceOn : ''}`}
              aria-pressed={!u.wholeDigit}
              onClick={() =>
                patch(u.storeUnitId, {
                  wholeDigit: !u.wholeDigit,
                  allowHalf: false,
                  allowQuarter: false,
                  allowThreeQuarter: false,
                })
              }
            >
              Any amount — it is weighed
            </button>
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

      <h2 className={styles.heading}>Shapes</h2>
      <p className={styles.headingNote}>
        Every shape this comes in — a crate, and the bottles inside it. Say what each holds, then
        tick what it is for. Everything else on this item reads these.
      </p>
      <ul className={styles.list}>{units.map(unitRow)}</ul>
      <button type="button" className={styles.add} onClick={() => setPicking('sold')}>
        <PlusIcon /> Add a shape
      </button>

      <UnitPicker
        open={picking !== null}
        onClose={() => setPicking(null)}
        units={storeUnits}
        /*
          Everything already on the item, because there is one list now.

          It used to exclude only shapes that were BOTH bought and sold — correct when the two
          lists were separate and a shape could legitimately appear in each. With one list, offering
          a shape the item already has is offering a duplicate.
        */
        taken={units.map((u) => u.storeUnitId)}
        title="What shape does this come in?"
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
