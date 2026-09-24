'use client';

import Link from 'next/link';
import { MarketShell } from '../(market)/MarketShell';
import { useCart, sellerTotal, hasUnpriced } from '@/lib/marketplace/cart';
import styles from './cart.module.css';

/**
 * THE BASKET, WHICH IS REALLY SEVERAL BASKETS.
 *
 * One list of everything is how a single-shop site works. This is a marketplace: each seller is a
 * separate business that prices its own goods, writes its own receipt with its own name on it, and
 * may be open when the shop beside it is shut. Two crates from one and seven things from another are
 * two orders that happened to be chosen in one sitting.
 *
 * So each seller is checked out on its own, and a shopper can send the one that is ready and leave
 * the other. A single "checkout" button across all of them would be promising something nobody can
 * deliver — one payment, one receipt, one delivery, from businesses that share nothing but this page.
 */
export default function CartPage() {
  const { sellers, count, setQty, removeSeller } = useCart();

  return (
    <MarketShell>
      <main className={styles.wrap}>
        <h1 className={styles.title}>Your basket</h1>

        {count === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>Nothing in it yet</p>
            <p className={styles.emptyNote}>
              Anything you add is kept on this device, so you can carry on later without an account.
            </p>
            <Link className={styles.browse} href="/">
              Browse shops
            </Link>
          </div>
        ) : (
          <>
            <p className={styles.summary}>
              {count} {count === 1 ? 'item' : 'items'} from {sellers.length}{' '}
              {sellers.length === 1 ? 'shop' : 'shops'} — each shop is asked separately.
            </p>

            {sellers.map((seller) => {
              const total = sellerTotal(seller);
              return (
                <section key={seller.storeCode} className={styles.seller}>
                  <header className={styles.sellerHead}>
                    <Link href={`/s/${seller.storeCode}`} className={styles.sellerName}>
                      {seller.storeName}
                    </Link>
                    <button
                      type="button"
                      className={styles.remove}
                      onClick={() => removeSeller(seller.storeCode)}
                    >
                      Remove all
                    </button>
                  </header>

                  <ul className={styles.lines}>
                    {seller.lines.map((line) => (
                      <li key={line.productId} className={styles.line}>
                        <span className={styles.lineName}>{line.name}</span>

                        <span className={styles.qty}>
                          <button
                            type="button"
                            aria-label={`One fewer ${line.name}`}
                            onClick={() => setQty(seller.storeCode, line.productId, line.qty - 1)}
                          >
                            −
                          </button>
                          <span aria-live="polite">{line.qty}</span>
                          <button
                            type="button"
                            aria-label={`One more ${line.name}`}
                            onClick={() => setQty(seller.storeCode, line.productId, line.qty + 1)}
                          >
                            +
                          </button>
                        </span>

                        <span className={styles.linePrice}>
                          {line.price
                            ? `₦${(Number(line.price) * line.qty).toLocaleString('en-NG')}`
                            : 'Ask'}
                        </span>
                      </li>
                    ))}
                  </ul>

                  <div className={styles.sellerFoot}>
                    <span className={styles.total}>
                      ₦{total.toLocaleString('en-NG')}
                      {hasUnpriced(seller) && <span className={styles.plus}> + items to agree</span>}
                    </span>

                    {/*
                      Checkout is the next piece of work: it needs a customer account, because a shop
                      cannot fulfil an order for somebody it has no way to reach. Disabled and saying
                      so beats a button that fails.
                    */}
                    <button type="button" className={styles.checkout} disabled>
                      Send this order — coming next
                    </button>
                  </div>
                </section>
              );
            })}
          </>
        )}
      </main>
    </MarketShell>
  );
}
