'use client';

import type { ReactNode } from 'react';
import styles from './FullPageMessage.module.css';
import { AlertIcon, BoxIcon } from './Icon';
import { LoadingView } from './LoadingView';

type Tone = 'loading' | 'empty' | 'error';

/**
 * A whole-screen state: loading, empty, or broken.
 *
 * One component for all three because they are the same layout and, more importantly, because
 * having one makes it awkward to skip the empty and error cases — which is how a screen ends up
 * showing a blank rectangle when a request fails.
 *
 * The MARKS come from `LoadingView` and `NoResultsView` rather than being drawn again here.
 * Twenty screens already call this, so routing it through the shared views was the way to give
 * all of them the same spinner and the same empty state without twenty edits — and it means the
 * whole-page state and the in-sheet state (which the search viewers show) cannot drift apart.
 */
export function FullPageMessage({
  tone = 'loading',
  title,
  children,
  action,
}: {
  tone?: Tone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={styles.wrap}
      // Loading is announced politely so a screen reader says what is happening without cutting
      // off whatever it was already reading; an error interrupts, because it needs to.
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      {tone === 'loading' && <LoadingView />}
      {tone === 'empty' && (
        <span className={styles.icon}>
          <BoxIcon size="34px" />
        </span>
      )}
      {tone === 'error' && (
        <span className={styles.iconDanger}>
          <AlertIcon size="34px" />
        </span>
      )}

      <p className={styles.title}>{title}</p>
      {children && <div className={styles.body}>{children}</div>}
      {action && <div className={styles.actions}>{action}</div>}
    </div>
  );
}
