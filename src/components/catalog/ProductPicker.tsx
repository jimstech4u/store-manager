'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { SelectionViewer, useSelectionController } from '@academix-admin/selection-viewer';
import { ViewerLoading } from '@/components/ui/ViewerState';
import { InfoPanel } from '@/components/ui/Explain';
import { Button } from '@/components/ui/Button';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { StateStack } from '@academix-admin/state-stack';
import { useDebounced } from '@/components/ui/SearchField';
import { useOverlayRoute } from '@academix-admin/navigation-stack';
import { useTheme } from '@/context/ThemeContext';
import { useProductSearch, type Product } from '@/lib/stacks/catalog-stack';
import { stockInShapes, useSellingUnits } from '@/lib/stacks/selling-units';
import { formatMoney, formatQtySpoken, pluralUnit } from '@/lib/format';
import { usePermission } from '@/hooks/usePermission';
import styles from './ProductPicker.module.css';

/**
 * Choosing an item you sell — ONE picker, wherever the question is asked.
 *
 * The sell screen and the delivery screen both ask "which item?", and they used to answer it in
 * two different ways: a `SelectionViewer` on one, a `BottomSheet` wrapped round a `SearchField` on
 * the other. The sheet version was the worse one in every way that shows up on a phone — it did
 * not stay above the keyboard, it closed on a stray touch while typing, and its list had no
 * loading or error state at all, so a slow search looked like a shop with no products.
 *
 * It was also just a second implementation of a thing that already worked. Two answers to one
 * question drift: the sell screen learned to offer "add this to your shop" from an empty result
 * and the delivery screen did not, so the same dead end had a way out in one place and not the
 * other. This is that component, once.
 *
 * Deliberately NOT a page, unlike the forms that moved. A picker is a choice, not a form: no
 * typing to lose, no draft to preserve, and it is opened from the middle of something else that
 * must stay exactly as it was. That is what a sheet is for.
 */
