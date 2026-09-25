'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MarketShell } from '../(market)/MarketShell';
import {
  useCart,
  sellerTotal,
  hasUnpriced,
  lineTotal,
  lineUnitPrice,
  lineIsDiscounted,
  type CartSeller,
} from '@/lib/marketplace/cart';
import { saveCustomerAccount, useCustomerAccount } from '@/lib/marketplace/account';
import { placeOnlineOrder, type PlacedOrder } from '@/lib/marketplace/place-order';
import { useAuth } from '@/providers/AuthProvider';
import { messageOf } from '@/lib/format';
import styles from './cart.module.css';

/**
 * THE BASKET, WHICH IS REALLY SEVERAL BASKETS.
 *
 * One list of everything is how a single-shop site works. This is a marketplace: each seller is a
 * separate business that prices its own goods, writes its own receipt with its own name on it, and
 * may be open when the shop beside it is shut. Two crates from one and seven things from another are
 * two orders that happened to be chosen in one sitting.
 *
 * So each seller is sent on its own, and a shopper can send the one that is ready and leave the
 * other. A single "checkout" button across all of them would be promising something nobody can
 * deliver — one payment, one receipt, one delivery, from businesses that share nothing but this page.
 *
 * AN ACCOUNT IS ASKED FOR HERE AND NOWHERE ELSE. Browsing, filling this basket and saving things all
 * work with nobody signed in. The ask arrives at the one moment it is genuinely needed: a shop is
 * about to be asked to set goods aside for a person, and it cannot do that for somebody it has no
 * way to reach.
 */
