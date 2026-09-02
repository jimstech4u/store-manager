'use client';

import styles from './count-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { PlusIcon } from '@/components/ui/Icon';
import { SearchLauncher } from '@/components/ui/SearchLauncher';
import { SearchSheet } from '@/components/ui/SearchSheet';
import { useSearchController } from '@academix-admin/search-viewer';
import { useNav } from '@academix-admin/navigation-stack';
import { InfoPanel } from '@/components/ui/Explain';
import { ClipboardCheckIcon } from '@/components/ui/Icon';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useStackBack } from '@/hooks/useStackBack';
import { searchProducts, useProductList, type Product } from '@/lib/stacks/catalog-stack';
import { useListChannel } from '@/hooks/useListChannel';
import { formatQty, pluralUnit } from '@/lib/format';
import { leadUnit, useSellingUnits } from '@/lib/stacks/selling-units';

/**
 * The stock count — CRODS.
 *
 * The screen the whole data model exists to serve. Opening, received, sold and damaged are
 * computed from the movement ledger and shown read-only; the seller enters only what they
 * physically counted, and the gap between the two is the product's core output.
 *
 * The count is entered BEFORE the expected figure is revealed. Showing "should be 857" first
 * invites confirming that number rather than counting the shelf, which would quietly turn the
 * one honest input into a rubber stamp.
 */
export default function CountPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();

  // Browsing here; searching happens in the sheet, where the results get the whole screen.
  const [searchId, searchOps, isSearchOpen] = useSearchController();

  const browse = useProductList(store?.id ?? null);

  /*
   * What the records say, in the unit the shelf is counted in.
   *
   * "records say 1,596 pieces" next to a shelf holding 133 packs is a comparison nobody can make
   * standing in front of it, and the whole point of a count is that somebody can.
   */
  const { byProduct } = useSellingUnits(store?.id ?? null);

  const saidAs = (p: { id: string; onHand: string | number; baseUnit: string }) => {
    const unit = leadUnit(byProduct.get(p.id));
    const base = Number(p.onHand);
    if (!unit) return `${formatQty(base)} ${pluralUnit(p.baseUnit, base)}`;

    const n = base / unit.baseQty;
    return `${formatQty(n)} ${n === 1 ? unit.name : unit.plural}`;
  };

  /*
   * A product changed somewhere else lands here as one row.
   *
   * Both this screen and the other one that lists the catalogue read the same `products` list, so
   * a price edited on the product page, or an item added at the till, reaches whichever of them
   * happens to be mounted — and neither has to re-read a catalogue that may run to hundreds of
   * items to find out about one of them.
   */
  useListChannel<Product>('products', browse.items, browse.setItems);
  const products = browse.products;


  if (!store) return null;

  if (!can('stock.count')) {
    return (
      <PageScaffold onBack={goBack} title="Count" subtitle="Check the shelf against the records">
        <InfoPanel tone="info" title="Not part of your job here">
          Counting stock and closing the day is done by a manager or the owner.
        </InfoPanel>
      </PageScaffold>
    );
  }

  if (browse.loading && products.length === 0) {
    return <FullPageMessage title="Loading your products" tone="loading" />;
  }


  return (
    <PageScaffold
      title="Count"
      subtitle="Check the shelf against the records"
      /*
        ADDING IS A HEADER ACTION, the same as it is on Stock.

        It was a full-width button between the search and the list — the widest, greenest thing on
        a screen whose job is to work DOWN a list of what is already there. It read as the main
        action and it is not: the commonest thing a count turns up is something nobody entered, but
        it is still the uncommon case. The icon keeps it one tap away without competing with the
        list, and it puts the gesture where a shop has already learnt it.
      */
      actions={[
        {
          key: 'add',
          icon: <PlusIcon />,
          /*
            THE REAL FORM, PUSHED, and it asks for the count as one of its required answers — so
            somebody adding a thing they are looking at records how many there are in the same
            breath, rather than being asked twice.
          */
          onClick: () => void nav.push('product_form_page', { required: 'minimum' }),
          ariaLabel: 'Something not on this list',
        },
      ]}
    >
      <InfoPanel tone="info" title="Count the shelf, then we compare">
        Pick a product, count what is actually there, and we will tell you whether it matches what
        your records say it should be.
      </InfoPanel>

      <SearchLauncher
        label="Find a product to count"
        placeholder="Search products or a category"
        onOpen={searchOps.open}
      />


      <SearchSheet<Product>
        id={searchId}
        isOpen={isSearchOpen}
        onClose={searchOps.close}
        placeholder="Search products or a category"
        onInitialData={(text) => {
          const t = text.trim().toLowerCase();
          if (!t) return browse.products;
          return browse.products.filter(
            (p) =>
              p.name.toLowerCase().includes(t) ||
              (p.categoryName ?? '').toLowerCase().includes(t),
          );
        }}
        localDataDeps={[browse.products]}
        queryData={async (_cursor, text) => ({ data: await searchProducts(store.id, text) })}
        keyOf={(p) => p.id}
        emptyText="Try part of the name, or a category like “water”."
        renderRow={(p) => (
          <button
            type="button"
            className={styles.row}
            onClick={async () => {
              // Navigate first, then close — closing removes the overlay's history entry, and
              // doing that before the push lands discards the page just pushed.
              await nav.push('count_entry_page', { id: p.id });
              searchOps.close();
            }}
          >
            <span className={styles.rowMain}>
              <span className={styles.rowName}>{p.name}</span>
              <span className={styles.rowMeta}>
                records say {saidAs(p)}
              </span>
            </span>
            <ClipboardCheckIcon />
          </button>
        )}
      />

      {products.length === 0 ? (
        <InfoPanel tone="info" title="Nothing to count yet">
          Add what you sell under Stock, or use <strong>+</strong> at the top for something you are
          looking at right now.
        </InfoPanel>
      ) : (
        <ul className={styles.list}>
          {products.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={styles.row}
                onClick={() => void nav.push('count_entry_page', { id: p.id })}
              >
                <span className={styles.rowMain}>
                  <span className={styles.rowName}>{p.name}</span>
                  <span className={styles.rowMeta}>
                    records say {saidAs(p)}
                  </span>
                </span>
                <ClipboardCheckIcon />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ── Counting sheet ──────────────────────────────────────────────────────── */}
    </PageScaffold>
  );
}
