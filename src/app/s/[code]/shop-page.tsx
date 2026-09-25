'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from '../../(market)/market.module.css';
import { MarketShell } from '../../(market)/MarketShell';
import { Button } from '@/components/ui/Button';
import { SearchLauncher } from '@/components/ui/SearchLauncher';
import { SearchSheet } from '@/components/ui/SearchSheet';
import { useSearchController } from '@academix-admin/search-viewer';
import { InfoPanel } from '@/components/ui/Explain';
import { Thumb } from '@/components/ui/Thumb';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { productHref } from '@/lib/marketplace/links';
import { ProductActions } from '@/components/market/ProductActions';
import { ProductCard } from '@/components/market/ProductCard';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { SearchIcon } from '@/components/ui/Icon';
import { useInfiniteScroll } from '@/hooks/usePaginatedList';
import {
  fetchPublicStore,
  fetchPublicTiers,
  usePublicProducts,
  type PublicProduct,
  type PublicStoreDetail,
  type PublicTier,
  fetchProductMedia,
  fetchPublicProductPage,
  type MediaItem,
} from '@/lib/stacks/storefront';
import { formatMoney, formatQty } from '@/lib/format';

/**
 * One shop's public page, reached by its code.
 *
 * The destination for "been given a shop code" — a seller reads out six characters and the buyer
 * lands here. Public, no sign-in, and deliberately limited to what a shelf edge shows: what is
 * sold, at what price, and whether it is in stock.
 */
