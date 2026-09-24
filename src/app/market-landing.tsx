'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './(market)/market.module.css';
import { MarketShell } from './(market)/MarketShell';
import { InstallStrip } from '@/components/ui/InstallStrip';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/providers/AuthProvider';
import { SearchLauncher } from '@/components/ui/SearchLauncher';
import { SearchSheet } from '@/components/ui/SearchSheet';
import { useSearchController } from '@academix-admin/search-viewer';
import { ProductCard } from '@/components/market/ProductCard';
import { productHref } from '@/lib/marketplace/links';
import { InfoPanel } from '@/components/ui/Explain';
import { Thumb } from '@/components/ui/Thumb';
import { SearchIcon } from '@/components/ui/Icon';
import { LogoMark } from '@/components/ui/Logo';
import { useInfiniteScroll } from '@/hooks/usePaginatedList';
import {
  fetchPublicCategories,
  fetchPublicProductPage,
  fetchPublicStorePage,
  usePublicProducts,
  usePublicStores,
  type PublicCategory,
  type PublicProduct,
  type PublicStore,
} from '@/lib/stacks/storefront';

/**
 * One thing a marketplace search can find.
 *
 * A shopper typing does not know whether the word in their head is a shop or a product, so the
 * search answers with both rather than making them choose a tab first.
 */
type MarketHit =
  | { kind: 'shop'; shop: PublicStore }
  | { kind: 'product'; product: PublicProduct };

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
export default function MarketLanding() {
  const router = useRouter();
  const { session } = useAuth();

  /*
   * LAUNCHED AS AN APP? Then this page is not what was asked for.
   *
   * The manifest starts the installed app at `/main`, but a phone that installed it BEFORE that
   * keeps the old start_url — Android re-reads the manifest in its own time, and iOS reads it once,
   * at install. So an app installed a day ago still opens the public marketplace and still looks
   * logged out, and no amount of fixing the manifest reaches it.
   *
   * `display-mode: standalone` is true only when this is running as the installed app, never in a
   * browser tab — so a shop browsing the marketplace in Safari is left alone.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const asApp =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (asApp) router.replace('/main');
  }, [router]);
  /*
   * Search is its own surface here too — see the note on the shop page. The chips still narrow the
   * page; searching finds a shop or a product and goes to it.
   */
  const [searchId, searchOps, isSearchOpen] = useSearchController();
  const [category, setCategory] = useState<string | null>(null);
  const [categories, setCategories] = useState<PublicCategory[]>([]);

  const stores = usePublicStores('');
  const products = usePublicProducts({ query: '', category });

  useEffect(() => {
    void fetchPublicCategories().then(setCategories).catch(() => setCategories([]));
  }, []);

  const sentinelRef = useInfiniteScroll(products.loadMore, {
    enabled: products.hasMore && !products.loading,
  });

  const searching = category !== null;
  const nothingPublished =
    !stores.loading &&
    !products.loading &&
    stores.items.length === 0 &&
    products.items.length === 0 &&
    !searching;

  const heading = useMemo(() => category ?? 'What shops are selling', [category]);

  return (
    <MarketShell
      search={
        <SearchLauncher
          label="Search the marketplace"
          placeholder="Search products, categories or shops"
          onOpen={searchOps.open}
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
              {/*
                SIGNED IN ALREADY? Then the thing to offer is the shop, not a sign-in form. This page
                is public and people browse it, so it does not redirect — it just stops pretending
                not to know them.
              */}
              {session ? (
                <Button
                  size="large"
                  className={styles.heroPrimary}
                  onClick={() => router.push('/main')}
                >
                  Go to my shop
                </Button>
              ) : (
                <>
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
                </>
              )}
            </div>
          </div>
        </section>
      )}

      {/*
        SHOPS AND PRODUCTS IN ONE SEARCH, because a shopper does not know which one they are
        typing. "Ashabi" is a shop and "Gulder" is a product, and asking somebody to pick a tab
        before they have typed is asking them to answer a question about our database.
        
        Shops come first and only on the first page: there are few of them, the server caps the
        list, and a shop is a bigger answer than any single product. Paging past that is products,
        which is the long list.
      */}
      <SearchSheet<MarketHit>
        id={searchId}
        isOpen={isSearchOpen}
        onClose={searchOps.close}
        placeholder="Search products, categories or shops"
        maxWidth="960px"
        onInitialData={(text) => {
          const t = text.trim().toLowerCase();
          if (!t) return [];
          const hits: MarketHit[] = [];
          for (const shop of stores.items) {
            if (shop.name.toLowerCase().includes(t)) hits.push({ kind: 'shop', shop });
          }
          for (const product of products.items) {
            if (product.name.toLowerCase().includes(t)) hits.push({ kind: 'product', product });
          }
          return hits;
        }}
        localDataDeps={[stores.items, products.items]}
        queryData={async (cursor, text) => {
          const after = (cursor as { name: string; id: string } | undefined) ?? null;
          const page = await fetchPublicProductPage({ query: text, after });
          const hits: MarketHit[] = [];
          // Shops on the first page only — see the note above.
          if (!after) {
            for (const shop of await fetchPublicStorePage(text, 8)) hits.push({ kind: 'shop', shop });
          }
          for (const product of page.rows) hits.push({ kind: 'product', product });
          return { data: hits, cursor: page.cursor ?? undefined };
        }}
        keyOf={(hit) => (hit.kind === 'shop' ? `shop:${hit.shop.id}` : `product:${hit.product.id}`)}
        renderResults={(hits) => {
          const shops = hits.filter((h) => h.kind === 'shop');
          const found = hits.filter((h) => h.kind === 'product');
          return (
            <div key="results">
              {shops.length > 0 && (
                <>
                  <p className={styles.sectionNote}>
                    {shops.length} {shops.length === 1 ? 'shop' : 'shops'}
                  </p>
                  <div className={styles.storeGrid}>
                    {shops.map((h) => h.kind === 'shop' && (
                      <button
                        key={h.shop.id}
                        type="button"
                        className={styles.card}
                        onClick={() => {
                          searchOps.close();
                          router.push(`/s/${h.shop.code}`);
                        }}
                      >
                        <span className={styles.storeCover}>
                          <Thumb path={h.shop.cover_path} name={h.shop.name} ratio="16 / 9" />
                        </span>
                        <span className={styles.cardName}>{h.shop.name}</span>
                        <span className={styles.cardMeta}>
                          {h.shop.product_count}{' '}
                          {h.shop.product_count === 1 ? 'item' : 'items'} · code {h.shop.code}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {found.length > 0 && (
                <>
                  <p className={styles.sectionNote}>
                    {found.length} {found.length === 1 ? 'item' : 'items'}
                  </p>
                  <div className={styles.grid}>
                    {found.map((h) => h.kind === 'product' && (
                      <ProductCard
                        key={h.product.id}
                        product={h.product}
                        showShop
                        onOpen={(picked) => {
                          searchOps.close();
                          router.push(productHref(picked));
                        }}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        }}
        emptyText="No shop or product matches that."
      />

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
                    <ProductCard
                      key={p.id}
                      product={p}
                      showShop
                      onOpen={(picked) => router.push(productHref(picked))}
                    />
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

      {/*
        The offer to install, at the foot rather than in the hero. It used to sit under "Open a shop"
        as two lines of grey instructions on a dark photograph — permanently on, nothing to tap on
        Android, competing with the buttons this page exists for.
      */}
      <InstallStrip />
    </MarketShell>
  );
}
