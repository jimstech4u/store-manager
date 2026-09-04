'use client';

import { useMemo, useState } from 'react';
import { SelectionViewer } from '@academix-admin/selection-viewer';
import { useOverlayRoute } from '@academix-admin/navigation-stack';
import { CheckIcon, CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { InfoPanel } from '@/components/ui/Explain';
import { Button } from '@/components/ui/Button';
import { useTheme } from '@/context/ThemeContext';
import type { ProductGroup } from '@/lib/stacks/product-groups';
import styles from './GroupPicker.module.css';

/**
 * Which groups a product is in — NBL, Guinness, Beer, PET.
 *
 * MULTI-SELECT, unlike every other picker in the app, and that is the point: a product belongs to
 * several groupings at once and each answers a different question. So this stays open while things
 * are ticked and closes when the shop says it is done, rather than closing on the first tap.
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
  busy = false,
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
  busy?: boolean;
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
        text: 'Search or type a new group',
        onChange: setQuery,
        autoFocus: false,
        textColor: dark ? '#f2f5f4' : '#12201d',
        background: dark ? '#1b2322' : '#eef2f1',
        padding: { l: '4px', r: '4px', t: '0px', b: '0px' },
      }}
      noResultProp={{
        view: (
          <div className={styles.empty}>
            <InfoPanel tone="info" title="No group by that name">
              Groups are yours to name. A distributor usually wants the brewery — NBL, Guinness — and
              a shopkeeper usually wants the shelf.
            </InfoPanel>
            <Button size="large" fullWidth busy={busy} onClick={() => onAddNew(query.trim())}>
              <PlusIcon /> Make &ldquo;{query.trim() || 'a new group'}&rdquo;
            </Button>
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
      childrenDirection="vertical"
      snapPoints={[0, 1]}
      initialSnap={1}
      minHeight="60dvh"
      maxHeight="92dvh"
      closeThreshold={0.2}
      selectionState={shown.length === 0 ? 'empty' : 'data'}
      zIndex={zIndex}
    >
      {/* Offered before the list, not only after a search fails. */}
      {query.trim() !== '' && !exact && (
        <button
          type="button"
          className={styles.addRow}
          disabled={busy}
          onClick={() => onAddNew(query.trim())}
        >
          <PlusIcon /> Make &ldquo;{query.trim()}&rdquo;
        </button>
      )}

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

      {/*
        A WAY OUT THAT IS NOT THE X.

        Every other picker closes on the first tap, so this one has to say when it is finished —
        otherwise somebody ticks three groups and then looks for the thing that confirms it.
      */}
      <div className={styles.doneRow}>
        <Button size="large" fullWidth onClick={close}>
          Done{chosen.length > 0 ? ` — ${chosen.length} chosen` : ''}
        </Button>
      </div>
    </SelectionViewer>
  );
}
