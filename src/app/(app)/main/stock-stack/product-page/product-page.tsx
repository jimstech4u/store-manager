'use client';

import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { StockHistoryCard } from '@/components/stock/StockHistory';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { InfoPanel } from '@/components/ui/Explain';
import { Button } from '@/components/ui/Button';
import { PhotoUpload } from '@/components/ui/PhotoUpload';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { EditIcon, TrashIcon } from '@/components/ui/Icon';
import { getSupabase } from '@/lib/supabase/client';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useStackBack } from '@/hooks/useStackBack';
import { useProduct } from '@/lib/stacks/catalog-stack';
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

  /*
   * The product from the shared hook.
   *
   * This page pushes: an edit form, a photo editor, a price history. Held in a `useState` each of
   * those returned to a full-page "Loading" over a product that had not changed.
   */
  const { product, error, settled, reload: load } = useProduct(productId);
  const loading = !settled;

  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);


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
    <PageScaffold
      onBack={goBack}
      title={product.name}
      subtitle={product.categoryName ?? store.name}
      actions={
        can('products.manage')
          ? [
              { key: 'edit', icon: <EditIcon />, onClick: () => void nav.push('product_form_page', { id: productId }),
                ariaLabel: 'Edit this item' },
              { key: 'remove', icon: <TrashIcon />, onClick: () => { setRemoveError(null); setRemoving(true); },
                ariaLabel: 'Remove this item' },
            ]
          : undefined
      }
    >
      {/*
        Removing asks for a reason and warns about stock still on the shelf.
        The server refuses outright while stock remains unless it is told to go ahead, so the
        sheet has to be able to say that and offer the override — otherwise the seller meets a
        raw database error with no way forward.
      */}
      <BottomSheet
        open={removing}
        onClose={() => setRemoving(false)}
        title={`Remove ${product.name}?`}
        footer={
          <div className={styles.removeActions}>
            <Button variant="secondary" onClick={() => setRemoving(false)} disabled={busy}>
              Keep it
            </Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setRemoveError(null);
                try {
                  const { error } = await getSupabase().rpc('archive_product', {
                    p_product_id: product.id,
                    p_reason: null,
                    p_force: onHand !== 0,
                  });
                  if (error) throw error;
                  setRemoving(false);
                  nav.pop();
                } catch (e) {
                  setRemoveError(e instanceof Error ? e.message : 'Could not remove it.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove it
            </Button>
          </div>
        }
      >
        {removeError && (
          <InfoPanel tone="danger" title="Not removed">
            {removeError}
          </InfoPanel>
        )}

        {onHand !== 0 && (
          <InfoPanel tone="warning" title={`There are still ${formatQty(product.onHand)} on the shelf`}>
            Removing it now takes that stock out of what your shop is worth. Do this only if the
            item is finished, written off, or was never really there.
          </InfoPanel>
        )}

        <p className={styles.removeNote}>
          Past sales keep this item and still add up correctly. It just stops appearing when you
          are selling or counting.
        </p>
      </BottomSheet>

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

      <StockHistoryCard
        productId={product.id}
        onOpen={() => void nav.push('stock_history_page', { id: product.id })}
      />

      <PhotoUpload
        storeId={store.id}
        productId={product.id}
        productName={product.name}
        canManage={can('products.manage')}
      />
    </PageScaffold>
  );
}
