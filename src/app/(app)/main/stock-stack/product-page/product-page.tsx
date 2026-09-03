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
import { ChevronRightIcon, EditIcon, TrashIcon } from '@/components/ui/Icon';
import { getSupabase } from '@/lib/supabase/client';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useStackBack } from '@/hooks/useStackBack';
import { useProduct, type Product } from '@/lib/stacks/catalog-stack';
import { useListNotifier } from '@/hooks/useListChannel';
import { useSellingUnits } from '@/lib/stacks/selling-units';
import { unitGaps, useProductUnits } from '@/lib/stacks/product-units';
import { useProductEmpties } from '@/lib/stacks/empties';
import { formatMoney, formatQty, pluralUnit, messageOf } from '@/lib/format';
import styles from './product-page.module.css';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';

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

  // Told when this item is removed, so the stock list loses it without being re-read.
  const notifyProducts = useListNotifier<Product>('products');
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

  /*
   * What this is sold in, and whether anything it arrives in has been left unanswered for.
   *
   * Read here rather than only on the editor, because the warning has to be visible to somebody
   * who came to look at the item — a gap found by opening a form nobody had a reason to open is a
   * gap that stays there.
   */
  const { byProduct } = useSellingUnits(store?.id ?? null);
  const { units: productUnits } = useProductUnits(productId);
  const { empties } = useProductEmpties(productId);
  const sellingUnits = byProduct.get(productId ?? '') ?? [];
  const gapUnits = unitGaps(productUnits).map((u) => u.name.toLowerCase());

  const [removing, setRemoving] = useState(false);
  const removeError = useProblem();
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
              { key: 'remove', icon: <TrashIcon />, onClick: () => setRemoving(true),
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
                try {
                  const { error } = await getSupabase().rpc('archive_product', {
                    p_product_id: product.id,
                    p_reason: null,
                    p_force: onHand !== 0,
                  });
                  if (error) throw error;

                  /*
                   * The list is told it is gone.
                   *
                   * Without this the item stayed on the stock screen until something re-read it,
                   * so a shop removed something, pressed Back, saw it still there, and removed it
                   * again — or reached for a page refresh. This device knows exactly which row
                   * went; asking the server to say so is asking a question we answered.
                   */
                  notifyProducts({ type: 'remove', id: product.id });

                  setRemoving(false);
                  nav.pop();
                } catch (e) {
                  removeError.show(messageOf(e, 'Could not remove it.'));
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
      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={removeError} title="Not removed" />

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

      {/*
        WHAT IS OUT IN CUSTOMERS' YARDS.

        The shelf figure and the cost were the whole story here, so an item whose crates are all
        out on loan looked identical to one whose crates are stacked out the back. For a shop whose
        containers are worth more than a day's takings, that is the more urgent number.

        Said in POOLS, because that is where the obligation lives — a Gulder bottle and a Star
        bottle are the same NBL bottle to everyone involved. "How many Gulder bottles specifically"
        is unanswerable once a pool is shared, and answering it anyway would be inventing a figure.
      */}
      {empties.length > 0 && (
        <section className={styles.empties}>
          <h2 className={styles.emptiesTitle}>Containers out</h2>
          <ul className={styles.emptiesList}>
            {empties.map((e) => (
              <li key={e.category_id}>
                {/*
                  TAPPABLE, because the shape it comes back in is declared per POOL.

                  Reached from the product a shop happens to be looking at, since that is when it
                  thinks about crates — not from a settings screen nobody visits. Changing it here
                  changes it for every item sharing the pool, which is the whole point: one rule, so
                  a Heineken crate settles a Gulder obligation. The note below says so.
                */}
                <button
                  type="button"
                  className={styles.emptiesRow}
                  onClick={() => void nav.push('return_units_page', { id: e.category_id })}
                >
                <span>
                  <span className={styles.emptiesName}>{e.category}</span>
                  <span className={styles.emptiesMeta}>
                    {e.kind === 'content'
                      ? `${Number(e.qty_per_base_unit ?? 0)} per ${product.baseUnit}`
                      : 'counted when one leaves with the goods'}
                    {Number(e.suggested_deposit) > 0
                      ? ` · you usually hold ${formatMoney(Number(e.suggested_deposit))} each`
                      : ''}
                  </span>
                </span>
                <span className={styles.emptiesQty}>
                  {Number(e.units_out)}
                  <span className={styles.emptiesWho}>
                    {Number(e.customers_out) === 1 ? '1 customer' : `${Number(e.customers_out)} customers`}
                  </span>
                </span>
                </button>
              </li>
            ))}
          </ul>
          <p className={styles.emptiesNote}>
            Across every product that shares these pools, not this item alone — that is what the
            customer owes you back. Tap one to say what shape it comes back in.
          </p>
        </section>
      )}

      {/*
        How this is bought and sold.

        Its own screen rather than more fields on the edit form: a shop that takes oil in bags and
        sells it by the litre is answering a different question from what the thing is called, and
        the two crammed together is what produced a form asking about "the pack" as though every
        trade had exactly one shape.
      */}
      {can('products.manage') && (
        <button
          type="button"
          className={styles.unitsRow}
          onClick={() => void nav.push('units_page', { id: product.id })}
        >
          <span className={styles.unitsMain}>
            <span className={styles.unitsTitle}>The shapes it comes in</span>
            <span className={styles.unitsNote}>
              {sellingUnits.length > 0
                ? `Sold in ${sellingUnits.map((u) => u.plural.toLowerCase()).join(', ')}`
                : 'Not set up yet — say what a customer can buy'}
            </span>
          </span>
          <ChevronRightIcon />
        </button>
      )}

      {/*
        Stock that can arrive and never leave: received in a unit nothing is sold in, with nobody
        having said what one of them is worth. Shown here, on the item itself, because this is the
        one screen where it can be fixed.
      */}
      {gapUnits.length > 0 && (
        <InfoPanel tone="danger" title="Some of this can come in but never go out">
          You take delivery in {gapUnits.join(', ')}, and nothing is sold in{' '}
          {gapUnits.length === 1 ? 'it' : 'them'}. Open <strong>The shapes it comes in</strong> and
          say what one is worth in something you do sell.
        </InfoPanel>
      )}

      <StockHistoryCard
        productId={product.id}
        onOpen={() => void nav.push('stock_history_page', { id: product.id })}
      />

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
