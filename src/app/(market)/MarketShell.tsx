'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import styles from './market.module.css';
import { Button } from '@/components/ui/Button';
import { Logo } from '@/components/ui/Logo';
import { useAuth } from '@/providers/AuthProvider';

/**
 * The public marketplace chrome: brand, a way in, and whatever the page puts below.
 *
 * Separate from the app's PageScaffold on purpose. That one is built for a signed-in worker
 * inside a navigation stack — bottom tab bar, one scroll container, sticky action footer. This is
 * a website for a visitor who has never seen the product, and it needs the opposite: a
 * conventional top bar with sign-in, and normal page scrolling.
 */
export function MarketShell({
  children,
  search,
}: {
  children: ReactNode;
  /** Rendered under the brand row — the marketplace search. */
  search?: ReactNode;
}) {
  const router = useRouter();
  const { session, stores } = useAuth();

  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <div className={styles.topRow}>
          <button
            type="button"
            className={styles.brand}
            onClick={() => router.push('/')}
            aria-label="Store Manager home"
          >
            <Logo size={30} nameClassName={styles.brandName} />
          </button>

          <span className={styles.topSpacer} />

          <div className={styles.topActions}>
            {session ? (
              <Button size="small" onClick={() => router.push(stores.length ? '/main' : '/setup')}>
                {stores.length ? 'My shop' : 'Set up my shop'}
              </Button>
            ) : (
              <>
                {/* Wrapped rather than given a `hidden` class directly: Button sets its own
                    `display`, and two class selectors of equal specificity are resolved by
                    stylesheet order — so hiding the button itself worked or not depending on
                    bundle order. Hiding a wrapper is unambiguous. */}
                <span className={styles.hideNarrow}>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => router.push('/login')}
                  >
                    Sign in
                  </Button>
                </span>
                <Button size="small" onClick={() => router.push('/login?mode=signup')}>
                  Open a shop
                </Button>
              </>
            )}
          </div>
        </div>

        {search && <div className={styles.searchRow}>{search}</div>}
      </header>

      {children}

      <footer className={styles.foot}>
        Store Manager — stock, sales and accounts for distribution businesses.
      </footer>
    </div>
  );
}
