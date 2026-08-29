'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import styles from './ViewerState.module.css';

/**
 * What a picker shows when it has nothing to show yet.
 *
 * These used to be `FullPageMessage`, which is built for a whole screen and behaves like one
 * inside a sheet: it takes the height it is given, so a spinner sat in the middle of a 60dvh
 * panel with an enormous margin above and below it and read as something having gone wrong.
 *
 * A sheet's empty states are SMALL and sit near the top, where the first result would be — so the
 * eye is already in the right place when the list arrives. They are also opaque against the
 * sheet's own surface rather than the page's, which is what stopped the loader looking like a
 * hole cut in the panel.
 *
 * Three states, because they are three different situations and answering them the same way is
 * how "nothing here" gets mistaken for "still working":
 *
 *   LOADING     — we are asking. Say so, and say nothing else.
 *   NO RESULT   — we asked, and this search has no answer. Offer to try again.
 *   EMPTY       — we asked, and there is nothing to search at all. That is a different sentence:
 *                 the shop has no products yet, not "your search matched nothing".
 */

function Frame({ children }: { children: ReactNode }) {
  return <div className={styles.frame}>{children}</div>;
}

export function ViewerLoading({ text = 'Searching' }: { text?: string }) {
  return (
    <Frame>
      <span className={styles.spinner} aria-hidden="true" />
      <p className={styles.text} role="status">
        {text}
      </p>
    </Frame>
  );
}

export function ViewerNoResult({
  text = 'Nothing matched that',
  hint = 'Try a shorter word, or check the spelling.',
  actionText,
  onAction,
}: {
  text?: string;
  hint?: string;
  actionText?: string;
  onAction?: () => void;
}) {
  return (
    <Frame>
      <p className={styles.title}>{text}</p>
      <p className={styles.hint}>{hint}</p>
      {actionText && onAction && (
        <Button variant="secondary" onClick={onAction}>
          {actionText}
        </Button>
      )}
    </Frame>
  );
}

export function ViewerEmpty({
  text,
  hint,
  actionText,
  onAction,
}: {
  text: string;
  hint?: string;
  actionText?: string;
  onAction?: () => void;
}) {
  return (
    <Frame>
      <p className={styles.title}>{text}</p>
      {hint && <p className={styles.hint}>{hint}</p>}
      {actionText && onAction && (
        <Button variant="secondary" onClick={onAction}>
          {actionText}
        </Button>
      )}
    </Frame>
  );
}

export function ViewerError({
  text = 'That could not be loaded',
  actionText = 'Try again',
  onAction,
}: {
  text?: string;
  actionText?: string;
  onAction?: () => void;
}) {
  return (
    <Frame>
      <p className={styles.title}>{text}</p>
      <p className={styles.hint}>Check the connection and try again.</p>
      {onAction && (
        <Button variant="secondary" onClick={onAction}>
          {actionText}
        </Button>
      )}
    </Frame>
  );
}
