'use client';

import { useState } from 'react';
import styles from './SaleLineRow.module.css';
import { Field } from '@/components/ui/Field';
import { CloseIcon, MinusIcon, PlusIcon } from '@/components/ui/Icon';
import { formatMoney, formatQty } from '@/lib/format';
import { partsFor, snapQty, type QuantityRules } from '@/lib/quantity-rules';
import type { SaleUnit } from '@/lib/stacks/catalog-stack';

/**
 * ONE LINE ON A RECEIPT BEING BUILT — the till's row, and the correction screen's.
 *
 * It was the sell page's, inline, and correcting a settled receipt could only change how many and
 * at what price on the lines already there. A crate that went out and never reached the receipt had
 * no path at all. Making the correction screen work like the till meant either sharing this or
 * writing it twice, and the second copy would have drifted within a month: this row carries the
 * shape chips, the stepper, the snapping, the fractions, the bulk-price explanation and the
 * tap-the-total-to-set-it behaviour, every one of them a decision somebody made for a reason.
 *
 * WHAT IT DOES NOT KNOW: which sale it is on, whether there is a draft behind it, or how a price is
 * worked out. It reports what was touched and is told what to show. That is what lets the till hand
 * it a draft line and the correction screen hand it a line off a settled receipt.
 *
 * The JSX was moved verbatim rather than rewritten, and only the closures over the sell page became
 * props — retyping a screen this tuned is how two copies come to disagree.
 */
export interface SaleLineView {
  key: string;
  productId: string;
  productName: string;
  saleUnitId: string | null;
  saleUnitName: string | null;
  qty: string;
  unitPrice: string;
  baseUnit: string;
  /**
   * The shape's own word for the unit, when the item has no sale unit — an older one-pack-per-item
   * idea that some rows still carry. Read only for the suffix beside the quantity.
   */
  packName?: string | null;
  /** Once the seller has typed a price, nothing may quietly replace it. */
  priceTouched?: boolean;
  /**
   * Why the price on screen appeared, when it was not typed. Widened to a string because the till's
   * own line type is: the row shows a sentence for the two it knows and nothing for anything else,
   * which is the right behaviour for a reason it has not been taught yet.
   */
  priceReason?: string | null;
}

