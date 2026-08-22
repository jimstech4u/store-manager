'use client';

import { useEffect, useId, useState } from 'react';
import styles from './SearchField.module.css';
import { CloseIcon, SearchIcon } from './Icon';

/**
 * Search box.
 *
 * Search is load-bearing in this product rather than a convenience: a distributor carrying 300
 * lines cannot scroll to find one while a customer waits, and slow lookup is what sends staff
 * back to paper. So it appears on nearly every list, and it is one component so it behaves
 * identically everywhere.
 *
 * `type="search"` rather than `text`: phone keyboards show a "search" action key, and the field
 * gets the platform's own clear affordance in addition to ours.
 */
export function SearchField({
  value,
  onChange,
  placeholder = 'Search',
  label,
  resultCount,
  autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Accessible name. Falls back to the placeholder when the design has no visible label. */
  label?: string;
  /** When given, announced politely so a screen-reader user hears the list change. */
  resultCount?: number;
  autoFocus?: boolean;
}) {
  const id = useId();

  return (
    <>
      <div className={styles.wrap}>
        <span className={styles.icon}>
          <SearchIcon />
        </span>
        <input
          id={id}
          className={styles.input}
          type="search"
          inputMode="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={label ?? placeholder}
          autoFocus={autoFocus}
          // Names, product codes and phone numbers — none of which should be auto-corrected or
          // auto-capitalised into something that then fails to match.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        {value !== '' && (
          <button
            type="button"
            className={styles.clear}
            onClick={() => onChange('')}
            aria-label="Clear search"
          >
            <CloseIcon />
          </button>
        )}
      </div>
      {resultCount !== undefined && value.trim() !== '' && (
        <p className={styles.count} role="status" aria-live="polite">
          {resultCount === 0
            ? 'Nothing found'
            : `${resultCount} ${resultCount === 1 ? 'result' : 'results'}`}
        </p>
      )}
    </>
  );
}

/**
 * Debounced value, so a search fires once the typing pauses rather than on every keystroke.
 *
 * 250ms: long enough to skip most intermediate letters on a slow connection, short enough that
 * the list still feels like it is responding to you.
 */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);

  return debounced;
}
