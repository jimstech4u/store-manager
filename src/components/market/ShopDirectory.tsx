import Link from 'next/link';
import { createClient } from '@supabase/supabase-js';
import styles from './ShopDirectory.module.css';

/**
 * EVERY SHOP, AS LINKS A CRAWLER CAN FOLLOW.
 *
 * The marketplace above this is fetched in the browser and every card is a button — so a crawler
 * reading the landing page finds no shop, no product and no price, and nothing to follow. It reads
 * fifteen kilobytes of shell and leaves. That is not a weak result; it is the reason nothing on this
 * site can be found at all.
 *
 * This is a plain server-rendered list of the shops that exist, with real `<a href>`. Not hidden,
 * not duplicated for robots — a directory is a thing people use too, and anything written for a
 * crawler that a person cannot see is cloaking.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

interface ShopRow {
  code?: string | null;
  store_code?: string | null;
  name?: string | null;
  store_name?: string | null;
  product_count?: number | null;
}

async function shops(): Promise<ShopRow[]> {
  if (!url || !key) return [];
  try {
    const db = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await db.rpc('public_stores_near', {
      p_lat: null,
      p_lon: null,
      p_query: null,
      p_within_km: null,
      p_limit: 200,
    });
    if (error) throw error;
    return (data ?? []) as ShopRow[];
  } catch {
    // A directory that cannot be read is left out, not turned into a 500. The rest of the page is
    // still a marketplace.
    return [];
  }
}

export const revalidate = 600;

export default async function ShopDirectory() {
  const rows = await shops();
  if (rows.length === 0) return null;

  return (
    <section className={styles.wrap} aria-labelledby="shop-directory">
      <h2 id="shop-directory" className={styles.heading}>
        Shops on Store Manager
      </h2>
      <p className={styles.sub}>Browse a shop to see its prices and what it has in stock.</p>

      <ul className={styles.list}>
        {rows.map((row) => {
          const code = row.code ?? row.store_code;
          const name = row.name ?? row.store_name ?? code;
          if (!code) return null;
          return (
            <li key={code}>
              {/* A real link, because a crawler follows hrefs and never a button's onClick. */}
              <Link href={`/s/${code}`} className={styles.shop}>
                {name}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