export function SaleLineRow({
  line,
  shapes,
  rules,
  total,
  belowCost,
  needsCount = false,
  onPatch,
  onRemove,
  onStep,
  onReprice,
  onCountNow,
}: {
  line: SaleLineView;
  /** Every shape this item can be sold in. One or none hides the chips. */
  shapes: SaleUnit[];
  rules: QuantityRules;
  total: number;
  belowCost: boolean;
  needsCount?: boolean;
  onPatch: (patch: Partial<SaleLineView> & Record<string, unknown>) => void;
  onRemove: () => void;
  onStep: (direction: 1 | -1) => void;
  /**
   * The quantity or the shape changed, so whatever works out a price gets to run again.
   *
   * A promise, and deliberately not awaited by the row: a bulk band is a round trip, and a stepper
   * that waited for one before redrawing would feel broken on a slow connection.
   */
  onReprice: (qty: string, saleUnitId: string | null) => void | Promise<void>;
  /** Only called when `needsCount`; the row does not know what counting involves. */
  onCountNow?: () => void;
}) {
  /*
   * WHETHER THIS ROW'S TOTAL IS BEING TYPED INTO, held here.
   *
   * The sell page held one `editingTotal` keyed by line, which is the same thing said in a way that
   * makes the parent carry state about its children. A row only ever edits its own.
   */
  const [editingTotal, setEditingTotal] = useState(false);
  const [totalDraft, setTotalDraft] = useState('');

  return (
    <div className={styles.line} key={line.key}>
      <div className={styles.lineHead}>
        {/* Just the name. The base-unit total ("12 pieces in total") used to sit
            here and was read as a second quantity to check against the one being
            entered — two numbers for one line, with nothing saying which mattered. */}
        <p className={styles.lineName}>
          {line.productName}
          {/*
            NOT COUNTED TODAY, on the line itself. The note above says how many; this
            says which — and one tap counts exactly this item.
          */}
          {needsCount && (
            <button
              type="button"
              className={styles.countChip}
              onClick={() => onCountNow?.()}
            >
              Not counted today · Count
            </button>
          )}
        </p>
        <button
          type="button"
          className={styles.lineRemove}
          onClick={() => onRemove()}
          aria-label={`Remove ${line.productName}`}
        >
          <CloseIcon />
        </button>
      </div>

      {(shapes?.length ?? 0) > 1 && (
        <div className={styles.unitBlock}>
          <span className={styles.unitLabel}>Selling as</span>
          <div className={styles.unitRow} role="group" aria-label="How it is being sold">
          {shapes.map((u) => (
            <button
              key={u.id}
              type="button"
              className={`${styles.unit} ${
                line.saleUnitId === u.id ? styles.unitActive : ''
              }`}
              aria-pressed={line.saleUnitId === u.id}
              onClick={() => {
                onPatch({
                  saleUnitId: u.id,
                  saleUnitName: u.name,
                  saleUnitBaseQty: u.baseQty,
                  // Switching shape switches price: each shape carries its own,
                  // and keeping the previous one would quietly sell a half pack
                  // at the full pack price.
                  unitPrice: u.price ?? line.unitPrice,
                });
                // ...then let any bulk band for the NEW shape apply on top.
                void onReprice(line.qty, u.id);
              }}
            >
              {u.name}
            </button>
          ))}
          </div>
        </div>
      )}

      <div className={styles.lineGrid}>
        <div className={styles.stepper}>
          <button
            type="button"
            className={styles.stepperButton}
            onClick={() => onStep(-1)}
            disabled={Number(line.qty) <= 0}
            aria-label={`One less ${line.productName}`}
          >
            <MinusIcon />
          </button>
          <div className={styles.stepperField}>
            <Field
              label="Quantity"
              numeric
              value={line.qty}
              onChange={(e) => {
                // Typed freely while the keyboard is up: snapping mid-word would
                // fight somebody halfway through "4.5" by rewriting "4." to "4".
                onPatch({
                  qty: e.target.value,
                });
                void onReprice(e.target.value, line.saleUnitId);
              }}
              onBlur={() => {
                /*
                 * SNAPPED WHEN THEY LOOK AWAY, not while they type.
                 *
                 * A shop selling half crates gets 4.3 typed at it now and then —
                 * they meant 4.5, and 4.3 is a line the database refuses at the
                 * worst possible moment, after the money has been counted. Rounded
                 * to the NEAREST step, because somebody who overshoots slightly
                 * meant the figure they were reaching for.
                 */
                const typed = Number(line.qty);
                if (!Number.isFinite(typed)) return;

                const snapped = snapQty(typed, rules);
                if (snapped === typed) return;

                onPatch({
                  qty: String(snapped),
                });
                void onReprice(String(snapped), line.saleUnitId);
              }}
              suffix={line.saleUnitName ?? line.packName ?? line.baseUnit}
              error={
                Number(line.qty) > 0
                  ? null
                  : partsFor(rules).length > 0
                    ? // Starting at nothing is deliberate for a unit sold in parts:
                      // there is no safe default, and half a crate recorded as a
                      // whole one is a real loss.
                      'Say how many — tap a part below, or use +'
                    : 'Add a quantity, or remove this item'
              }
            />
          </div>
          <button
            type="button"
            className={styles.stepperButton}
            onClick={() => onStep(1)}
            aria-label={`One more ${line.productName}`}
          >
            <PlusIcon />
          </button>
        </div>

        {(() => {
          /*
           * Part-amounts on top of the whole number in the stepper.
           *
           * OFFERED ONLY WHEN THEY LAND ON WHOLE BASE UNITS. A quarter of a 12-piece
           * pack is 3 pieces and is real; a quarter of a single bottle is not, and
           * the database rejects it — so the guard belongs here too rather than
           * letting the seller build a line that cannot be settled.
           */
          /*
           * WHAT THIS SHOP SELLS, not what divides evenly.
           *
           * The old rule offered a fraction whenever it landed on whole base units,
           * so a shop selling half crates of Gulder was offered quarters and
           * three-quarters too — twelve divides by four — and each was a way to
           * record something it cannot deliver. The shop states its parts once on
           * the unit and the till obeys.
           */
          const options = partsFor(rules);
          if (options.length === 0) return null;

          const current = Number(line.qty);
          const safe = Number.isFinite(current) && current >= 0 ? current : 0;
          const whole = Math.floor(safe);
          // Rounded before comparing: 2.5 - 2 is not exactly 0.5 in binary floating
          // point, and an un-rounded compare leaves the button that IS selected
          // looking unselected.
          const part = Number((safe - whole).toFixed(4));

          return (
            <div className={styles.fractionBlock}>
              <span className={styles.fractionLabel}>
                Add a part{part > 0 ? ` — now ${formatQty(safe)}` : ''}
              </span>
              <div
                className={styles.fractionRow}
                role="group"
                aria-label="Add a part of one to the quantity"
              >
                {options.map((f) => {
                  const on = part === f.value;
                  return (
                    <button
                      key={f.label}
                      type="button"
                      className={`${styles.fraction} ${on ? styles.fractionActive : ''}`}
                      aria-pressed={on}
                      onClick={() => {
                        // Tapping the selected part removes it and leaves the whole
                        // number behind.
                        const next = String(on ? whole : whole + f.value);
                        onPatch({ qty: next });
                        void onReprice(next, line.saleUnitId);
                      }}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}

        <Field
          label={line.saleUnitName ? `Price per ${line.saleUnitName.toLowerCase()}` : 'Price each'}
          numeric
          prefix="₦"
          value={line.unitPrice}
          onChange={(e) =>
            onPatch({
              unitPrice: e.target.value,
              // From here on, this line keeps the seller's own figure.
              priceTouched: true,
              priceReason: null,
            })
          }
          error={belowCost ? 'Below what this cost you' : null}
          /*
           * Say why this figure appeared. A price that changes on its own when the
           * quantity crosses a band looks like a glitch unless it explains itself —
           * and the seller needs to be able to tell the customer what they are
           * getting, which is half the point of offering a bulk price at all.
           */
          hint={
            line.priceTouched
              ? 'Your own price'
              : line.priceReason === 'bulk'
                ? 'Bulk price for this quantity'
                : line.priceReason === 'customer'
                  ? "This customer's agreed price"
                  : undefined
          }
        />
      </div>

      {/*
        THE FIGURE THE CUSTOMER ACTUALLY AGREED TO.

        Haggling in a Nigerian market happens on the total, not the unit price:
        "give me the four crates for thirty-five thousand". Until now the only box
        on the screen was price-per-crate, so a seller had to divide 35,000 by 4 at
        the counter with somebody waiting — and 8,750 is one of the kinder examples.
        A price typed here divides itself, and the line still warns if the result is
        below what the stock cost.
      */}
      <div className={styles.lineTotal}>
        {editingTotal ? (
          <Field
            label="Total for this line"
            numeric
            prefix="₦"
            autoFocus
            value={totalDraft}
            onChange={(e) => setTotalDraft(e.target.value)}
            onBlur={() => {
              const asked = Number(totalDraft);
              const qty = Number(line.qty);
              setEditingTotal(false);

              // Nothing usable typed, or no quantity to divide by: the line keeps
              // the price it had rather than being handed a zero or an infinity.
              if (
                !Number.isFinite(asked) ||
                asked < 0 ||
                !Number.isFinite(qty) ||
                qty <= 0
              ) {
                return;
              }

              onPatch({
                // Kobo, because a total that will not divide evenly still has to
                // multiply back to something near what was agreed.
                unitPrice: String(Number((asked / qty).toFixed(2))),
                priceTouched: true,
                priceReason: null,
              });
            }}
            hint={`Split across ${formatQty(Number(line.qty) || 0)} ${
              line.saleUnitName?.toLowerCase() ?? line.baseUnit
            }`}
          />
        ) : (
          <>
            <span>Line total</span>
            <button
              type="button"
              className={`${styles.lineTotalValue} ${belowCost ? styles.belowCost : ''}`}
              onClick={() => {
                setTotalDraft(String(total || ''));
                setEditingTotal(true);
              }}
              aria-label={`Line total ${formatMoney(total)} — tap to set the whole amount`}
            >
              {formatMoney(total)}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
