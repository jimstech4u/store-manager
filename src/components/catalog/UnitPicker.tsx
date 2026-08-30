'use client';

import { useMemo, useState } from 'react';
import { SelectionViewer, useSelectionController } from '@academix-admin/selection-viewer';
import { useTheme } from '@/context/ThemeContext';
import { ViewerNoResult } from '@/components/ui/ViewerState';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import type { StoreUnit } from '@/lib/stacks/product-units';
import styles from './UnitPicker.module.css';

/**
 * Choose a unit the shop keeps — Crate, Bag, Litre, Kilogramme.
 *
 * A choice, so a sheet. Adding a word the shop has never used is a form, so it is a page, and this
 * only hands over to whoever opened it: a component that reaches for a route by name breaks the
 * moment it is reused in a stack that has no such route.
 *
 * SEARCHED RATHER THAN SCROLLED once a shop has thirty units, and the viewer brings its own search
 * box — there is no second one in here, which is a mistake this codebase has already made once.
 */
export function UnitPicker({
  open,
  onClose,
  onPick,
  onCreate,
  units,
  /** Units already on the item, so the same one cannot be added twice. */
  taken = [],
  title = 'Which unit?',
}: {
  open: boolean;
  onClose: () => void;
  onPick: (unit: StoreUnit) => void;
  onCreate: (name: string) => void;
  units: StoreUnit[];
  taken?: string[];
  title?: string;
}) {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const [viewerId] = useSelectionController();
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return units
      .filter((u) => !taken.includes(u.id))
      .filter((u) => q === '' || u.name.toLowerCase().includes(q) || u.plural.toLowerCase().includes(q));
  }, [units, taken, query]);

  const addButton = (
    <button type="button" className={styles.addRow} onClick={() => onCreate(query.trim())}>
      <PlusIcon /> {query.trim() ? `Add "${query.trim()}"` : 'Add a unit you use'}
    </button>
  );

  return (
    <SelectionViewer
      id={viewerId}
      isOpen={open}
      onClose={onClose}
      titleProp={{ text: title, textColor: dark ? '#f2f5f4' : '#12201d' }}
      ariaLabel={title}
      cancelButton={{ position: 'right', onClick: onClose, view: <CloseIcon /> }}
      searchProp={{
        text: 'Crate, Bag, Litre…',
        onChange: (value: string) => setQuery(value),
        background: dark ? '#1b2422' : '#eef2f1',
        textColor: dark ? '#f2f5f4' : '#12201d',
        autoFocus: false,
      }}
      noResultProp={{
        view: (
          <ViewerNoResult
            text="No unit by that name"
            hint="Units are your own words for how much of something there is."
            actionText={query.trim() ? `Add "${query.trim()}"` : 'Add a unit you use'}
            onAction={() => onCreate(query.trim())}
          />
        ),
      }}
      layoutProp={{
        backgroundColor: dark ? '#141a19' : '#ffffff',
        handleColor: '#888',
        handleWidth: '48px',
        gapBetweenHandleAndTitle: '16px',
        gapBetweenTitleAndSearch: '8px',
        gapBetweenSearchAndContent: '12px',
      }}
      childrenDirection="vertical"
      snapPoints={[0, 1]}
      initialSnap={1}
      minHeight="50dvh"
      maxHeight="88dvh"
      closeThreshold={0.2}
      zIndex={1000}
      selectionState={shown.length === 0 ? 'empty' : 'data'}
    >
      {addButton}

      <ul className={styles.list}>
        {shown.map((u) => (
          <li key={u.id}>
            <button
              type="button"
              className={styles.row}
              onClick={() => {
                onPick(u);
                onClose();
              }}
            >
              <span className={styles.name}>{u.name}</span>
              {/* The plural, because it is what a receipt will actually print. */}
              <span className={styles.plural}>many: {u.plural}</span>
            </button>
          </li>
        ))}
      </ul>
    </SelectionViewer>
  );
}
