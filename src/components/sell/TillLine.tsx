'use client';

import styles from './TillLine.module.css';
import { CloseIcon, MinusIcon, PlusIcon } from '@/components/ui/Icon';
import { formatMoney, formatQtySpoken, pluralOfWord, shapeWord } from '@/lib/format';
import { partsFor, type QuantityRules } from '@/lib/quantity-rules';
import type { SaleUnit } from '@/lib/stacks/catalog-stack';
import type { SaleLineView } from './SaleLineRow';

/**
 * ONE LINE OF THE ORDER ON THE TILL — compact, so the whole order is in view.
 *
 * The full row (SaleLineRow) is a card a screen tall: a quantity box, a price box, the parts, the
 * total. Three items were three screens to scroll, and the seller lost sight of the order being
 * built. Here a line is the facts and the taps that change them — the shape, minus and plus, the
 * parts, the total — and nothing to type. Typing a number or a price is the line's own page
 * (`onOpen`, the sale-line page with that full row), one tap away on the quantity, the price or the
 * name.
 *
 * Same rules as the full row, from the same places: `partsFor` for what parts the shop sells, the
 * shape's own price on a shape change, and a reprice after every quantity or shape change.
 */
export function TillLine({
  line,
  shapes,
  rules,
  total,
  belowCost,
  needsCount = false,
  needsPrice = false,
  onPatch,
  onRemove,
  onStep,
  onReprice,
  onOpen,
  onCountNow,
  onPriceNow,
}: {
  line: SaleLineView;
  shapes: SaleUnit[];
  rules: QuantityRules;
  total: number;
  belowCost: boolean;
  needsCount?: boolean;
  needsPrice?: boolean;
  onPatch: (patch: Partial<SaleLineView> & Record<string, unknown>) => void;
  onRemove: () => void;
  onStep: (direction: 1 | -1) => void;
  onReprice: (qty: string, saleUnitId: string | null) => void | Promise<void>;
  /** The line's own page, to type a quantity, a price or the whole amount. */
  onOpen: () => void;
  onCountNow?: () => void;
  onPriceNow?: () => void;
}) {
  const qty = Number(line.qty);
  const safe = Number.isFinite(qty) && qty >= 0 ? qty : 0;
  const whole = Math.floor(safe);
  const part = Number((safe - whole).toFixed(4));
  const parts = partsFor(rules);
  const unit = line.saleUnitName ?? line.packName ?? line.baseUnit;
  // "½ crate" and "1 crate", but "0 crates" — nothing is said in the plural.
  const unitWord = (safe === 0 ? pluralOfWord(unit) : shapeWord(line.qty, unit)).toLowerCase();
  const empty = !(safe > 0);

  return (
    <div className={`${styles.line} ${empty ? styles.lineEmpty : ''}`}>
      <div className={styles.head}>
        <button type="button" className={styles.name} onClick={onOpen}>
          {line.productName}
        </button>
        <span className={`${styles.total} ${belowCost ? styles.below : ''}`}>{formatMoney(total)}</span>
        <button
          type="button"
          className={styles.remove}
          onClick={onRemove}
          aria-label={`Remove ${line.productName}`}
        >
          <CloseIcon />
        </button>
      </div>

      {(needsCount || needsPrice) && (
        <div className={styles.flags}>
          {needsCount && (
            <button type="button" className={styles.flag} onClick={() => onCountNow?.()}>
              Not counted today · Count
            </button>
          )}
          {needsPrice && (
            <button type="button" className={styles.flag} onClick={() => onPriceNow?.()}>
              No price yet · Set it
            </button>
          )}
        </div>
      )}

      {shapes.length > 1 && (
        <div className={styles.shapes} role="group" aria-label="How it is being sold">
          {shapes.map((u) => (
            <button
              key={u.id}
              type="button"
              className={`${styles.shape} ${line.saleUnitId === u.id ? styles.shapeOn : ''}`}
              aria-pressed={line.saleUnitId === u.id}
              onClick={() => {
                if (line.saleUnitId === u.id) return;
                // Each shape carries its own price; one with none stays empty so "No price yet" asks.
                onPatch({
                  saleUnitId: u.id,
                  saleUnitName: u.name,
                  saleUnitBaseQty: u.baseQty,
                  unitPrice: u.price ?? '',
                });
                void onReprice(line.qty, u.id);
              }}
            >
              {u.name}
            </button>
          ))}
        </div>
      )}

      <div className={styles.row}>
        <div className={styles.stepper}>
          <button
            type="button"
            className={styles.step}
            onClick={() => onStep(-1)}
            disabled={safe <= 0}
            aria-label={`One less ${line.productName}`}
          >
            <MinusIcon />
          </button>
          <button
            type="button"
            className={`${styles.qty} ${empty ? styles.qtyEmpty : ''}`}
            onClick={onOpen}
            aria-label={`${formatQtySpoken(safe)} ${unitWord} — type a quantity`}
          >
            <span className={styles.qtyFigure}>{formatQtySpoken(safe)}</span>
            <span className={styles.qtyUnit}>{unitWord}</span>
          </button>
          <button
            type="button"
            className={styles.step}
            onClick={() => onStep(1)}
            aria-label={`One more ${line.productName}`}
          >
            <PlusIcon />
          </button>
        </div>

        {parts.length > 0 && (
          <div className={styles.parts} role="group" aria-label="Add a part of one">
            {parts.map((f) => {
              const on = part === f.value;
              return (
                <button
                  key={f.label}
                  type="button"
                  className={`${styles.part} ${on ? styles.partOn : ''}`}
                  aria-pressed={on}
                  onClick={() => {
                    // Additive and toggleable, as on the full row: 2 then ½ is two and a half.
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
        )}

        <button type="button" className={styles.each} onClick={onOpen}>
          {line.unitPrice ? `${formatMoney(Number(line.unitPrice))} / ${unit.toLowerCase()}` : 'Set price'}
        </button>
      </div>

      {empty && (
        <p className={styles.ask}>
          {parts.length > 0 ? 'How many? Tap + or a part.' : 'How many? Tap +, or remove it.'}
        </p>
      )}
    </div>
  );
}
