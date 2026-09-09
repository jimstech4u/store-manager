'use client';

import { useMemo, useState } from 'react';
import { SelectionViewer } from '@academix-admin/selection-viewer';
import { useOverlayRoute } from '@academix-admin/navigation-stack';
import { CheckIcon, CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { ViewerNoResult } from '@/components/ui/ViewerState';
import { useTheme } from '@/context/ThemeContext';
import type { ProductGroup } from '@/lib/stacks/product-groups';
import styles from './GroupPicker.module.css';

/**
 * Which groups a product is in — NBL, Guinness, Beer, PET.
 *
 * MULTI-SELECT, unlike every other picker in the app, and that is the point: a product belongs to
 * several groupings at once and each answers a different question. So this stays open while things
 * are ticked rather than closing on the first tap, and closes the way every other sheet here does —
 * the cross, a swipe down, or Back. Each tick is already saved onto the form behind it, so there is
 * nothing to confirm and a button saying "Done" would only be asking permission to stop.
 *
 * Adding is offered BEFORE the list, the way the customer and product pickers do it. Somebody
 * typing "NBL" into the box is usually about to find out it does not exist yet, and sending them to
 * a settings screen to make one means abandoning the product they were half way through entering.
 */
export function GroupPicker({
  id,
  isOpen,
  close,
  groups,
  chosen,
  onToggle,
  onAddNew,
  zIndex,
}: {
  id: string;
  isOpen: boolean;
  close: () => void;
  groups: ProductGroup[];
  chosen: string[];
  onToggle: (groupId: string) => void;
  /** Given whatever was typed, so "NBL" in the search box becomes the name of the new group. */
  onAddNew: (typedName: string) => void;
  zIndex?: number;
}) {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const [query, setQuery] = useState('');

  /*
   * Named per instance: the product form can be pushed over another one, and two pickers mounted at
   * once must not share a history entry — a Back press would close whichever the ledger happened to
   * find first.
   */
  useOverlayRoute(`groups:${id}`, isOpen, close);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups;
    /*
     * Chosen first, then the ones the shop actually uses.
     *
     * A list of twenty groups in alphabetical order makes somebody hunt for the four they have
     * already ticked, and the whole reason this is multi-select is that the answer is several.
     */
    return [...matching].sort((a, b) => {
      const picked = Number(chosen.includes(b.id)) - Number(chosen.includes(a.id));
      return picked !== 0 ? picked : b.products - a.products;
    });
  }, [groups, query, chosen]);

  const exact = groups.some((g) => g.name.toLowerCase() === query.trim().toLowerCase());

  return (
    <SelectionViewer
      id={id}
      isOpen={isOpen}
      onClose={close}
      titleProp={{ text: 'What kind of thing is this?', textColor: dark ? '#f2f5f4' : '#12201d' }}
      ariaLabel="Choose the groups this product belongs to"
      cancelButton={{ position: 'right', onClick: close, view: <CloseIcon size="1.3em" /> }}
      searchProp={{
        text: 'Nigerian Breweries, Guinness, Cway…',
        onChange: setQuery,
        autoFocus: false,
        textColor: dark ? '#f2f5f4' : '#12201d',
        background: dark ? '#1b2322' : '#eef2f1',
        padding: { l: '4px', r: '4px', t: '0px', b: '0px' },
      }}
      noResultProp={{
        view: (
          <ViewerNoResult
            text="No group by that name"
            hint="Groups are your own — usually whoever made it, because their empties come back together."
            actionText={query.trim() ? `Make "${query.trim()}"` : 'Make a new group'}
            onAction={() => onAddNew(query.trim())}
          />
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
      childrenDirection="vertical"
      snapPoints={[0, 1]}
      initialSnap={1}
      minHeight="60dvh"
      maxHeight="92dvh"
      closeThreshold={0.2}
      selectionState={shown.length === 0 ? 'empty' : 'data'}
      zIndex={zIndex}
    >
      {/*
        ALWAYS, and first — the way the unit and customer pickers do it.

        This only appeared once something had been typed that matched nothing, so a shop opening the
        sheet to make its first group saw a list and no way in. The product picker made the same
        mistake and was corrected for the same reason: adding is most useful at the moment the shop
        is being asked for something it has never entered.
      */}
      <button
        type="button"
        className={styles.addRow}
        onClick={() => onAddNew(query.trim())}
      >
        <PlusIcon />{' '}
        {query.trim() && !exact ? `Make "${query.trim()}"` : 'Make a new group'}
      </button>

      <div className={styles.list}>
        {shown.map((g) => {
          const on = chosen.includes(g.id);
          return (
            <button
              key={g.id}
              type="button"
              className={`${styles.item} ${on ? styles.itemOn : ''}`}
              aria-pressed={on}
              onClick={() => onToggle(g.id)}
            >
              <span className={styles.name}>{g.name}</span>
              <span className={styles.meta}>
                {g.products === 0
                  ? 'not used yet'
                  : `${g.products} ${g.products === 1 ? 'item' : 'items'}`}
              </span>
              {on && <CheckIcon />}
            </button>
          );
        })}
      </div>

    </SelectionViewer>
  );
}
