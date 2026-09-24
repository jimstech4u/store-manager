'use client';

import Link from 'next/link';
import { Thumb } from '@/components/ui/Thumb';
import { productHref } from '@/lib/marketplace/links';
import { formatMoney } from '@/lib/format';
import type { PublicProduct } from '@/lib/stacks/storefront';
import styles from '../../app/(market)/market.module.css';

/**
 * ONE PRODUCT IN A GRID — the same card wherever a grid of products appears.
 *
 * It was written inline on the shop page, and when search moved into its own viewer that card had
 * to exist in two places. Two copies of a card is two answers to "what does a product look like",
 * and they drift: the one behind the search overlay is the one nobody notices has stopped showing
 * the bulk tag.
 *
 * A LINK, NOT A BUTTON. A crawler follows `href` and never an onClick, so a catalogue made of
 * buttons is a catalogue nothing can walk. This is a real address a person can copy, send or open
 * in a new tab, and it is the same address the product's own page answers on. For somebody already
 * here the default is prevented and a sheet opens instead — no navigation, nothing lost.
 */
export function ProductCard({
  product,
  onOpen,
  /** Shown when the grid spans more than one shop, so a result says who is selling it. */
  showShop = false,
}: {
  product: PublicProduct;
  onOpen: (product: PublicProduct) => void;
  showShop?: boolean;
}) {
  return (
    <Link
      href={productHref(product)}
      className={styles.card}
      onClick={(e) => {
        // A modified click is somebody asking for a new tab. Let the browser do its job.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onOpen(product);
      }}
    >
      <span className={styles.cardMedia}>
        <Thumb path={product.image_path} name={product.name} ratio="1 / 1" />
      </span>
      <span className={styles.cardName}>{product.name}</span>
      {showShop ? (
        <span className={styles.storeTag}>{product.store_name}</span>
      ) : (
        product.category && <span className={styles.storeTag}>{product.category}</span>
      )}
      {product.price && (
        <span className={styles.cardPrice}>
          {formatMoney(product.price)}
          <span className={styles.cardMeta}> / {product.unit_label}</span>
        </span>
      )}
      <span className={styles.tags}>
        <span className={`${styles.tag} ${product.in_stock ? styles.tagIn : styles.tagOut}`}>
          {product.in_stock ? 'In stock' : 'Out of stock'}
        </span>
        {product.has_bulk && <span className={`${styles.tag} ${styles.tagBulk}`}>Cheaper in bulk</span>}
      </span>
    </Link>
  );
}
