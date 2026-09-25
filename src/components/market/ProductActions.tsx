'use client';

import { useEffect, useState } from 'react';
import { useCart } from '@/lib/marketplace/cart';
import { useFavourites } from '@/lib/marketplace/favourites';
import { nextBand, unitPriceFor } from '@/lib/marketplace/pricing';
import { fetchPublicTiers, type PublicTier } from '@/lib/stacks/storefront';
import { useAuth } from '@/providers/AuthProvider';
import styles from './ProductActions.module.css';

/**
 * WHAT A SHOPPER CAN DO WITH A PRODUCT: take some of it, keep it, or send it.
 *
 * A client island inside a server-rendered page. The page itself stays static — that is what makes
 * it indexable and what makes it appear instantly from a search result — and only this strip needs
 * to know anything about a basket.
 *
 * HOW MANY IS ASKED HERE, not left until the basket. This is wholesale: the unit is a crate, and
 * "one" is the wrong default often enough that adding one at a time and then fixing it on another
 * screen is the slow path for most of the people using this. The number can be typed as well as
 * stepped, because somebody ordering forty does not want to press + forty times.
 */
export interface ProductForActions {
  id: string;
  name: string;
  price: string | null;
  unit_label: string;
  image_path: string | null;
  /** Compared against the shops this person works in — see `ownShop`. */
  store_id: string;
  store_code: string;
  store_name: string;
  in_stock: boolean;
}

