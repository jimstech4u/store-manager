import Link from 'next/link';
import { getShopProducts, productHref } from '@/lib/marketplace/server';
import styles from './ProductList.module.css';

/**
 * A CATALOGUE A CRAWLER CAN WALK, AND A PERSON CAN READ WITH NO JAVASCRIPT.
 *
 * The grid above this is fetched in the browser. Its cards are real links now, which matters for
 * copying and opening in a new tab — but a crawler never runs the fetch, so as far as anything
 * reading the document is concerned that grid does not exist. Measured: the shop page had a title
 * and not one product link in it.
 *
 * So the products are rendered here on the server, with their prices, as plain links. Not a
 * duplicate for robots — it is visible, it works with JavaScript switched off, and it is the fastest
 * thing on the page for somebody on a bad connection.
 */

export default async function ProductList({
  storeId,
  heading,
  limit = 48,
}: {
  /** A shop's catalogue, or every public product when it is left out. */
  storeId?: string;
  heading: string;
  limit?: number;
}) {
  const products = await getShopProducts(storeId ?? null, limit);
  if (products.length === 0) return null;

  return (
    <section className={styles.wrap} aria-labelledby="catalogue">
      <h2 id="catalogue" className={styles.heading}>
        {heading}
      </h2>

      <ul className={styles.list}>
        {products.map((p) => (
          <li key={p.id}>
            <Link href={productHref(p)} className={styles.row}>
              <span className={styles.name}>{p.name}</span>
              <span className={styles.meta}>
                {p.price ? `₦${Number(p.price).toLocaleString('en-NG')}` : 'Ask'}
                <span className={styles.unit}> / {p.unit_label}</span>
                {!p.in_stock && <span className={styles.out}> · out of stock</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