export function ProductPicker({
  open,
  onClose,
  storeId,
  onPick,
  title = 'Add an item',
  /**
   * The way out of an empty result. Omitted where the caller cannot create products — a delivery
   * of something the shop has never sold is a catalogue job, not a receiving job.
   */
  onAddNew,
  /** What each row says beneath the name. Deliveries care about stock; sales care about price. */
  renderMeta,
  emptyHint = 'Try part of the name, or a category like “water”.',
  zIndex = 1000,
}: {
  open: boolean;
  onClose: () => void;
  storeId: string;
  onPick: (product: Product) => void;
  title?: string;
  onAddNew?: (typedName: string) => void;
  renderMeta?: (product: Product) => ReactNode;
  emptyHint?: string;
  zIndex?: number;
}) {
  // Creating an item is offered only to somebody who may (products.manage) — checked here, once.
  const { canOpen } = usePermission();
  const addNew = onAddNew && canOpen('product_form_page') ? onAddNew : undefined;
  const { theme } = useTheme();
  const dark = theme === 'dark';

  const [id, ops, isOpen] = useSelectionController();
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);

  /*
   * The controller owns whether the sheet is up; `open` is the caller's intent. Kept in step here
   * rather than in every caller — and in an effect, because opening a sheet is a side effect and
   * doing it during render makes React render twice and the sheet flicker on the way in.
   */
  useEffect(() => {
    if (open && !isOpen) ops.open();
    if (!open && isOpen) ops.close();
  }, [open, isOpen, ops]);

  const { products, status, loadMore, hasMore } = useProductSearch(
    storeId,
    open ? debounced : null,
  );

  /*
   * The shop's shapes, so a result can say "5 crates 6 bottles" rather than "66 pieces".
   *
   * The same cached read every other catalogue screen uses — one key, one shape — so opening the
   * picker costs nothing a shop has not already paid for.
   */
  const { byProduct } = useSellingUnits(storeId);

  const close = () => {
    ops.close();
    setQuery('');

    /*
     * The answers go with the question.
     *
     * Search results are kept while the picker is open — reopening it mid-sale should not re-ask
     * the same thing — but a closed picker has finished asking, and every term anybody typed is
     * filed under its own key. Left alone they accumulate for the life of the session: a seller
     * who has served forty customers is carrying forty searches nobody will read again.
     */
    void StateStack.core.clearScope('search_flow');

    onClose();
  };

  /*
   * Back closes the PICKER, not the page underneath it.
   *
   * This lived on the sell page and did not come along when the picker was extracted, so opening
   * it from the delivery screen and pressing Back left the delivery entirely — taking a
   * half-entered delivery with it. It belongs here, so every consumer gets it rather than each
   * remembering to add it.
   *
   * Named per instance: two pickers mounted at once (a sell screen and a delivery behind it) must
   * not share one history entry.
   */
  useOverlayRoute(`picker:${id}`, isOpen, close);


  return (
    <SelectionViewer
      id={id}
      isOpen={isOpen}
      onClose={close}
      titleProp={{ text: title, textColor: dark ? '#f2f5f4' : '#12201d' }}
      // Announced by name. Without it a screen reader says only "dialog", which tells somebody
      // that the screen has been taken over and nothing about what by.
      ariaLabel={title}
      cancelButton={{ position: 'right', onClick: close, view: <CloseIcon size="1.3em" /> }}
      searchProp={{
        text: 'Search products or a category',
        onChange: setQuery,
        /*
         * THE KEYBOARD COMES UP WITH THE SHEET.
         *
         * A picker is opened to type in — nobody taps "search products" in order to look at a
         * list they could already see. This was false in all six pickers, with no note saying
         * why, so every search cost an extra tap on the one control the sheet exists for.
         */
        autoFocus: true,
        textColor: dark ? '#f2f5f4' : '#12201d',
        background: dark ? '#1b2322' : '#eef2f1',
        padding: { l: '4px', r: '4px', t: '0px', b: '0px' },
      }}
      loadingProp={{ view: <ViewerLoading text="Searching" /> }}
      noResultProp={{
        view: (
          <div className={styles.empty}>
            <InfoPanel tone="info" title="Nothing found">
              {emptyHint}
            </InfoPanel>
            {/*
              The most useful moment to add a product is the one where the shop is being asked for
              something it has never entered. Sending somebody elsewhere here means abandoning a
              half-built receipt or a half-entered delivery, so the form comes to them.
            */}
            {addNew && (
              <Button
                size="large"
                fullWidth
                onClick={() => addNew(query.trim())}
              >
                <PlusIcon /> Add &ldquo;{query.trim() || 'a new item'}&rdquo; to your shop
              </Button>
            )}
          </div>
        ),
      }}
      layoutProp={{
        backgroundColor: dark ? '#121817' : '#ffffff',
        handleColor: dark ? '#3a4443' : '#c8d2d0',
        handleWidth: '48px',
        gapBetweenHandleAndTitle: '12px',
        gapBetweenTitleAndSearch: '8px',
        gapBetweenSearchAndContent: '12px',
      }}
      /*
       * The next 50 as the list is scrolled — the customer picker has always done this; this one
       * stopped at 50 (0223).
       */
      onPaginate={() => {
        loadMore();
        return hasMore;
      }}
      childrenDirection="vertical"
      snapPoints={[0, 1]}
      initialSnap={1}
      minHeight="60dvh"
      maxHeight="92dvh"
      closeThreshold={0.2}
      /*
        SETTLING IS NOT EMPTY.

        "search view and selection viewer shows empty for a search result for a brief before
        actually showing the record even if it is the same match by name."

        Two gaps produced that flash. Between a keystroke and the debounce firing, the results on
        screen belong to the PREVIOUS term; and the instant the new term lands, its results have
        not been fetched, so the list is legitimately empty for a frame. Neither is "nothing
        matched" — both are "we have not looked yet", and saying so is the difference between a
        sheet that feels slow and one that looks wrong.
      */
      selectionState={
        (status === 'loading' || query !== debounced) && products.length === 0
          ? 'loading'
          : status === 'error'
            ? 'error'
            : products.length === 0
              ? 'empty'
              : 'data'
      }
      zIndex={zIndex}
    >
      {/*
        ADDING IS OFFERED BEFORE THE LIST, not only after it fails.

        It used to live in the no-result view alone, so a seller had to search for something and be
        told it does not exist before the way to add it appeared. The customer picker has always
        put it at the top; this is the same list of the same kind of thing and should behave the
        same way.
      */}
      {addNew && (
        <button type="button" className={styles.addRow} onClick={() => addNew(query.trim())}>
          <PlusIcon /> {query.trim() ? `Add "${query.trim()}"` : 'Add something new'}
        </button>
      )}

      <div className={styles.list}>
        {products.map((p) => (
          <button
            key={p.id}
            type="button"
            className={styles.item}
            onClick={() => {
              close();
              onPick(p);
            }}
          >
            <span className={styles.name}>{p.name}</span>
            <span className={styles.meta}>
              {renderMeta ? (
                renderMeta(p)
              ) : (
                <>
                  {/*
                    WHAT IS LEFT, IN THE SHAPES THE SHOP COUNTS IN.

                    This said "66 pieces left" for five crates and six bottles. True, and not a
                    sentence anybody at a counter uses — they are choosing between crates. The
                    stock list has said it in shapes for a while; the picker, which is where the
                    figure is actually read during a sale, was still on base units.
                  */}
                  {(() => {
                    const shapes = byProduct.get(p.id);
                    return shapes && shapes.length > 0
                      ? stockInShapes(shapes)
                      : `${formatQtySpoken(p.onHand)} ${pluralUnit(p.baseUnit, Number(p.onHand))}`;
                  })()}{' '}
                  left
                  {p.categoryName ? ` · ${p.categoryName}` : ''}
                  {p.listPrice ? ` · ${formatMoney(p.listPrice)}` : ''}
                </>
              )}
            </span>
          </button>
        ))}
      </div>
    </SelectionViewer>
  );
}