export function ProductActions({
  product,
  /** Bands already read by the page. Left out, this reads them itself. */
  tiers: given,
}: {
  product: ProductForActions;
  tiers?: PublicTier[] | null;
}) {
  const { add, sellers } = useCart();
  const { isFavourite, toggle } = useFavourites();
  const { stores } = useAuth();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(0);
  const [shared, setShared] = useState<'copied' | null>(null);

  /*
   * A SHOP CANNOT ORDER FROM ITSELF, and is told so here rather than at the send button.
   *
   * The server refuses it outright — that is where it matters — but an owner browsing their own
   * shop should not be invited to fill a basket that can never be sent. Whoever works here is
   * served at the counter.
   */
  const ownShop = stores.some((s) => s.id === product.store_id);

  /*
   * The bulk bands, read here when the page has not already got them.
   *
   * They matter before anything is added: a shopper deciding how many to buy is exactly who the
   * band is for, and "6 or more: ₦3,600 each" is the shop's own offer. Not showing it means the
   * marketplace quietly sells at the single price a shop meant to discount.
   */
  const [tiers, setTiers] = useState<PublicTier[] | null>(given ?? null);
  useEffect(() => {
    if (given !== undefined) {
      setTiers(given);
      return;
    }
    let alive = true;
    void fetchPublicTiers(product.id)
      .then((t) => alive && setTiers(t))
      // No bands is a perfectly ordinary answer, and so is a failed read: the ordinary price still
      // stands and the server prices the order either way.
      .catch(() => alive && setTiers([]));
    return () => {
      alive = false;
    };
  }, [product.id, given]);

  const unit = unitPriceFor(product.price, tiers, qty);
  const atOne = unitPriceFor(product.price, tiers, 1);
  const saving = unit !== null && atOne !== null && unit < atOne ? (atOne - unit) * qty : 0;
  const upNext = nextBand(product.price, tiers, qty);

  const inCart =
    sellers
      .find((s) => s.storeCode === product.store_code)
      ?.lines.find((l) => l.productId === product.id)?.qty ?? 0;

  // "Added" is a confirmation, not a state: it says the tap landed and then gets out of the way.
  useEffect(() => {
    if (!added) return;
    const t = setTimeout(() => setAdded(0), 2000);
    return () => clearTimeout(t);
  }, [added]);

  useEffect(() => {
    if (!shared) return;
    const t = setTimeout(() => setShared(null), 1800);
    return () => clearTimeout(t);
  }, [shared]);

  const share = async () => {
    const url = window.location.href;
    const title = `${product.name} — ${product.store_name}`;
    try {
      /*
       * The phone's own share sheet where there is one: that is where WhatsApp is, which is where
       * this actually gets sent. Copying the link is the fallback, not the first choice.
       */
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setShared('copied');
    } catch {
      // Cancelled, or refused. Neither is a failure worth interrupting somebody about.
    }
  };

  const naira = (n: number) => `₦${Math.round(n).toLocaleString('en-NG')}`;

  return (
    <div className={styles.wrap}>
      <div className={styles.qtyRow}>
        <span className={styles.qtyLabel}>How many</span>

        <span className={styles.qty}>
          <button
            type="button"
            aria-label="One fewer"
            // Never below one: zero of something is not an order, it is not adding it.
            onClick={() => setQty((q) => Math.max(1, q - 1))}
          >
            −
          </button>
          {/*
            Typed as well as stepped. `inputMode="numeric"` brings up the number pad on a phone
            without the spinner arrows a `number` input adds, which are far too small to hit.
          */}
          <input
            value={qty}
            inputMode="numeric"
            aria-label={`How many ${product.unit_label}`}
            onChange={(e) => {
              const digits = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
              setQty(digits === '' ? 0 : Number(digits));
            }}
            // An empty box while typing is fine; an empty box once they have left it is not.
            onBlur={() => setQty((q) => (q < 1 ? 1 : q))}
          />
          <button type="button" aria-label="One more" onClick={() => setQty((q) => q + 1)}>
            +
          </button>
        </span>

        <span className={styles.unit}>{product.unit_label}</span>
      </div>

      {/*
        THE LADDER, in the shop's own words. Shown whole rather than only the band in force, so a
        shopper can see what buying more would cost before they decide how many they want.
      */}
      {tiers && tiers.length > 0 && (
        <ul className={styles.bands}>
          {tiers.map((t, i) => {
            const from = Number(t.min_qty);
            const to = t.max_qty === null ? null : Number(t.max_qty);
            const on = qty >= from && (to === null || qty <= to);
            return (
              <li key={i} className={on ? styles.bandOn : styles.band}>
                <span>
                  {to === null ? `${from} or more` : `${from}–${to}`}
                </span>
                <span>{naira(Number(t.price))} each</span>
              </li>
            );
          })}
        </ul>
      )}

      {ownShop ? (
        <p className={styles.note}>
          This is your own shop. Sales here are started at the till, not ordered from the
          marketplace.
        </p>
      ) : (
        <button
          type="button"
          className={styles.add}
          disabled={qty < 1}
          onClick={() => {
            add(product, qty, tiers ?? undefined);
            setAdded(qty);
          }}
          aria-label={`Add ${qty} ${product.unit_label} of ${product.name} to basket`}
        >
          {added > 0
            ? `Added ${added}`
            : unit !== null
              ? `Add ${qty} to basket · ${naira(unit * qty)}`
              : `Add ${qty} to basket`}
        </button>
      )}

      {saving > 0 && (
        <p className={styles.saving}>
          Bulk price — {naira(saving)} less than buying {qty} at {naira(atOne ?? 0)} each.
        </p>
      )}

      {/* The shop's own offer, said where somebody can act on it. */}
      {!ownShop && upNext && (
        <button
          type="button"
          className={styles.upsell}
          onClick={() => setQty(upNext.atQty)}
        >
          Add {upNext.more} more for {naira(upNext.price)} each
        </button>
      )}

      {inCart > 0 && added === 0 && (
        <p className={styles.note}>
          {inCart} already in your basket from {product.store_name}.
        </p>
      )}

      {/*
        Out of stock does not hide the button. A shop's stock figure is what it last recorded, not a
        promise — and a shopper who wants six crates should be able to ask for them and let the shop
        answer. The order is a request either way.
      */}
      {!product.in_stock && (
        <p className={styles.note}>The shop has this marked out of stock — you can still ask.</p>
      )}

      <div className={styles.row}>
        <button
          type="button"
          className={isFavourite(product.id) ? styles.favOn : styles.fav}
          onClick={() => toggle(product.id)}
          aria-pressed={isFavourite(product.id)}
          aria-label={isFavourite(product.id) ? 'Remove from saved' : 'Save this'}
        >
          {isFavourite(product.id) ? '★ Saved' : '☆ Save'}
        </button>

        <button type="button" className={styles.share} onClick={() => void share()}>
          {shared === 'copied' ? 'Link copied' : 'Share'}
        </button>
      </div>
    </div>
  );
}
