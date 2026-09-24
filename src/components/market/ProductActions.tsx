'use client';

import { useEffect, useState } from 'react';
import { useCart } from '@/lib/marketplace/cart';
import { useFavourites } from '@/lib/marketplace/favourites';
import styles from './ProductActions.module.css';

/**
 * WHAT A SHOPPER CAN DO WITH A PRODUCT: take it, keep it, or send it.
 *
 * A client island inside a server-rendered page. The page itself stays static — that is what makes
 * it indexable and what makes it appear instantly from a search result — and only this strip needs
 * to know anything about a basket.
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
  const [added, setAdded] = useState(false);
  const [shared, setShared] = useState<'copied' | null>(null);

  const inCart =
    sellers
      .find((s) => s.storeCode === product.store_code)
      ?.lines.find((l) => l.productId === product.id)?.qty ?? 0;

  // "Added" is a confirmation, not a state: it says the tap landed and then gets out of the way.
  useEffect(() => {
    if (!added) return;
    const t = setTimeout(() => setAdded(false), 1800);
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

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.add}
        onClick={() => {
          add(product);
          setAdded(true);
        }}
        aria-label={`Add ${product.name} to basket`}
      >
        {added ? 'Added' : inCart > 0 ? `Add another (${inCart} in basket)` : 'Add to basket'}
      </button>

      {/*
        Out of stock does not hide the button. A shop's stock figure is what it last recorded, not a
        promise — and a shopper who wants six crates should be able to ask for them and let the shop
        answer. The order is a request either way.
      */}
      {!product.in_stock && <p className={styles.note}>The shop has this marked out of stock — you can still ask.</p>}

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
