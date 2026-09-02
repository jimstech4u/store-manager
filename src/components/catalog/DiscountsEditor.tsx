'use client';

import { useState } from 'react';
import { Field } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { Explain } from '@/components/ui/Explain';
import { formatMoney } from '@/lib/format';
import type { ProductUnit } from '@/lib/stacks/product-units';
import { TrashIcon, PlusIcon } from '@/components/ui/Icon';
import styles from './DiscountsEditor.module.css';

/**
 * Cheaper when they buy more.
 *
 * The till has honoured these since price tiers were built — a line's price drops on its own when
 * the quantity crosses a band, and says why. Nothing anywhere let a shop SET one, so the only
 * tiers in existence got there through SQL.
 *
 * SAID AS A SENTENCE, because the underlying row is three numbers and a foreign key and nobody
 * thinks in those: "5 or more packs — ₦4,500 each". The unit matters and is not decoration — a
 * shop selling crates and bottles has different bands for each, and a discount without a unit is
 * a discount that could halve the wrong one.
 *
 * ONE COMPOSER, per the rule the delivery screen also follows: a fixed row of boxes per possible
 * band is a screen full of empty fields for the ones that do not apply.
 */

export interface Discount {
  /** Existing row when it has one; null while it is only on screen. */
  id: string | null;
  /** The SOLD unit this band applies to. */
  storeUnitId: string;
  minQty: string;
  /** Empty means "and upwards", which is what most shops mean by a bulk price. */
  maxQty: string;
  price: string;
}

export function DiscountsEditor({
  discounts,
  setDiscounts,
  soldUnits,
}: {
  discounts: Discount[];
  setDiscounts: (next: Discount[]) => void;
  /** Only units a customer can actually buy — a band on something unsellable is unreachable. */
  soldUnits: ProductUnit[];
}) {
  const [unitId, setUnitId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [price, setPrice] = useState('');

  const chosen = soldUnits.find((u) => u.storeUnitId === (unitId || soldUnits[0]?.storeUnitId));
  const nameOf = (id: string) => soldUnits.find((u) => u.storeUnitId === id);

  const fromQty = Number(from);
  const toQty = to.trim() === '' ? null : Number(to);
  const amount = Number(price);

  const ready =
    Boolean(chosen) &&
    Number.isFinite(fromQty) &&
    fromQty > 0 &&
    Number.isFinite(amount) &&
    amount > 0 &&
    (toQty === null || (Number.isFinite(toQty) && toQty >= fromQty));

  /*
   * Warned when a band is not cheaper than the ordinary price.
   *
   * Not blocked: a shop may genuinely charge more for an odd quantity, and a form that refuses
   * what somebody meant is worse than one that asks whether they meant it.
   */
  const dearer = chosen?.sellPrice.trim() !== '' && amount > Number(chosen?.sellPrice);

  const add = () => {
    if (!chosen || !ready) return;
    setDiscounts([
      ...discounts,
      {
        id: null,
        storeUnitId: chosen.storeUnitId,
        minQty: String(fromQty),
        maxQty: toQty === null ? '' : String(toQty),
        price: String(amount),
      },
    ]);
    setFrom('');
    setTo('');
    setPrice('');
  };

  if (soldUnits.length === 0) {
    return (
      <p className={styles.none}>
        Say what a customer can buy first, then you can set a cheaper price for buying more.
      </p>
    );
  }

  return (
    <>
      <Explain label="What is this for?">
        <p>
          A customer taking five packs often pays less each than one taking a single pack. Set the
          band here and the till applies it on its own when the quantity reaches it — and tells the
          seller why the price changed, so they can say it out loud.
        </p>
      </Explain>

      {discounts.length > 0 && (
        <ul className={styles.list}>
          {discounts.map((d, i) => {
            const u = nameOf(d.storeUnitId);
            const many = u ? u.plural.toLowerCase() : 'of them';
            return (
              <li key={d.id ?? `new-${i}`} className={styles.row}>
                <span className={styles.sentence}>
                  <strong>
                    {d.minQty}
                    {d.maxQty.trim() === '' ? ' or more' : `–${d.maxQty}`} {many}
                  </strong>
                  <span className={styles.each}>{formatMoney(Number(d.price))} each</span>
                </span>
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Remove the ${d.minQty}${d.maxQty ? `–${d.maxQty}` : '+'} ${many} price`}
                  onClick={() => setDiscounts(discounts.filter((_, n) => n !== i))}
                >
                  <TrashIcon />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* One set of boxes. The shop names the band as it adds it. */}
      {soldUnits.length > 1 && (
        <label className={styles.unitChoice}>
          <span className={styles.unitChoiceLabel}>When they buy</span>
          <select
            className={styles.select}
            value={unitId || soldUnits[0]?.storeUnitId}
            onChange={(e) => setUnitId(e.target.value)}
          >
            {soldUnits.map((u) => (
              <option key={u.storeUnitId} value={u.storeUnitId}>
                {u.plural}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className={styles.grid}>
        {/*
          The unit is in the LABEL, not in a suffix.

          A suffix box is a fixed slot beside a number, and "FCrates457287" was clipped to
          "rates4572" — which reads as a different word. The label has the whole width of the
          field and wraps.
        */}
        <Field
          label={`From how many ${chosen?.plural.toLowerCase() ?? 'of them'}?`}
          numeric
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="5"
          hint="Where the cheaper price starts."
        />
        <Field
          label="Up to"
          optional
          numeric
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Any"
          hint="Empty means “and upwards”."
        />
      </div>

      <Field
        label={`Price for one ${chosen?.name.toLowerCase() ?? 'unit'} at that quantity`}
        numeric
        prefix="₦"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        placeholder="0"
        error={
          dearer
            ? `That is more than the ordinary ${formatMoney(Number(chosen?.sellPrice))}. Is that meant?`
            : null
        }
      />

      <Button fullWidth disabled={!ready} onClick={add}>
        <PlusIcon /> Add this price
      </Button>
    </>
  );
}
