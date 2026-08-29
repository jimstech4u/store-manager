'use client';

import { useMemo, useState } from 'react';
import { SelectionViewer, useSelectionController } from '@academix-admin/selection-viewer';
import { useTheme } from '@/context/ThemeContext';
import { ViewerEmpty, ViewerNoResult } from '@/components/ui/ViewerState';
import { CloseIcon } from '@/components/ui/Icon';
import styles from './CustomerMenu.module.css';

/**
 * Every customer being served, as a list you can search.
 *
 * The tabs are a strip you scroll, which is right when there are three of them and useless when
 * there are twenty — the person you want is off the edge and you are dragging sideways hunting for
 * a name. This is the same set, upright, with a search box: type two letters of a name and go
 * straight there.
 *
 * IT SEARCHES WHAT IS OPEN, not the customer book. Nothing here reaches the database; the answer
 * is the tabs already on screen, so it responds instantly and works with no connection at all.
 * Attaching somebody NEW is a different question and has its own control.
 */
export function CustomerMenu({
  tabs,
  activeId,
  onPick,
}: {
  tabs: { id: string; name: string; amount: string }[];
  activeId: string | null;
  /** Makes the chosen customer active. The bar then brings their tab into view. */
  onPick: (id: string) => void;
}) {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const [id, ops, isOpen] = useSelectionController();
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return tabs;
    return tabs.filter((t) => t.name.toLowerCase().includes(term));
  }, [tabs, query]);

  const close = () => {
    ops.close();
    setQuery('');
  };

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        onClick={ops.open}
        aria-label="Find a customer being served"
      >
        <span className={styles.bars} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </button>

      <SelectionViewer
        id={id}
        isOpen={isOpen}
        onClose={close}
        titleProp={{ text: 'Customers being served', textColor: dark ? '#f2f5f4' : '#12201d' }}
        // Announced by name; without it a screen reader says only "dialog".
        ariaLabel="Customers being served"
        cancelButton={{ position: 'right', onClick: close, view: <CloseIcon /> }}
        searchProp={{
          text: 'Search the open tabs',
          onChange: (value: string) => setQuery(value),
          background: dark ? '#1b2422' : '#eef2f1',
          textColor: dark ? '#f2f5f4' : '#12201d',
          autoFocus: false,
        }}
        /*
         * No result and empty are different sentences.
         *
         * "Nothing matched" is about the search; "nobody is being served" is about the shop. A
         * seller who has just opened the till needs the second one, and being shown the first
         * would have them checking their spelling for a customer that was never there.
         */
        noResultProp={{
          view: (
            <ViewerNoResult
              text="No open tab for that name"
              hint="Only customers already being served are listed here."
              actionText="Clear the search"
              onAction={() => setQuery('')}
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
        maxHeight="90dvh"
        closeThreshold={0.2}
        zIndex={1000}
      >
        {tabs.length === 0 ? (
          <ViewerEmpty
            text="Nobody is being served"
            hint="Start a customer and they will appear here."
          />
        ) : (
          matches.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`${styles.row} ${tab.id === activeId ? styles.rowActive : ''}`}
              onClick={() => {
                onPick(tab.id);
                close();
              }}
            >
              <span className={styles.name}>{tab.name}</span>
              <span className={styles.amount}>{tab.amount}</span>
            </button>
          ))
        )}
      </SelectionViewer>
    </>
  );
}
