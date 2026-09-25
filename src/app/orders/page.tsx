'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { MarketShell } from '../(market)/MarketShell';
import { useMyOnlineOrders } from '@/lib/marketplace/place-order';
import { useAuth } from '@/providers/AuthProvider';
import styles from './orders.module.css';

/**
 * WHAT A SHOPPER HAS ASKED FOR, AND WHAT CAME OF IT.
 *
 * Their side of the same rows the shop answers on its Orders screen — and deliberately only their
 * side. A shopper sees the request they made and whether it was taken; nothing here reaches into
 * the shop's ledger, its stock or what anyone else ordered.
 *
 * "Waiting" is the honest word for an open order. Not "pending", which sounds like a machine is
 * working on it, and not "confirmed", which it is not: a person at a shop has to look at it.
 */
export default function MyOrdersPage() {
  const { session, loading } = useAuth();
  const orders = useMyOnlineOrders(Boolean(session));
  const router = useRouter();

  useEffect(() => {
    if (!loading && !session) router.replace('/login?next=/orders');
  }, [loading, session, router]);

  const list = orders.data ?? [];

  return (
    <MarketShell back={{ to: '/', label: 'Back to shopping' }} title="Your orders">
      <main className={styles.wrap}>
        <h1 className={styles.title}>Your orders</h1>

        {!session ? (
          <p className={styles.note}>One moment.</p>
        ) : !orders.loaded ? (
          /* Never an empty list before there is an answer: "you have no orders" is a claim, and
             showing it while the read is still in flight is showing something untrue. */
          <p className={styles.note}>{orders.error ? orders.error : 'Looking…'}</p>
        ) : list.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>You have not ordered anything yet</p>
            <Link className={styles.browse} href="/">
              Browse shops
            </Link>
          </div>
        ) : (
          <ul className={styles.list}>
            {list.map((o) => (
              <li key={o.id} className={styles.order}>
                <div className={styles.head}>
                  <Link href={`/s/${o.store_code}`} className={styles.shop}>
                    {o.store_name}
                  </Link>
                  <span className={styles[o.status]}>
                    {o.status === 'open'
                      ? 'Waiting on the shop'
                      : o.status === 'settled'
                        ? 'Accepted'
                        : 'Turned down'}
                  </span>
                </div>

                <p className={styles.what}>
                  {o.lines} {o.lines === 1 ? 'item' : 'items'} · ₦
                  {Number(o.total).toLocaleString('en-NG')} · order{' '}
                  <span className={styles.code}>{o.code}</span>
                </p>

                {o.status === 'open' && (
                  <Link className={styles.track} href={`/track?code=${encodeURIComponent(o.code)}`}>
                    Follow this order
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </MarketShell>
  );
}
