'use client';

import type { ReactNode } from 'react';
import styles from './PageScaffold.module.css';
import { ChevronLeftIcon } from './Icon';

/**
 * The page frame every screen inside a navigation stack uses.
 *
 * Header, one scrolling body, optional sticky footer — the same shape as Flutter's Scaffold,
 * which is what academix-app uses and why its screens feel consistent. Having one component own
 * it means the scroll container is always in the same place, which matters here because
 * navigation-stack's scroll restoration and the nav bar's scroll subscription both need a
 * predictable element to watch.
 */
export function PageScaffold({
  title,
  subtitle,
  onBack,
  backLabel = 'Go back',
  action,
  footer,
  flush = false,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Omit on a stack's first page — there is nothing to go back to. */
  onBack?: () => void;
  backLabel?: string;
  /** Top-right control, e.g. a filter or "Add". */
  action?: ReactNode;
  /** Sticky bar for the screen's primary action. */
  footer?: ReactNode;
  /** Removes body side padding for full-bleed lists. */
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.scaffold}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          {onBack && (
            <button type="button" className={styles.back} onClick={onBack} aria-label={backLabel}>
              <ChevronLeftIcon size="1.5em" />
            </button>
          )}
          <div className={styles.titles}>
            <h1 className={styles.title}>{title}</h1>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          {action && <div className={styles.headerAction}>{action}</div>}
        </div>
      </header>

      <div className={`${styles.body} ${flush ? styles.bodyFlush : ''}`}>
        <div className={styles.inner}>{children}</div>
      </div>

      {footer && (
        <div className={styles.footer}>
          <div className={styles.footerInner}>{footer}</div>
        </div>
      )}
    </div>
  );
}
