'use client';

import { useEffect, useState } from 'react';
import { useCart } from '@/lib/marketplace/cart';
import { useFavourites } from '@/lib/marketplace/favourites';
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
  store_code: string;
  store_name: string;
  in_stock: boolean;
}

export function ProductActions({ product }: { product: ProductForActions }) {
  const { add, sellers } = useCart();
  const { isFavourite, toggle } = useFavourites();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(0);
  const [shared, setShared] = useState<'copied' | null>(null);

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

  const money = (n: number) =>
    product.price ? `₦${(Number(product.price) * n).toLocaleString('en-NG')}` : null;

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

      <button
        type="button"
        className={styles.add}
        disabled={qty < 1}
        onClick={() => {
          add(product, qty);
          setAdded(qty);
        }}
        aria-label={`Add ${qty} ${product.unit_label} of ${product.name} to basket`}
      >
        {added > 0
          ? `Added ${added}`
          : money(qty)
            ? `Add ${qty} to basket · ${money(qty)}`
            : `Add ${qty} to basket`}
      </button>

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