export default function CartPage() {
  const { sellers, count, setQty, removeSeller } = useCart();
  const { session, loading: authLoading } = useAuth();
  const account = useCustomerAccount(Boolean(session));
  const router = useRouter();

  /** Orders already sent, by shop code — kept on screen after the group leaves the basket. */
  const [sent, setSent] = useState<Record<string, PlacedOrder>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  /** The shop code whose send button asked for a name, if any. */
  const [asking, setAsking] = useState<string | null>(null);

  /*
   * Sending, once there is nothing left to ask.
   *
   * Separate from `send` so the name form can call it DIRECTLY when it has just saved an account.
   * Going back through the gate would re-read `account`, which has been invalidated but not yet
   * answered, and ask the same person who they are a second time.
   */
  const place = async (seller: CartSeller) => {
    setBusy(seller.storeCode);
    try {
      const placed = await placeOnlineOrder(seller);
      setSent((s) => ({ ...s, [seller.storeCode]: placed }));
      // Out of the basket once the shop has it: leaving it there invites a second identical order.
      removeSeller(seller.storeCode);
    } catch (e) {
      setFailed((f) => ({ ...f, [seller.storeCode]: messageOf(e, 'That order could not be sent.') }));
    } finally {
      setBusy(null);
    }
  };

  const send = async (seller: CartSeller) => {
    setFailed((f) => ({ ...f, [seller.storeCode]: '' }));

    // Not signed in: go and do that, and come back HERE rather than to somebody's till.
    if (!session) {
      router.push('/login?next=/cart');
      return;
    }
    // Not asked yet. Nothing is claimed either way until there is an answer.
    if (!account.loaded) return;
    // Signed in, but we have never been told who they are. Asked in place — sending somebody to
    // another screen at this point is how a full basket gets abandoned.
    if (!account.data?.account) {
      setAsking(seller.storeCode);
      return;
    }

    await place(seller);
  };

  const nothingLeft = count === 0 && Object.keys(sent).length === 0;

  return (
    <MarketShell back={{ to: '/', label: 'Back to shopping' }} title="Your basket">
      <main className={styles.wrap}>
        <h1 className={styles.title}>Your basket</h1>

        {/* Orders already on their way, above the basket: it is the newest thing that happened. */}
        {Object.entries(sent).map(([code, placed]) => (
          <section key={`sent-${code}`} className={styles.sent}>
            <p className={styles.sentTitle}>Sent to the shop</p>
            <p className={styles.sentBody}>
              Your order number is <strong className={styles.code}>{placed.code}</strong>. The shop
              will accept or turn it down — nothing is owed until they do.
            </p>
            {placed.repriced > 0 && (
              <p className={styles.sentNote}>
                {placed.repriced === 1
                  ? 'One item is priced differently now than when you added it'
                  : `${placed.repriced} items are priced differently now than when you added them`}
                , and the shop&rsquo;s current price is what was sent.
              </p>
            )}
            <Link className={styles.track} href={`/track?code=${encodeURIComponent(placed.code)}`}>
              Follow this order
            </Link>
          </section>
        ))}

        {nothingLeft ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>Nothing in it yet</p>
            <p className={styles.emptyNote}>
              Anything you add is kept on this device, so you can carry on later without an account.
            </p>
            <Link className={styles.browse} href="/">
              Browse shops
            </Link>
          </div>
        ) : count > 0 ? (
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

                        {/*
                          THE BAND'S PRICE, not the ordinary one times the quantity.
                          
                          This multiplied `line.price` by `qty` while the seller's total below it
                          used `sellerTotal`, which applies the bulk bands — so six American Cola
                          read ₦22,200 on the line and ₦21,600 underneath it. Two figures for one
                          basket, and the bigger one is the one a shopper sees first.
                        */}
                        <span className={styles.linePrice}>
                          {line.price ? (
                            <>
                              ₦{lineTotal(line).toLocaleString('en-NG')}
                              {lineIsDiscounted(line) && (
                                <span className={styles.lineBand}>
                                  bulk · ₦{(lineUnitPrice(line) ?? 0).toLocaleString('en-NG')} each
                                </span>
                              )}
                            </>
                          ) : (
                            'Ask'
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {asking === seller.storeCode && (
                    <WhoAreYou
                      onDone={() => {
                        setAsking(null);
                        void place(seller);
                      }}
                      onCancel={() => setAsking(null)}
                    />
                  )}

                  {failed[seller.storeCode] && (
                    <p className={styles.failed} role="alert">
                      {failed[seller.storeCode]}
                    </p>
                  )}

                  <div className={styles.sellerFoot}>
                    <span className={styles.total}>
                      ₦{total.toLocaleString('en-NG')}
                      {hasUnpriced(seller) && <span className={styles.plus}> + items to agree</span>}
                    </span>

                    <button
                      type="button"
                      className={styles.checkout}
                      disabled={busy === seller.storeCode || authLoading}
                      onClick={() => void send(seller)}
                    >
                      {busy === seller.storeCode
                        ? 'Sending'
                        : session
                          ? `Send this order to ${seller.storeName}`
                          : 'Sign in to send this order'}
                    </button>
                  </div>
                </section>
              );
            })}

            <p className={styles.foot}>
              Sending an order does not pay for it and does not hold the stock. The shop sees what
              you have asked for and either accepts it or turns it down.
            </p>
          </>
        ) : null}
      </main>
    </MarketShell>
  );
}

/**
 * The only thing a shop is told about a shopper: a name and a number to ring.
 *
 * Inline, inside the seller's own block, rather than a separate screen. At this point the shopper
 * has decided; a navigation away is where that decision gets lost. Two fields, because two fields
 * is genuinely all an order needs.
 */
function WhoAreYou({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Enter your name');
    if (phone.trim().length < 7) return setError('Enter a number the shop can reach you on');

    setBusy(true);
    setError(null);
    try {
      await saveCustomerAccount(name.trim(), phone.trim());
      onDone();
    } catch (err) {
      setError(messageOf(err, 'That could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.who} onSubmit={submit} noValidate>
      <p className={styles.whoTitle}>Who should the shop ask for?</p>

      <label className={styles.whoField}>
        <span>Your name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          required
        />
      </label>

      <label className={styles.whoField}>
        <span>Phone number</span>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
        />
      </label>

      {error && (
        <p className={styles.failed} role="alert">
          {error}
        </p>
      )}

      <div className={styles.whoActions}>
        <button type="button" className={styles.whoCancel} onClick={onCancel}>
          Not now
        </button>
        <button type="submit" className={styles.whoSave} disabled={busy}>
          {busy ? 'Saving' : 'Save and send'}
        </button>
      </div>
    </form>
  );
}
