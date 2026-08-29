'use client';

import { useCallback, useState } from 'react';
import styles from './CustomerPicker.module.css';
import { SelectionViewer, useSelectionController } from '@academix-admin/selection-viewer';
import { useTheme } from '@/context/ThemeContext';
import { ViewerError, ViewerLoading, ViewerNoResult } from '@/components/ui/ViewerState';
import { useDebounced } from '@/components/ui/SearchField';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { getSupabase } from '@/lib/supabase/client';
import { usePaginatedList } from '@/hooks/usePaginatedList';
import { formatMoney } from '@/lib/format';

export interface PickedCustomer {
  id: string;
  name: string;
  phone: string;
  balance: number;
}

interface CustomerRow {
  id: string;
  identity_id: string;
  display_name: string;
  business_name: string | null;
  phone: string;
  balance: string;
}

/**
 * Choose a customer.
 *
 * Deliberately NOT a step at the start of a sale. Most buyers are anonymous walk-ins paying cash,
 * and asking "who is this?" before anything can be added to a receipt is a question the seller
 * usually cannot answer and does not need to. It becomes necessary only when part of the money is
 * going on account, because credit needs somewhere to sit.
 *
 * CHOOSING ONLY. Creating somebody used to happen here too, as a form inside the panel — and a
 * selection viewer is built for a list you scroll and pick from: it brings its own search box, a
 * drag handle, snap points and a height that assumes rows. A form inherits all of that, needs none
 * of it, and the two fight over the keyboard on a phone. So this offers a button and the form is a
 * page of its own.
 *
 * Attaching an EXISTING person still matters more than the convenience: the same customer with two
 * records has their debt split between them, which is what makes a debtor look settled while
 * owing money. That is why the list is searched first and adding is the second option, not the
 * first.
 */
export function CustomerPicker({
  open,
  onClose,
  onPick,
  onCreate,
  storeId,
  /** Prefills the name on the create page when the seller has already typed one on the order. */
  initialName = '',
}: {
  open: boolean;
  onClose: () => void;
  onPick: (customer: PickedCustomer) => void;
  /**
   * Hands over to the page that creates one.
   *
   * The picker does not push it itself: whoever opened this knows which stack they are in, and a
   * component reaching for a route by name is a component that breaks when it is reused somewhere
   * that route does not exist.
   */
  onCreate: (name: string) => void;
  storeId: string;
  initialName?: string;
}) {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  // The viewer's own id, so two pickers mounted at once cannot share one panel.
  const [viewerId] = useSelectionController();

  const [query, setQuery] = useState(initialName);
  const debounced = useDebounced(query);

  const fetchPage = useCallback(
    async (cursor: unknown | null, limit: number) => {
      const c = cursor as { name: string; id: string } | null;
      const { data, error: err } = await getSupabase().rpc('list_customers', {
        p_store_id: storeId,
        p_query: debounced.trim() || null,
        p_after_name: c?.name ?? null,
        p_after_id: c?.id ?? null,
        p_limit: limit,
      });
      if (err) throw err;
      const rows = (data ?? []) as CustomerRow[];
      const last = rows[rows.length - 1];
      return { rows, cursor: last ? { name: last.display_name, id: last.id } : null };
    },
    [storeId, debounced],
  );

  const list = usePaginatedList<CustomerRow>({
    fetchPage,
    getId: (r) => r.id,
    /*
     * The picker's own list, kept apart from the People page's so the two cannot overwrite each
     * other's rows while both are mounted — and persisted, so it opens on the people it showed
     * last time rather than an empty panel while the read is in flight.
     */
    key: 'customer-picker',
    scope: 'customer_flow',
    persist: true,
    deps: [storeId, debounced],
    enabled: open,
  });

  /** Offered at both ends of a list that runs to hundreds. */
  const addButton = (
    <button type="button" className={styles.addRow} onClick={() => onCreate(query.trim())}>
      <PlusIcon /> {query.trim() ? `Add "${query.trim()}"` : 'Add a new customer'}
    </button>
  );

  return (
    <SelectionViewer
      id={viewerId}
      isOpen={open}
      onClose={onClose}
      titleProp={{ text: 'Who is this for?', textColor: dark ? '#f2f5f4' : '#12201d' }}
      ariaLabel="Who is this for?"
      cancelButton={{ position: 'right', onClick: onClose, view: <CloseIcon /> }}
      /*
       * The viewer's OWN search. It had a second one of ours inside it for a while, so the panel
       * opened with two search boxes stacked on top of each other, both searching the same list.
       */
      searchProp={{
        text: 'Search by name or phone',
        onChange: (value: string) => setQuery(value),
        background: dark ? '#1b2422' : '#eef2f1',
        textColor: dark ? '#f2f5f4' : '#12201d',
        autoFocus: false,
      }}
      loadingProp={{ view: <ViewerLoading text="Looking" /> }}
      noResultProp={{
        view: (
          <ViewerNoResult
            text="Nobody by that name yet"
            hint="You only need to save someone when they are buying on credit."
            actionText={query.trim() ? `Add "${query.trim()}"` : 'Add a new customer'}
            onAction={() => onCreate(query.trim())}
          />
        ),
      }}
      errorProp={{
        view: <ViewerError text="Could not load your customers" onAction={() => list.reload()} />,
      }}
      /*
       * Paging as it is scrolled. Returning `hasMore` is how the viewer knows to stop asking once
       * the end of the list has been reached.
       */
      onPaginate={() => {
        list.loadMore();
        return list.hasMore;
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
      minHeight="60dvh"
      maxHeight="92dvh"
      closeThreshold={0.2}
      zIndex={1000}
      selectionState={
        list.loading && list.items.length === 0
          ? 'loading'
          : list.error && list.items.length === 0
            ? 'error'
            : list.items.length === 0
              ? 'empty'
              : 'data'
      }
    >
      {addButton}

      <ul className={styles.list}>
        {list.items.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className={styles.row}
              onClick={() =>
                onPick({
                  id: c.id,
                  name: c.display_name,
                  phone: c.phone,
                  balance: Number(c.balance) || 0,
                })
              }
            >
              <span className={styles.rowMain}>
                <span className={styles.rowName}>{c.display_name}</span>
                <span className={styles.rowMeta}>
                  {c.phone}
                  {c.business_name ? ` · ${c.business_name}` : ''}
                </span>
              </span>
              {Number(c.balance) > 0 && (
                <span className={styles.rowBalance}>owes {formatMoney(c.balance)}</span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {/* Somebody who has scrolled to the bottom looking for a name that is not there should not
          have to scroll back up to add it. */}
      {list.items.length > 0 && addButton}
    </SelectionViewer>
  );
}
