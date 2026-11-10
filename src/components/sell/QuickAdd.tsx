'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { StateStack } from '@academix-admin/state-stack';
import styles from './QuickAdd.module.css';
import { Button } from '@/components/ui/Button';
import { CameraIcon, CloseIcon, PlusIcon, SearchIcon } from '@/components/ui/Icon';
import { useDebounced } from '@/components/ui/SearchField';
import { useProductSearch, type Product } from '@/lib/stacks/catalog-stack';
import { pricedUnit, stockInShapes, useSellingUnits } from '@/lib/stacks/selling-units';
import { formatMoney, formatQtySpoken, pluralUnit, shapeWord } from '@/lib/format';
import { parseQuickAdd } from '@/lib/quick-add';

/** How many results are offered under the box. A search is for finding one thing, not browsing. */
const SHOWN = 6;

/**
 * THE TILL'S ONE BOX — type what they are buying, and it goes on the order.
 *
 * "fewer clicks, less navigation." Adding was a button, a sheet, a search inside the sheet, a tap on
 * a row with no price on it, and then the quantity fixed on the line: five steps per item. Here the
 * box is on the till itself, a number in front says how many ("3 b/s" — the shop's own words find
 * the item, 0269), each result says its price and what is left, and Enter takes the first. The box
 * empties and keeps the keyboard, ready for the next thing they ask for.
 *
 * ONE INPUT, not a form: the composer the rest of the app uses. What it adds is listed with the order.
 * A result is a choice, so it is a row of the list under the box — never a sheet with a box in it.
 */
export function QuickAdd({
  storeId,
  onAdd,
  onScan,
  onAddNew,
  onFocus,
}: {
  storeId: string;
  /** Told when the box is tapped, with the box, so the page can bring it into view above the keyboard. */
  onFocus?: (box: HTMLElement) => void;
  /** Put it on the order. `qty` is what was typed in front of it, or null when nothing was. */
  onAdd: (product: Product, qty: number | null) => Promise<void> | void;
  onScan: () => void;
  /** Offered when nothing matches; left out where the person may not create items. */
  onAddNew?: (typed: string) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState('');
  const { qty, term } = parseQuickAdd(text);
  const debounced = useDebounced(term.trim());
  const searching = debounced !== '';

  const { products, status } = useProductSearch(storeId, searching ? debounced : null);
  const { byProduct } = useSellingUnits(storeId);
  const shown = products.slice(0, SHOWN);
  const settling = term.trim() !== debounced || (status === 'loading' && shown.length === 0);

  /*
   * The answers go with the question, as the picker does: every term typed is filed under its own
   * key in `search_flow`, and a till that served forty customers would carry forty of them.
   */
  useEffect(() => {
    if (text === '') void StateStack.core.clearScope('search_flow');
  }, [text]);

  const add = async (product: Product) => {
    setText('');
    await onAdd(product, qty);
    // The keyboard stays up for the next thing they ask for, and the box, now a line further down,
    // comes back up — with the line just added above it, in view (the till's `bringUnderBar`).
    inputRef.current?.focus();
    if (boxRef.current) onFocus?.(boxRef.current);
  };

  /** "3 crates", "½ crate" — what the first result's Add will put on, in the item's own shape. */
  const howMany = (product: Product) => {
    if (qty === null) return 'Add';
    const shape = pricedUnit(byProduct.get(product.id));
    const word = shape
      ? shapeWord(String(qty), shape.name, shape.plural)
      : pluralUnit(product.baseUnit, qty);
    return `Add ${formatQtySpoken(qty)} ${word.toLowerCase()}`;
  };

  return (
    <div ref={boxRef} className={styles.box}>
      <div className={styles.field}>
        <span className={styles.icon} aria-hidden="true">
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          id={id}
          className={styles.input}
          type="search"
          inputMode="search"
          enterKeyHint="go"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => boxRef.current && onFocus?.(boxRef.current)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            // Only what is on screen for what was typed — never the previous term's first row.
            if (!settling && shown[0]) void add(shown[0]);
          }}
          placeholder="Type to add — e.g. 3 b/s"
          aria-label="Add an item: how many, then what"
          aria-describedby={text ? `${id}-said` : undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        {text !== '' ? (
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              setText('');
              inputRef.current?.focus();
            }}
            aria-label="Clear"
          >
            <CloseIcon />
          </button>
        ) : (
          <button type="button" className={styles.action} onClick={onScan} aria-label="Scan a barcode">
            <CameraIcon />
          </button>
        )}
      </div>

      {qty !== null && (
        <p id={`${id}-said`} className={styles.said}>
          <strong>{formatQtySpoken(qty)}</strong> of <strong>{term}</strong>
        </p>
      )}

      {searching && (
        <div className={styles.results} role="listbox" aria-label="Items that match">
          {shown.map((p, i) => {
            const shapes = byProduct.get(p.id);
            const priced = pricedUnit(shapes);
            const price =
              priced?.price != null
                ? `${formatMoney(priced.price)} a ${priced.name.toLowerCase()}`
                : p.listPrice
                  ? formatMoney(p.listPrice)
                  : 'No price yet';
            const left =
              shapes && shapes.length > 0
                ? stockInShapes(shapes)
                : `${formatQtySpoken(p.onHand)} ${pluralUnit(p.baseUnit, Number(p.onHand))}`;
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={i === 0}
                className={`${styles.result} ${i === 0 && !settling ? styles.first : ''}`}
                onClick={() => void add(p)}
              >
                <span className={styles.top}>
                  <span className={styles.name}>{p.name}</span>
                  <span className={styles.price}>{price}</span>
                </span>
                <span className={styles.bottom}>
                  <span className={styles.left}>{left} left</span>
                  {i === 0 && !settling && <span className={styles.enter}>{howMany(p)} ↵</span>}
                </span>
              </button>
            );
          })}

          {settling && shown.length === 0 && <p className={styles.note}>Looking…</p>}
          {!settling && status === 'error' && <p className={styles.note}>That search did not go through. Type again to retry.</p>}
          {!settling && status !== 'error' && shown.length === 0 && (
            <p className={styles.note}>Nothing in the shop is called “{term}”.</p>
          )}
          {/*
            MAKING IT NEW is the answer when nothing matched, so then it is the big green button;
            beside results it is a quiet link, or it outshouts the item that was found.
          */}
          {!settling && onAddNew && shown.length === 0 && (
            <Button fullWidth onClick={() => onAddNew(term.trim())}>
              <PlusIcon /> Add “{term.trim()}” to your shop
            </Button>
          )}
          {!settling && onAddNew && shown.length > 0 && (
            <button type="button" className={styles.addNew} onClick={() => onAddNew(term.trim())}>
              <PlusIcon /> Not here? Add “{term.trim()}” to your shop
            </button>
          )}
        </div>
      )}
    </div>
  );
}
