'use client';

import type { ReactNode } from 'react';
import Header, { type HeaderAction } from '@academix-admin/header';
import styles from './PageScaffold.module.css';
import { useTheme } from '@/context/ThemeContext';

/**
 * The page frame every screen inside a navigation stack uses.
 *
 * Header, one scrolling body, optional sticky footer — the same shape as Flutter's Scaffold,
 * which is what academix-app uses and why its screens feel consistent.
 *
 * The header itself is `@academix-admin/header`, not a hand-rolled one. An earlier version of
 * this file reimplemented a title/back/actions bar that the shared package already provides,
 * which meant two things to keep in step and one of them getting no attention. The scaffold's
 * own job is the page FRAME — a single predictable scroll container (which navigation-stack's
 * scroll restoration and the nav bar's scroll subscription both need) and a footer that clears
 * the safe area.
 */
export function PageScaffold({
  title,
  subtitle,
  onBack,
  backLabel = 'Go back',
  actions,
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
  /** Icon actions, rendered by the header package. */
  actions?: HeaderAction[];
  /** Escape hatch for a non-icon control in the header. */
  action?: ReactNode;
  /** Sticky bar for the screen's primary action. */
  footer?: ReactNode;
  /** Removes body side padding for full-bleed lists. */
  flush?: boolean;
  children: ReactNode;
}) {
  const { theme } = useTheme();

  return (
    <div className={styles.scaffold}>
      <Header
        // 'title' rather than 'bar': the bar variant positions itself fixed, which would take it
        // out of this flex column and let the body scroll underneath it.
        variant="title"
        position="static"
        theme={theme}
        title={title}
        description={subtitle}
        onBack={onBack}
        backAriaLabel={backLabel}
        actions={actions}
        rightContent={action}
        className={styles.header}
      />

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
