'use client';

import type { ReactNode } from 'react';
import { SearchIcon } from './Icon';
import styles from './SearchField.module.css';
import launcher from './SearchLauncher.module.css';

/**
 * The search box a page shows, which opens the real search when tapped.
 *
 * Deliberately looks exactly like the `SearchField` it replaces — same height, same border, same
 * icon in the same place. A person taps where they have always tapped and gets a full-screen
 * search instead of a cramped in-page one; nothing about the page has to be re-learned.
 *
 * It is a BUTTON, not an input. A read-only input would still take focus, raise the phone
 * keyboard behind the sheet that is opening, and be reachable by a screen reader as an editable
 * field that cannot be edited. A button announces what it does.
 *
 * The term already typed is shown in place of the placeholder, so returning to the page after a
 * search does not look like the search was forgotten.
 */
export function SearchLauncher({
  label,
  placeholder,
  value,
  onOpen,
  resultCount,
  trailing,
}: {
  /** Accessible name — what is being searched, e.g. "Search your stock". */
  label: string;
  placeholder: string;
  /** The term currently in effect, shown instead of the placeholder. */
  value?: string;
  onOpen: () => void;
  /** Announced politely after a search, so the count is not visual-only. */
  resultCount?: number;
  trailing?: ReactNode;
}) {
  const term = value?.trim() ?? '';

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={launcher.launcher}
        onClick={onOpen}
        aria-label={label}
      >
        <SearchIcon className={styles.icon} size="1.2em" />
        <span className={term ? launcher.value : launcher.placeholder}>
          {term || placeholder}
        </span>
        {trailing}
      </button>

      {resultCount !== undefined && (
        <p className={styles.count} role="status">
          {resultCount === 0
            ? 'Nothing found'
            : `${resultCount} ${resultCount === 1 ? 'result' : 'results'}`}
        </p>
      )}
    </div>
  );
}
