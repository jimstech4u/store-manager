'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from '../../(market)/market.module.css';
import { MarketShell } from '../../(market)/MarketShell';
import { Button } from '@/components/ui/Button';
import { SearchField, useDebounced } from '@/components/ui/SearchField';
import { InfoPanel } from '@/components/ui/Explain';
import { Thumb } from '@/components/ui/Thumb';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { ChevronLeftIcon, SearchIcon } from '@/components/ui/Icon';
import { useInfiniteScroll } from '@/hooks/usePaginatedList';
import {
  fetchPublicStore,
  fetchPublicTiers,
  usePublicProducts,
  type PublicProduct,
  type PublicStoreDetail,
  type PublicTier,
  fetchProductMedia,
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
export default function StorefrontPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const router = useRouter();

  const [store, setStore] = useState<PublicStoreDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
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
    query: debounced,
    storeId: store?.id ?? null,
    category,
  });

  const sentinelRef = useInfiniteScroll(products.loadMore, {
    enabled: products.hasMore && !products.loading,
  });

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
      <MarketShell>
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
      search={
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={`Search ${store.name}`}
          label={`Search ${store.name}`}
        />
      }
    >
      <section className={styles.hero}>
        <div className={styles.heroInner}>
          {/* An explicit way back to the marketplace.

              A shopper who arrived by typing a shop code has no history to go back TO, so the
              browser's own back button is either greyed out or leaves the site entirely. A link
              that always works is the difference between browsing and a dead end. */}
          <button type="button" className={styles.backLink} onClick={() => router.push('/')}>
            <ChevronLeftIcon size="1.1em" /> All shops
          </button>

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
                <button
                  key={p.id}
                  type="button"
                  className={styles.card}
                  onClick={() => {
                    setOpenProduct(p);
                    // A product a shopper is looking at deserves a URL. Replace rather than push:
                    // the Sheet already pushes its own history entry for the back gesture, and a
                    // second entry would mean two back presses to close one sheet.
                    window.history.replaceState(
                      window.history.state,
                      '',
                      `?item=${encodeURIComponent(p.id)}`,
                    );
                  }}
                >
                  <span className={styles.cardMedia}>
                    <Thumb path={p.image_path} name={p.name} ratio="1 / 1" />
                  </span>
                  <span className={styles.cardName}>{p.name}</span>
                  {p.category && <span className={styles.storeTag}>{p.category}</span>}
                  {p.price && (
                    <span className={styles.cardPrice}>
                      {formatMoney(p.price)}
                      <span className={styles.cardMeta}> / {p.unit_label}</span>
                    </span>
                  )}
                  <span className={styles.tags}>
                    <span className={`${styles.tag} ${p.in_stock ? styles.tagIn : styles.tagOut}`}>
                      {p.in_stock ? 'In stock' : 'Out of stock'}
                    </span>
                    {p.has_bulk && (
                      <span className={`${styles.tag} ${styles.tagBulk}`}>Cheaper in bulk</span>
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
        </div>
      </main>

      {/* ── One item, with its bulk ladder ──────────────────────────────────────── */}
      <BottomSheet
        open={openProduct !== null}
        onClose={() => {
          setOpenProduct(null);
          window.history.replaceState(window.history.state, '', window.location.pathname);
        }}
        title={openProduct?.name ?? ''}
        footer={
          <Button size="large" fullWidth onClick={() => setOpenProduct(null)}>
            Close
          </Button>
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