export default function StorefrontPage({ code }: { code: string }) {
  const router = useRouter();

  const [store, setStore] = useState<PublicStoreDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  /*
   * SEARCH IS A SURFACE, NOT A BOX ON THIS PAGE.
   *
   * It was a field in the header that filtered the grid below it. On a phone the keyboard then
   * covers the results it is filtering, and every keystroke re-flows the page under the thumb. The
   * signed-in side of this app moved to a full-screen search viewer months ago; the public side was
   * the last place still doing it the old way.
   *
   * SEARCH FINDS A PRODUCT; THE CHIPS NARROW THE PAGE. They are different jobs and this is the
   * convention every other search in the app follows — a search ends by opening the thing that was
   * being looked for, not by leaving the page in a filtered state somebody has to undo.
   */
  const [searchId, searchOps, isSearchOpen] = useSearchController();
  const [category, setCategory] = useState<string | null>(null);

  const [openProduct, setOpenProduct] = useState<PublicProduct | null>(null);
  const [tiers, setTiers] = useState<PublicTier[] | null>(null);
  const [media, setMedia] = useState<MediaItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await fetchPublicStore(code);
        if (cancelled) return;
        if (!s) {
          setState('missing');
          return;
        }
        setStore(s);
        setState('ready');
      } catch {
        if (!cancelled) setState('missing');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const products = usePublicProducts({
    query: '',
    storeId: store?.id ?? null,
    category,
  });

  const sentinelRef = useInfiniteScroll(products.loadMore, {
    enabled: products.hasMore && !products.loading,
  });

  /*
   * Opening a product, from the grid or from a search result.
   *
   * The URL is REPLACED rather than pushed, because the sheet pushes its own history entry and two
   * would mean two back presses to close one sheet.
   */
  const openFromGrid = (p: PublicProduct) => {
    setOpenProduct(p);
    window.history.replaceState(window.history.state, '', productHref(p));
  };

  // The bulk ladder, fetched only when a shopper opens an item — it is a detail, not something
  // worth a request per card on a grid of twenty-four.
  useEffect(() => {
    if (!openProduct) {
      setTiers(null);
      setMedia(null);
      return;
    }
    let cancelled = false;
    void fetchPublicTiers(openProduct.id)
      .then((t) => !cancelled && setTiers(t))
      .catch(() => !cancelled && setTiers([]));
    void fetchProductMedia(openProduct.id)
      .then((m) => !cancelled && setMedia(m))
      .catch(() => !cancelled && setMedia([]));
    return () => {
      cancelled = true;
    };
  }, [openProduct]);

  if (state === 'loading') {
    return <FullPageMessage title="Opening shop" tone="loading" />;
  }

  if (state === 'missing' || !store) {
    return (
      <MarketShell back={{ to: '/', label: 'Back to all shops' }} title="Shop not found">
        <main className={styles.body}>
          <div className={styles.inner}>
            <InfoPanel tone="warning" title="No shop with that code">
              Check the code and try again. Shops also choose whether to appear publicly, so a
              shop that exists may simply not be listed.
            </InfoPanel>
            <Button size="large" fullWidth onClick={() => router.push('/')}>
              Browse other shops
            </Button>
          </div>
        </main>
      </MarketShell>
    );
  }

  return (
    <MarketShell
      back={{ to: '/', label: 'Back to all shops' }}
      title={store.name}
      search={
        <SearchLauncher
          label={`Search ${store.name}`}
          placeholder={`Search ${store.name}`}
          onOpen={searchOps.open}
        />
      }
    >
      <section className={styles.hero}>
        <div className={styles.heroInner}>
          <h1 className={styles.heroTitle}>{store.name}</h1>
          <p className={styles.heroText}>
            {store.description ?? 'Browse what this shop has, and what it costs.'}
          </p>
          <p className={styles.cardMeta}>Shop code {store.code}</p>
        </div>
      </section>

      <main className={styles.body}>
        <div className={styles.inner}>
          {store.categories.length > 0 && (
            <div className={styles.rail} role="group" aria-label="Categories">
              <button
                type="button"
                className={`${styles.chip} ${category === null ? styles.chipActive : ''}`}
                onClick={() => setCategory(null)}
                aria-pressed={category === null}
              >
                Everything
              </button>
              {store.categories.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  className={`${styles.chip} ${category === c.name ? styles.chipActive : ''}`}
                  onClick={() => setCategory(category === c.name ? null : c.name)}
                  aria-pressed={category === c.name}
                >
                  {c.name} ({c.count})
                </button>
              ))}
            </div>
          )}

          {products.items.length === 0 && !products.loading ? (
            <div className={styles.empty}>
              <SearchIcon size="34px" />
              <p className={styles.emptyTitle}>Nothing here</p>
              <p>This shop has not listed anything matching that.</p>
            </div>
          ) : (
            <div className={styles.grid}>
              {products.items.map((p) => (
                <ProductCard key={p.id} product={p} onOpen={openFromGrid} />
              ))}
            </div>
          )}

          {products.hasMore && (
            <div ref={sentinelRef} className={styles.sentinel}>
              {products.loadingMore ? 'Loading more…' : ''}
            </div>
          )}
        </div>
      </main>

      {/* ── Search, over the page rather than inside it ──────────────────────────── */}
      {/*
        RESULTS AS A GRID, not a column of rows.
        
        Every other search in this app lists text — a customer, a sale, a stock line — and a row is
        right for those. A shop's catalogue is pictures and prices, and the same two-across grid the
        page uses is what somebody is already scanning. So the viewer is handed the whole result set
        and lays it out with the page's own card.
      */}
      <SearchSheet<PublicProduct>
        id={searchId}
        isOpen={isSearchOpen}
        onClose={searchOps.close}
        placeholder={`Search ${store.name}`}
        maxWidth="960px"
        /*
         * The products already on the page answer the first keystroke with no request at all —
         * they are in memory, and this shop's catalogue is usually most of what is being looked
         * for. The server call behind it finds the rest.
         */
        onInitialData={(text) => {
          const t = text.trim().toLowerCase();
          if (!t) return products.items.slice(0, 24);
          return products.items.filter(
            (p) =>
              p.name.toLowerCase().includes(t) ||
              (p.category ?? '').toLowerCase().includes(t),
          );
        }}
        localDataDeps={[products.items]}
        queryData={async (cursor, text) => {
          const page = await fetchPublicProductPage({
            query: text,
            storeId: store.id,
            after: (cursor as { name: string; id: string } | undefined) ?? null,
          });
          return { data: page.rows, cursor: page.cursor ?? undefined };
        }}
        keyOf={(p) => p.id}
        renderResults={(rows) => (
          <div className={styles.grid} key="results">
            {rows.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                onOpen={(picked) => {
                  /*
                   * The search closes and the product opens. Leaving the viewer up behind a sheet
                   * would put two overlays on the screen and two things for Back to close.
                   */
                  searchOps.close();
                  openFromGrid(picked);
                }}
              />
            ))}
          </div>
        )}
        emptyText="This shop has not listed anything matching that."
      />

      {/* ── One item, with its bulk ladder ──────────────────────────────────────── */}
      <BottomSheet
        open={openProduct !== null}
        onClose={() => {
          setOpenProduct(null);
          window.history.replaceState(window.history.state, '', window.location.pathname);
        }}
        title={openProduct?.name ?? ''}
        /*
         * Wider than a form sheet. This one is mostly picture and price, and at 640px on a desktop
         * it read as a narrow column with the photograph squeezed into it. The cap cannot shrink a
         * phone — the sheet is already only as wide as the window there — so the floor is what
         * keeps small screens exactly as they were.
         */
        maxWidth="max(80dvw, 520px)"
        /*
         * THE FOOTER IS THE BASKET, not a Close button.
         *
         * Closing was already three things: the X in the title bar, a tap on the backdrop, and a
         * downward drag. A fourth spent the one pinned, always-visible place in the sheet on the
         * action a shopper least wants — and left the browsing path with no way to buy anything at
         * all. Every card on this grid opens this sheet, so this was the whole catalogue.
         */
        footer={
          openProduct ? (
            <ProductActions
              product={{
                id: openProduct.id,
                name: openProduct.name,
                price: openProduct.price,
                unit_label: openProduct.unit_label,
                image_path: openProduct.image_path,
                store_id: openProduct.store_id,
                store_code: store.code,
                store_name: store.name,
                in_stock: openProduct.in_stock,
              }}
              // The page has already read them for the ladder below; no second request.
              tiers={tiers}
            />
          ) : undefined
        }
      >
        {openProduct && (
          <>
            {media && media.length > 0 && (
              <div className={styles.gallery}>
                {media.map((m, i) => (
                  <div className={styles.galleryItem} key={i}>
                    <Thumb path={m.path} name={m.alt ?? openProduct.name} ratio="1 / 1" />
                  </div>
                ))}
              </div>
            )}

            <p className={styles.cardMeta}>
              {store.name}
              {openProduct.category ? ` · ${openProduct.category}` : ''}
            </p>

            {openProduct.price && (
              <p className={styles.cardPrice} style={{ fontSize: 'var(--text-3xl)' }}>
                {formatMoney(openProduct.price)}
                <span className={styles.cardMeta}> / {openProduct.unit_label}</span>
              </p>
            )}

            <p className={styles.tags}>
              <span
                className={`${styles.tag} ${openProduct.in_stock ? styles.tagIn : styles.tagOut}`}
              >
                {openProduct.in_stock ? 'In stock' : 'Out of stock'}
              </span>
            </p>

            {tiers && tiers.length > 0 && (
              <div style={{ marginTop: 'var(--space-5)' }}>
                <InfoPanel tone="info" title="Cheaper when you buy more">
                  {tiers.map((t, i) => (
                    <p key={i}>
                      {formatQty(t.min_qty)}
                      {t.max_qty ? ` – ${formatQty(t.max_qty)}` : ' or more'}:{' '}
                      <strong>{formatMoney(t.price)}</strong> each
                    </p>
                  ))}
                </InfoPanel>
              </div>
            )}

            <div style={{ marginTop: 'var(--space-5)' }}>
              <InfoPanel tone="info" title="How to buy">
                Prices are set by the shop. Contact them or visit to buy — mention the shop code{' '}
                <strong>{store.code}</strong>.
              </InfoPanel>
            </div>
          </>
        )}
      </BottomSheet>
    </MarketShell>
  );
}
