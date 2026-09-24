'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import styles from './market.module.css';
import { Button } from '@/components/ui/Button';
import { Logo } from '@/components/ui/Logo';
import { useCart } from '@/lib/marketplace/cart';
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
  const { count } = useCart();

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
            {/*
              THE BASKET IS ALWAYS REACHABLE, and always before the account actions.

              A shopper who has added something and then wandered two shops deep needs it from
              wherever they are; hunting for it is how a basket is abandoned. It is a real <a
              href> so it survives a crawler, a middle-click and a shared link — the same reason
              every other route on the public side is.
            */}
            <Link className={styles.basket} href="/cart" aria-label={count > 0 ? `Basket, ${count} items` : 'Basket'}>
              <BasketIcon />
              {/* The number appears only when there is one. A badge reading 0 is noise that
                  trains people to ignore the badge. */}
              {count > 0 && <span className={styles.basketCount}>{count > 99 ? '99+' : count}</span>}
            </Link>

            {session ? (
              /*
                A SIGNED-IN PERSON HERE IS NOT NECESSARILY A SHOP.
                
                This used to offer "Set up my shop" to anyone signed in with no store, which is now
                the shopper's normal state — they signed up to order from shops, and were met with
                an invitation to open one. With no store the useful thing is their own orders; the
                way to open a shop is still on the landing page, where somebody looking for it is.
              */
              <Button
                size="small"
                variant={stores.length ? 'primary' : 'secondary'}
                onClick={() => router.push(stores.length ? '/main' : '/orders')}
              >
                {stores.length ? 'My shop' : 'My orders'}
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

/** A basket, drawn rather than imported: the app's icon set is for the signed-in side. */
function BasketIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 8h12l-1.2 10.2a2 2 0 0 1-2 1.8H9.2a2 2 0 0 1-2-1.8L6 8Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M9 8V6.5a3 3 0 0 1 6 0V8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
