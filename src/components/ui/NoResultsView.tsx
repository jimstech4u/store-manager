'use client';

import type { ReactNode } from 'react';
import { SearchIcon } from './Icon';
import styles from './NoResultsView.module.css';

/**
 * "Nothing here", with a way forward.
 *
 * Same shape as academix-web's `NoResultsView` — a mark, a line of text, an optional action — so
 * the two apps read the same. The mark is this product's rather than a branded Lottie, for the
 * same reason the spinner is drawn: an empty result should not cost a download.
 *
 * The ACTION is the part that matters and the part usually left out. An empty screen that only
 * says "nothing found" leaves someone stuck with whatever they typed; one that offers the obvious
 * next move — clear the search, add the thing they were looking for, try again — is the difference
 * between a dead end and a step.
 */
export function NoResultsView({
  text = null,
  buttonText = null,
  onButtonClick = null,
  icon,
}: {
  text?: string | null;
  buttonText?: string | null;
  onButtonClick?: (() => void) | null;
  /** Overrides the magnifier for an empty state that is not about searching. */
  icon?: ReactNode;
}) {
  return (
    <div className={styles.container}>
      <span className={styles.mark} aria-hidden="true">
        {icon ?? <SearchIcon size="30px" />}
      </span>

      {text && <p className={styles.text}>{text}</p>}

      {buttonText && onButtonClick && (
        <button type="button" className={styles.action} onClick={onButtonClick}>
          {buttonText}
        </button>
      )}
    </div>
  );
}
