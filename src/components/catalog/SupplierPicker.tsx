'use client';

import { useMemo, useState } from 'react';
import { SelectionViewer, useSelectionController } from '@academix-admin/selection-viewer';
import { useTheme } from '@/context/ThemeContext';
import { ViewerNoResult } from '@/components/ui/ViewerState';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import type { Supplier } from '@/lib/stacks/suppliers';
import styles from './UnitPicker.module.css';

/**
 * Choose who a load came from.
 *
 * A choice, so a sheet — and naming a supplier the shop has never bought from is a form, so it is a
 * page, handed to whoever opened this. A component that reaches for a route by name breaks the
 * moment it is reused in a stack that has no such route, which is why the unit and group pickers
 * both take a callback rather than pushing.
 *
 * THE ADD ROW IS ALWAYS FIRST, not only after a search comes back empty. Somebody entering a
 * delivery from a new supplier is at their most likely to need it before they have typed anything —
 * the product picker made people fail first and was corrected for exactly this.
 *
 * Wears the unit picker's stylesheet on purpose: it is the same list of the shop's own words, and
 * two stylesheets for one shape is two things to keep in step.
 */
export function SupplierPicker({
  open,
  onClose,
  onPick,
  onCreate,
  suppliers,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (supplier: Supplier) => void;
  /** Given whatever was typed, so "NBL" in the search box becomes the new supplier's name. */
  onCreate: (typedName: string) => void;
  suppliers: Supplier[];
}) {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const [viewerId] = useSelectionController();
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.phone ?? '').includes(q),
    );
  }, [suppliers, query]);

  const exact = suppliers.some((s) => s.name.toLowerCase() === query.trim().toLowerCase());

  return (
    <SelectionViewer
      id={viewerId}
      isOpen={open}
      onClose={onClose}
      titleProp={{ text: 'Who did this come from?', textColor: dark ? '#f2f5f4' : '#12201d' }}
      ariaLabel="Who did this come from?"
      cancelButton={{ position: 'right', onClick: onClose, view: <CloseIcon /> }}
      searchProp={{
        text: 'Nigerian Breweries, Guinness…',
        onChange: (value: string) => setQuery(value),
        background: dark ? '#1b2422' : '#eef2f1',
        textColor: dark ? '#f2f5f4' : '#12201d',
        autoFocus: false,
      }}
      noResultProp={{
        view: (
          <ViewerNoResult
            text="No supplier by that name"
            hint="Suppliers are whoever you buy from — a brewery, a depot, a distributor."
            actionText={query.trim() ? `Add "${query.trim()}"` : 'Add a supplier'}
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
      <button type="button" className={styles.addRow} onClick={() => onCreate(query.trim())}>
        <PlusIcon /> {query.trim() && !exact ? `Add "${query.trim()}"` : 'Add a supplier'}
      </button>

      <ul className={styles.list}>
        {shown.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={styles.row}
              onClick={() => {
                onPick(s);
                onClose();
              }}
            >
              <span className={styles.name}>{s.name}</span>
              {/*
                What is worth knowing at the moment of choosing: how much has come from them, and
                the number to ring when a load is short.
              */}
              <span className={styles.plural}>
                {s.deliveries === 0
                  ? 'no deliveries yet'
                  : `${s.deliveries} ${s.deliveries === 1 ? 'delivery' : 'deliveries'}`}
                {s.phone ? ` · ${s.phone}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </SelectionViewer>
  );
}
