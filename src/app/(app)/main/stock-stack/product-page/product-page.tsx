'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { InfoPanel } from '@/components/ui/Explain';
import { Button } from '@/components/ui/Button';
import { PhotoUpload } from '@/components/ui/PhotoUpload';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useStackBack } from '@/hooks/useStackBack';
import { fetchProduct, type Product } from '@/lib/stacks/catalog-stack';
import { formatMoney, formatQty, pluralUnit } from '@/lib/format';
import styles from './product-page.module.css';

/**
 * One product: what it is, what it cost, what is left, and its pictures.
 *
 * Reached by tapping a row in Stock. The stock list deliberately shows very little per row — a
 * name, a cost and a count — because a list that shows everything is a list nobody can scan. This
 * is where the rest lives.
 */
export default function ProductPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const { can } = usePermission();

  const productId = (location?.params?.id as string | undefined) ?? null;

  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!productId) return;
    setLoading(true);
    setError(null);
    try {
      setProduct(await fetchProduct(productId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this product.');
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!store) return null;

  if (!productId) {
    // Reachable by editing the URL, since the stack serialises its params there. Better to say so
    // and offer the way back than to render an empty shell.
    return (
      <FullPageMessage title="No product was chosen" tone="error"
        action={<Button fullWidth onClick={() => nav.pop()}>Back to stock</Button>}>
        Open a product from the Stock list.
      </FullPageMessage>
    );
  }

  if (loading && !product) return <FullPageMessage title="Loading" tone="loading" />;

  if (error && !product) {
    return (
      <FullPageMessage title="Could not load this product" tone="error"
        action={<Button fullWidth onClick={() => void load()}>Try again</Button>}>
        {error}
      </FullPageMessage>
    );
  }

  if (!product) {
    return (
      <FullPageMessage title="That product is gone" tone="error"
        action={<Button fullWidth onClick={() => nav.pop()}>Back to stock</Button>}>
        It may have been removed since this page was opened.
      </FullPageMessage>
    );
  }

  const onHand = Number(product.onHand);

  return (
    <PageScaffold onBack={goBack} title={product.name} subtitle={product.categoryName ?? store.name}>
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt className={styles.factLabel}>On the shelf</dt>
          <dd className={`${styles.factValue} ${onHand <= 0 ? styles.low : ''}`}>
            {formatQty(product.onHand)}{' '}
            <span className={styles.factUnit}>{pluralUnit(product.baseUnit, onHand)}</span>
          </dd>
        </div>

        <div className={styles.fact}>
          <dt className={styles.factLabel}>What it cost you</dt>
          <dd className={styles.factValue}>
            {formatMoney(product.avgUnitCost, 2)}
            <span className={styles.factUnit}> per {product.baseUnit}</span>
          </dd>
        </div>

        {product.listPrice && (
          <div className={styles.fact}>
            <dt className={styles.factLabel}>
              You sell {product.packName ? `1 ${product.packName}` : 'it'} for
            </dt>
            <dd className={styles.factValue}>{formatMoney(product.listPrice)}</dd>
          </div>
        )}

        {product.sku && (
          <div className={styles.fact}>
            <dt className={styles.factLabel}>Your code</dt>
            <dd className={styles.factCode}>{product.sku}</dd>
          </div>
        )}

        {product.barcode && (
          <div className={styles.fact}>
            <dt className={styles.factLabel}>Barcode</dt>
            <dd className={styles.factCode}>{product.barcode}</dd>
          </div>
        )}
      </dl>

      {product.costIsEstimated && (
        <InfoPanel tone="warning" title="This cost is still an estimate">
          It is the figure entered at setup, not one from a real delivery. The next delivery you
          record for this item replaces it with what you actually paid, fees included.
        </InfoPanel>
      )}

      <PhotoUpload
        storeId={store.id}
        productId={product.id}
        productName={product.name}
        canManage={can('products.manage')}
      />
    </PageScaffold>
  );
}
