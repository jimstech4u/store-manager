'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeftIcon, CloseIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import styles from './AuthShell.module.css';

/**
 * The chrome every auth screen shares: a way back, a way out, and the brand.
 *
 * BACK IS A STACK POP, not browser history. Signing up walks through screens — details, then six
 * digits — and each of those is a place you can be sent back to. `useStackBack` returns undefined
 * at the stack's root, so the arrow appears only where there is somewhere to go and no screen has
 * to know whether it happens to be first.
 *
 * The close button stays separate from it. Back means "the previous step"; close means "I am
 * leaving this entirely", and on a phone with no browser chrome those need to be two different
 * controls or the only way out of a sign-up is to finish it.
 */
export function AuthShell({
  title,
  lead,
  children,
  /** Hides the brand on screens that are a step within a flow rather than its front door. */
  compact = false,
}: {
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  compact?: boolean;
}) {
  const router = useRouter();
  const goBack = useStackBack();

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.bar}>
          {goBack ? (
            <button type="button" className={styles.icon} onClick={goBack} aria-label="Go back">
              <ChevronLeftIcon size="1.5em" />
            </button>
          ) : (
            // Holds the row's height so the brand does not jump as screens change.
            <span className={styles.iconSpacer} aria-hidden="true" />
          )}

          <button
            type="button"
            className={styles.icon}
            onClick={() => router.push('/')}
            aria-label="Close and go back to the shops"
          >
            <CloseIcon size="1.4em" />
          </button>
        </div>

        {!compact && (
          <>
            <h1 className={styles.brand}>Store Manager</h1>
            <p className={styles.tagline}>Stock, sales and accounts for your business.</p>
          </>
        )}

        <div className={styles.card}>
          <h2 className={styles.heading}>{title}</h2>
          {lead && <p className={styles.subheading}>{lead}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}
