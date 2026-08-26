'use client';

import { useState, type ReactNode } from 'react';
import { SearchViewer } from '@academix-admin/search-viewer';
import { LoadingView } from './LoadingView';
import { NoResultsView } from './NoResultsView';
import { OfflineIcon } from './Icon';
import { useTheme } from '@/context/ThemeContext';
import { useOverlayRoute } from '@/hooks/useOverlayRoute';

/**
 * The app's one search surface, wrapping `@academix-admin/search-viewer`.
 *
 * Every screen that searches — stock, sales, customers, products mid-sale — opens this rather than
 * cramming results under an in-page box. The results get the whole screen, which is the difference
 * between scanning three matches and scanning thirty, and the keyboard no longer covers the list
 * it is filtering.
 *
 * Wrapped rather than used directly at each call site for one reason: the viewer takes about
 * fifteen presentational props — colours, paddings, empty and error views, layout gaps — and
 * repeating them per page is how five search screens end up looking like five different apps.
 * Callers supply what differs: what to search, how to draw a row, and what a row does.
 *
 * `zIndex` is 1000 deliberately. The tab bar sits at 50 and is a sibling of the page, so anything
 * lower is a sheet the tabs punch through — visible in front of it and still taking taps.
 */
export function SearchSheet<T>({
  id,
  isOpen,
  onClose,
  placeholder,
  /** Rows already on the page, filtered locally so the first keystroke is instant. */
  onInitialData,
  localDataDeps,
  /** Server-side search for anything not already loaded. */
  queryData,
  keyOf,
  renderRow,
  emptyText,
}: {
  id: string;
  isOpen: boolean;
  onClose: () => void;
  placeholder: string;
  onInitialData: (text: string) => T[];
  localDataDeps: unknown[];
  /**
   * Server-side search for anything not already loaded.
   *
   * Cursor first, then the text — the viewer's own argument order, kept rather than flipped to
   * something that reads better here. A wrapper that quietly reorders a library's callback is a
   * trap for whoever writes the next call site against the library's own documentation.
   */
  queryData: (
    cursor: unknown | undefined,
    text: string,
  ) => Promise<{ data: T[]; cursor?: unknown }>;
  keyOf: (row: T) => string;
  renderRow: (row: T) => ReactNode;
  emptyText: string;
}) {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const [results, setResults] = useState<{ data: T }[]>([]);

  // The viewer portals itself and does not register with the navigation stack, so back would walk
  // straight past it and out of the app.
  useOverlayRoute(`search:${id}`, isOpen, onClose);

  return (
    <SearchViewer<T, unknown>
      id={id}
      isOpen={isOpen}
      onClose={onClose}
      // Long enough that a word typed at counter speed is one request, short enough that the list
      // still feels like it is following the typing.
      debounceMs={300}
      onInitialData={onInitialData}
      localDataDeps={localDataDeps}
      queryData={queryData}
      onRemoveDuplicateBy={keyOf}
      searchProp={{
        text: placeholder,
        autoFocus: true,
        textColor: dark ? '#f2f5f4' : '#12201d',
        background: dark ? '#1b2322' : '#eef2f1',
        padding: { l: '4px', r: '4px', t: '0px', b: '0px' },
      }}
      // The same three views every search surface shows, so results, emptiness and failure look
      // identical wherever someone searches.
      loadingProp={{ view: <LoadingView text="Searching" /> }}
      noResultProp={{ view: <NoResultsView text={emptyText} /> }}
      errorProp={{
        view: (
          <NoResultsView
            text="Could not search. Check the connection and try again."
            icon={<OfflineIcon size="30px" />}
          />
        ),
      }}
      layoutProp={{
        gapBetweenSearchAndContent: '16px',
        searchBackground: dark ? '#121817' : '#ffffff',
        maxWidth: '720px',
      }}
      childrenDirection="vertical"
      zIndex={1000}
      // Names the modal, so it is announced as what it searches rather than just "dialog".
      ariaLabel={placeholder}
      onResult={setResults}
    >
      {results.map((r) => (
        <div key={keyOf(r.data)}>{renderRow(r.data)}</div>
      ))}
    </SearchViewer>
  );
}
