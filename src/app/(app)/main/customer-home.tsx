'use client';

import Link from 'next/link';
import { useAuth } from '@/providers/AuthProvider';
import { useCustomerAccount } from '@/lib/marketplace/account';
import { useMyOnlineOrders } from '@/lib/marketplace/place-order';
import { useCart } from '@/lib/marketplace/cart';
import styles from './customer-home.module.css';

/**
 * `/main` FOR SOMEBODY WHO CAME HERE TO BUY, NOT TO SELL.
 *
 * Three kinds of person sign in to this app now, and until this screen existed `/main` served two
 * of them. A shopper landing here had no store, which the app shell read as "you have not made your
 * shop yet" and answered with the create-a-shop wizard — asking somebody to open a business in
 * order to buy a crate of drinks. The stopgap was to bounce them out to the marketplace, which is
 * better and still wrong: it means a shopper has no home, no history, nowhere their own things are.
 *
 * So this is theirs. It is deliberately small — their orders, their basket, a way back to the
 * shops — because that is the whole of what a shopper has here today. Everything a customer will
 * come to need (following a delivery, talking to a shop, what they have bought before, what they
 * owe) belongs on this screen or one pushed from it, and this is where it goes.
 *
 * NO TAB BAR. The shop's `/main` is five stacks in a group because a shop does five jobs at once
 * and switches between them all day. A shopper does one thing. A tab bar over two destinations is
 * furniture.
 */
export function CustomerHome() {
  const { session } = useAuth();
  const account = useCustomerAccount(Boolean(session));
  const orders = useMyOnlineOrders(Boolean(session));
  const { count } = useCart();

  const list = orders.data ?? [];
  const waiting = list.filter((o) => o.status === 'open');
  const name = account.data?.account?.display_name ?? null;

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.hello}>{name ? `Hello, ${name}` : 'Hello'}</h1>
        <p className={styles.sub}>Your orders and your basket.</p>
      </header>

      <div className={styles.cards}>
        <Link className={styles.card} href="/">
          <span className={styles.cardTitle}>Browse shops</span>
          <span className={styles.cardNote}>See what shops near you have, and what it costs</span>
        </Link>

        <Link className={styles.card} href="/cart">
          <span className={styles.cardTitle}>
            Your basket
            {/* Only when there is something in it — a badge reading 0 is furniture. */}
            {count > 0 && <span className={styles.badge}>{count}</span>}
          </span>
          <span className={styles.cardNote}>
            {count > 0
              ? `${count} ${count === 1 ? 'item' : 'items'} waiting to be sent`
              : 'Nothing in it yet'}
          </span>
        </Link>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Your orders</h2>

        {!orders.loaded ? (
          /* Never "you have no orders" before there is an answer — that is a claim, and showing it
             while the read is in flight is showing something untrue. */
          <p className={styles.note}>{orders.error ?? 'Looking…'}</p>
        ) : list.length === 0 ? (
          <p className={styles.note}>
            Nothing ordered yet. Anything you send a shop appears here, and stays here.
          </p>
        ) : (
          <>
            {waiting.length > 0 && (
              <p className={styles.waiting}>
                {waiting.length} {waiting.length === 1 ? 'order is' : 'orders are'} waiting on a
                shop to answer.
              </p>
            )}
            <ul className={styles.orders}>
              {list.slice(0, 5).map((o) => (
                <li key={o.id} className={styles.order}>
                  <span className={styles.orderShop}>{o.store_name}</span>
                  <span className={styles.orderMeta}>
                    {o.lines} {o.lines === 1 ? 'item' : 'items'} · ₦
                    {Number(o.total).toLocaleString('en-NG')} ·{' '}
                    {o.status === 'open'
                      ? 'waiting'
                      : o.status === 'settled'
                        ? 'accepted'
                        : 'turned down'}
                  </span>
                </li>
              ))}
            </ul>
            <Link className={styles.all} href="/orders">
              All your orders
            </Link>
          </>
        )}
      </section>
    </main>
  );
}
