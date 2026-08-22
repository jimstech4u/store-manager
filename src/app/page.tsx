'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './(market)/market.module.css';
import { MarketShell } from './(market)/MarketShell';
import { Button } from '@/components/ui/Button';
import { SearchField, useDebounced } from '@/components/ui/SearchField';
import { InfoPanel } from '@/components/ui/Explain';
import { Thumb } from '@/components/ui/Thumb';
import { SearchIcon } from '@/components/ui/Icon';
import { LogoMark } from '@/components/ui/Logo';
import { useInfiniteScroll } from '@/hooks/usePaginatedList';
import {
  fetchPublicCategories,
  usePublicProducts,
  usePublicStores,
  type PublicCategory,
} from '@/lib/stacks/storefront';
import { formatMoney } from '@/lib/format';

/**
 * The marketplace landing page.
 *
 * Previously this route just redirected to the login screen, which told a first-time visitor
 * nothing about what the product is and gave a shopper nowhere to go. Now it is a real front
 * door: browse shops and what they sell, or sign in / open a shop.
 *
 * Only shops that have OPTED IN appear here. A catalogue and its prices are a business's own
 * information, and publishing them is a decision its owner makes deliberately — see the
 * storefront switch in Settings.
 */
export default function MarketplacePage() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
  const [category, setCategory] = useState<string | null>(null);
  const [categories, setCategories] = useState<PublicCategory[]>([]);

  const stores = usePublicStores(debounced);
  const products = usePublicProducts({ query: debounced, category });

  useEffect(() => {
    void fetchPublicCategories().then(setCategories).catch(() => setCategories([]));
  }, []);

  const sentinelRef = useInfiniteScroll(products.loadMore, {
    enabled: products.hasMore && !products.loading,
  });

  const searching = debounced.trim() !== '' || category !== null;
  const nothingPublished =
    !stores.loading &&
    !products.loading &&
    stores.items.length === 0 &&
    products.items.length === 0 &&
    !searching;

  const heading = useMemo(() => {
    if (category) return category;
    if (debounced.trim()) return `Results for “${debounced.trim()}”`;
    return 'What shops are selling';
  }, [category, debounced]);

  return (
    <MarketShell
      search={
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search products, categories or shops"
          label="Search the marketplace"
        />
      }
    >
      {!searching && (
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <h1 className={styles.heroTitle}>Buy from shops near you</h1>
            <p className={styles.heroText}>
              Browse what local distributors have in stock, with their prices — including bulk
              prices when you buy more. Run a shop yourself? Keep your stock, sales and customer
              accounts straight in one place.
            </p>
            <div className={styles.heroActions}>
              <Button
                size="large"
                className={styles.heroPrimary}
                onClick={() => router.push('/login?mode=signup')}
              >
                Open a shop
              </Button>
              <Button
                size="large"
                variant="secondary"
                className={styles.heroSecondary}
                onClick={() => router.push('/login')}
              >
                Sign in
              </Button>
            </div>
          </div>
        </section>
      )}

      <main className={styles.body}>
        <div className={styles.inner}>
          {nothingPublished ? (
            <InfoPanel tone="info" title="No shops are listed here yet">
              Shops choose whether to show their products publicly. If you run one, you can turn
              your storefront on under <strong>Settings</strong> — and everything you already sell
              appears here.
            </InfoPanel>
          ) : (
            <>
              {/* ── Categories ─────────────────────────────────────────────────── */}
              {categories.length > 0 && (
                <>
                <div className={`${styles.banner} ${styles.bannerCategories}`}>
                  <div className={styles.bannerText}>
                    <p className={styles.bannerTitle}>Browse by category</p>
                  </div>
                </div>
                <div className={styles.rail} role="group" aria-label="Categories">
                  <button
                    type="button"
                    className={`${styles.chip} ${category === null ? styles.chipActive : ''}`}
                    onClick={() => setCategory(null)}
                    aria-pressed={category === null}
                  >
                    Everything
                  </button>
                  {categories.map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      className={`${styles.chip} ${category === c.name ? styles.chipActive : ''}`}
                      onClick={() => setCategory(category === c.name ? null : c.name)}
                      aria-pressed={category === c.name}
                    >
                      {c.name} ({c.product_count})
                    </button>
                  ))}
                </div>
                </>
              )}

              {/* ── Shops ──────────────────────────────────────────────────────── */}
              {stores.items.length > 0 && !category && (
                <>
                  <div className={`${styles.banner} ${styles.bannerShops}`}>
                    <div className={styles.bannerText}>
                      <h2 className={styles.bannerTitle}>Shops</h2>
                      <p className={styles.bannerNote}>
                        {stores.items.length} {stores.items.length === 1 ? 'shop' : 'shops'} listed
                      </p>
                    </div>
                  </div>

                  <div className={styles.storeGrid}>
                    {stores.items.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={styles.card}
                        onClick={() => router.push(`/s/${s.code}`)}
                      >
                        <span className={styles.storeCover}>
                          <Thumb path={s.cover_path} name={s.name} ratio="16 / 9" />
                        </span>
                        <span className={styles.cardName}>{s.name}</span>
                        <span className={styles.cardMeta}>
                          {s.product_count} {s.product_count === 1 ? 'item' : 'items'} · code{' '}
                          {s.code}
                        </span>
                        {s.address && <span className={styles.cardMeta}>{s.address}</span>}
                        {s.distance_km && (
                          <span className={styles.distance}>
                            {Number(s.distance_km) < 1
                              ? 'Less than 1 km away'
                              : `${Math.round(Number(s.distance_km))} km away`}
                          </span>
                        )}
                        {s.description && (
                          <span className={styles.cardMeta}>{s.description}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* ── Products ───────────────────────────────────────────────────── */}
              <div className={`${styles.banner} ${styles.bannerProducts}`}>
                <div className={styles.bannerText}>
                  <h2 className={styles.bannerTitle}>{heading}</h2>
                  <p className={styles.bannerNote}>
                    {products.loading && products.items.length === 0
                      ? 'Looking…'
                      : `${products.items.length}${products.hasMore ? '+' : ''} ${
                          products.items.length === 1 ? 'item' : 'items'
                        }`}
                  </p>
                </div>
              </div>

              {products.items.length === 0 && !products.loading ? (
                <div className={styles.empty}>
                  <SearchIcon size="34px" />
                  <p className={styles.emptyTitle}>Nothing found</p>
                  <p>Try a different word, or clear the category.</p>
                </div>
              ) : (
                <div className={styles.grid}>
                  {products.items.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={styles.card}
                      onClick={() => router.push(`/s/${p.store_code}`)}
                    >
                      <span className={styles.cardMedia}>
                        <Thumb path={p.image_path} name={p.name} ratio="1 / 1" />
                      </span>
                      <span className={styles.cardName}>{p.name}</span>
                      <span className={styles.storeTag}>{p.store_name}</span>
                      {p.price && (
                        <span className={styles.cardPrice}>
                          {formatMoney(p.price)}
                          <span className={styles.cardMeta}> / {p.unit_label}</span>
                        </span>
                      )}
                      <span className={styles.tags}>
                        <span
                          className={`${styles.tag} ${p.in_stock ? styles.tagIn : styles.tagOut}`}
                        >
                          {p.in_stock ? 'In stock' : 'Out of stock'}
                        </span>
                        {p.has_bulk && (
                          <span className={`${styles.tag} ${styles.tagBulk}`}>Bulk price</span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {products.hasMore && (
                <div ref={sentinelRef} className={styles.sentinel}>
                  {products.loadingMore ? 'Loading more…' : ''}
                </div>
              )}
            </>
          )}

          {/* Always reachable: someone handed a shop code needs a way to use it. */}
          <div style={{ marginTop: 'var(--space-6)' }}>
            <InfoPanel tone="info" title="Been given a shop code?">
              <p>
                If a seller gave you a code like <strong>K7M2QP</strong>, open{' '}
                <strong>storemanager.app/s/CODE</strong> to go straight to their shop.
              </p>
            </InfoPanel>
          </div>

          <div className={styles.empty}>
            <LogoMark size={40} />
            <p className={styles.emptyTitle}>Run a distribution business?</p>
            <p>
              Track stock in packs, half packs or any weight. Know what a delivery really cost
              after transport. See who owes you and which empties are still out.
            </p>
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Button size="large" onClick={() => router.push('/login?mode=signup')}>
                Open a shop — it is free to start
              </Button>
            </div>
          </div>
        </div>
      </main>
    </MarketShell>
  );
}
