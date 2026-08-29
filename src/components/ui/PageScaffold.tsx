'use client';

import type { ReactNode } from 'react';
import Header, { type HeaderAction } from '@academix-admin/header';
import { Scaffold } from '@academix-admin/navigation-stack';
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
  headerScrolls = false,
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
  /**
   * Lets the header travel with the content instead of staying put.
   *
   * Right for a screen with its own sticky furniture underneath: the sell screen's customer bar
   * has to take the top of the screen as you scroll into a long receipt, and it cannot while a
   * pinned header is already standing there.
   *
   * The behaviour itself belongs to navigation-stack, not here — an app-level version of this was
   * tried first, rendering the header inside the body, and it read as the header being deleted
   * rather than moving. `appBarBehavior="scroll"` lays the bar over a body padded by its height
   * and moves it one-to-one with the scroll, so it follows the finger and comes back with the
   * page.
   */
  headerScrolls?: boolean;
  children: ReactNode;
}) {
  const { theme } = useTheme();

  /*
   * The frame comes from navigation-stack's own Scaffold now, not from a hand-rolled flex column.
   *
   * The hand-rolled body was a plain scrolling <div>, and the tab bar never reacted to scrolling
   * because NOTHING WAS PUBLISHING SCROLL EVENTS. `NavigationBar` subscribes to
   * `scrollBroadcaster`, and the broadcaster is fed by the scroll container the stack knows about
   * — which a div of our own is not. That is why the bar sat still here while academix-web's
   * lifts away.
   *
   * Delegating also picks up scroll restoration and a bottom bar that rides above the keyboard,
   * both of which were on the list to build. Same lesson as the header: the package already does
   * this, and a second implementation is a second thing to keep correct.
   */
  const header = (
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
      className={`${styles.header} ${headerScrolls ? styles.headerScrolls : ''}`}
    />
  );

  return (
    <Scaffold
      appBar={header}
      appBarBehavior={headerScrolls ? 'scroll' : 'pinned'}
      bodyClassName={`${styles.body} ${flush ? styles.bodyFlush : ''}`}
      bottomBar={
        footer ? (
          <div className={styles.footer}>
            <div className={styles.footerInner}>{footer}</div>
          </div>
        ) : undefined
      }
    >
      <div className={styles.inner}>{children}</div>
    </Scaffold>
  );
}
