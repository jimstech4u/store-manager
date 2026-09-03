'use client';

import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { InfoPanel } from '@/components/ui/Explain';
import { SearchLauncher } from '@/components/ui/SearchLauncher';
import { SearchSheet } from '@/components/ui/SearchSheet';
import { useSearchController } from '@academix-admin/search-viewer';
import { Button } from '@/components/ui/Button';
import { BoxIcon, ChevronRightIcon, PlusIcon } from '@/components/ui/Icon';
import { useNav } from '@academix-admin/navigation-stack';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useStackBack } from '@/hooks/useStackBack';
import { searchProducts, useProductList, type Product } from '@/lib/stacks/catalog-stack';
import {
  alsoReadsAs,
  leadUnit,
  stockInShapes,
  pricedUnit,
  useSellingUnits,
  useStockWorth,
  useUnitGaps,
} from '@/lib/stacks/selling-units';
import { useListChannel } from '@/hooks/useListChannel';
import { useInfiniteScroll } from '@/hooks/usePaginatedList';
import { formatMoney, formatQty, pluralUnit } from '@/lib/format';
import styles from './stock-page.module.css';

/**
 * What is on the shelf, what it cost, and what it is worth.
 *
 * Two data sources behind one list: typing switches to relevance-ordered search, an empty box
 * browses the whole catalogue with a cursor. A 300-line distributor cannot scroll to find
 * anything, and paging through fuzzy matches is not how anyone looks for a product.
 */
export default function StockPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();

  /*
   * The list browses; searching happens in the SearchViewer sheet.
   *
   * The page used to switch its own list between "browse" and "search results", which meant the
   * results were squeezed under the box that produced them with the keyboard over the top. The
   * sheet gets the whole screen, and this page goes back to doing one thing.
   */
  const [searchId, searchOps, isSearchOpen] = useSearchController();

  const browse = useProductList(store?.id ?? null);

  /*
   * Everything on this screen is said in the unit the shop SELLS in.
   *
   * "1,596 pieces" is true of something bought and sold in packs, and useless — nobody counts,
   * orders or prices pieces. Base units stay the arithmetic; they stop being what anybody reads.
   */
  const { byProduct } = useSellingUnits(store?.id ?? null);

  /*
   * Stock that can arrive and can never leave.
   *
   * Something received in kilogrammes and sold only in litres, where nobody ever said what a
   * kilogramme is worth, quietly climbs forever: no sale can move it, and every count from then on
   * has to be argued around it. The catalogue refuses to save one now — but a shop may be carrying
   * some from before that rule, and those get found by being SHOWN, not by somebody opening eight
   * hundred products one at a time looking for them.
   */
  const { gaps } = useUnitGaps(store?.id ?? null);

  /*
   * A delivery, a count or a damage changes ONE product's stock.
   *
   * This list is what a shop scrolls to find something on a shelf, so re-reading it because one
   * figure moved throws away the position they were at — for a number they could have been handed.
   * The screen that recorded the movement knows the product and the new quantity.
   */
  useListChannel<Product>('products', browse.items, browse.setItems);
  const products = browse.products;
  const loading = browse.loading;
  const error = browse.error;

  const sentinelRef = useInfiniteScroll(browse.loadMore, {
    enabled: browse.hasMore && !browse.loading,
  });

  /*
   * What the shelf is worth, asked of the shop.
   *
   * This used to add up the rows the page happened to be holding, labelled "Loaded so far, worth".
   * Honest about being partial and useless as a figure — a shop with eight hundred lines would
   * have to scroll the whole catalogue into memory to learn what its stock is worth, and would
   * still be reading an accumulation of page loads rather than a statement.
   */
  const worth = useStockWorth(store?.id ?? null);
  const anyEstimated = products.some((p) => p.costIsEstimated);

  if (!store) return null;

  if (loading && products.length === 0) {
    return <FullPageMessage title="Loading your stock" tone="loading" />;
  }

  if (error && products.length === 0) {
    return (
      <FullPageMessage
        title="Could not load your stock"
        tone="error"
        action={
          <Button fullWidth onClick={browse.reload}>
            Try again
          </Button>
        }
      >
        {error}
      </FullPageMessage>
    );
  }

  return (
    <PageScaffold
      onBack={goBack}
      title="Stock"
      subtitle={store.name}
      /*
       * Both actions live in the header now.
       *
       * "Record a delivery" was a bar pinned to the bottom of this page: it cost a row of the
       * list on every screen and covered the last product. Two icons here cost nothing, and the
       * header is where the other action already was.
       */
      actions={[
        ...(can('stock.receive')
          ? [
              {
                key: 'receive',
                icon: <BoxIcon />,
                onClick: () => void nav.push('receive_page'),
                ariaLabel: 'Record a delivery',
              },
            ]
          : []),
        ...(can('products.manage')
          ? [
              {
                key: 'add',
                icon: <PlusIcon />,
                onClick: () => void nav.push('product_form_page'),
                ariaLabel: 'Add an item you sell',
              },
            ]
          : []),
      ]}
    >
      <SearchLauncher
        label="Search your stock"
        placeholder="Search products or a category"
        onOpen={searchOps.open}
      />

      <SearchSheet<Product>
        id={searchId}
        isOpen={isSearchOpen}
        onClose={searchOps.close}
        placeholder="Search products or a category"
        // What is already loaded answers the first keystroke with no round trip.
        onInitialData={(text) => {
          const t = text.trim().toLowerCase();
          if (!t) return browse.products;
          return browse.products.filter(
            (p) =>
              p.name.toLowerCase().includes(t) ||
              (p.categoryName ?? '').toLowerCase().includes(t) ||
              (p.sku ?? '').toLowerCase().includes(t),
          );
        }}
        localDataDeps={[browse.products]}
        queryData={async (_cursor, text) => ({ data: await searchProducts(store.id, text) })}
        keyOf={(p) => p.id}
        emptyText="Try part of the name, or a category like “water”."
        renderRow={(p) => (
          <button
            type="button"
            className={styles.item}
            onClick={async () => {
              // Navigate first, then close — see money-page for why the order matters.
              await nav.push('product_page', { id: p.id });
              searchOps.close();
            }}
          >
            <div className={styles.itemMain}>
              <p className={styles.itemName}>{p.name}</p>
              <p className={styles.itemMeta}>
                {(() => {
                  const lead = leadUnit(byProduct.get(p.id));
                  return lead
                    ? `${formatMoney(lead.cost, 2)} per ${lead.name.toLowerCase()} cost`
                    : `${formatMoney(p.avgUnitCost, 2)} per ${p.baseUnit} cost`;
                })()}
                {p.categoryName && <span>· {p.categoryName}</span>}
              </p>
            </div>
            <div className={styles.itemQty}>
              {(() => {
                const shapes = byProduct.get(p.id);
                if (shapes && shapes.length > 0) {
                  return <span className={styles.qtyShapes}>{stockInShapes(shapes)}</span>;
                }
                const qty = Number(p.onHand);
                const unit = pluralUnit(p.baseUnit, qty);
                return (
                  <>
                    <span className={styles.qtyValue}>{formatQty(qty)}</span>
                    <span className={styles.qtyUnit}>{unit}</span>
                  </>
                );
              })()}
            </div>
          </button>
        )}
      />

      {products.length === 0 ? (
        <InfoPanel tone="info" title="Nothing here yet">
          Add what you sell and it will show up here with what it cost and what you have left.
        </InfoPanel>
      ) : (
        <>
          {(
            <div className={styles.summary}>
              <span className={styles.summaryLabel}>Stock is worth</span>
              <span className={styles.summaryValue}>{formatMoney(worth.total)}</span>
              <span className={styles.summaryNote}>
                at what it cost you, not what you sell it for
                {worth.estimated > 0 && (
                  <>
                    {' · '}
                    {formatMoney(worth.estimated)} of it still estimated
                  </>
                )}
              </span>
            </div>
          )}

          {gaps.length > 0 && (
            <InfoPanel
              tone="warning"
              id="stock.gaps"
              title={`${gaps.length} ${gaps.length === 1 ? 'item has' : 'items have'} stock that cannot be sold`}
            >
              {gaps.slice(0, 3).map((g) => (
                <p key={g.productId}>
                  <strong>{g.productName}</strong> is bought in {g.units.join(', ')}, and nothing is
                  sold in {g.units.length === 1 ? 'it' : 'them'}.
                </p>
              ))}
              {gaps.length > 3 && <p>…and {gaps.length - 3} more.</p>}
              <p>
                Open the item and either sell in that unit too, or say what one of them is worth in
                a unit you do sell in — one bag is 24 litres, and so on. Until then that stock sits
                there and no sale can touch it.
              </p>
            </InfoPanel>
          )}

          {anyEstimated && (
            <InfoPanel tone="warning" id="stock.estimated" title="Some costs are still estimates">
              Items marked <strong>estimated</strong> use the figure entered at setup. The next
              delivery you record replaces it with the real cost, including fees.
            </InfoPanel>
          )}

          <ul className={styles.list}>
            {products.map((p) => {
              const sellingUnits = byProduct.get(p.id) ?? [];
              const lead = leadUnit(sellingUnits);
              const onHand = lead ? lead.onHand : Number(p.onHand);
              const out = onHand <= 0;
              return (
                <li key={p.id}>
                  {/* A button, not a div with onClick: this has to be reachable by keyboard and
                      announced as an action, and the whole row is the target so it is easy to hit
                      without aiming. */}
                  <button
                    type="button"
                    className={styles.item}
                    onClick={() => nav.push('product_page', { id: p.id })}
                  >
                  <div className={styles.itemMain}>
                    <p className={styles.itemName}>{p.name}</p>
                    <p className={styles.itemMeta}>
                      {lead
                        ? `${formatMoney(lead.cost, 2)} per ${lead.name.toLowerCase()} cost`
                        : `${formatMoney(p.avgUnitCost, 2)} per ${p.baseUnit} cost`}
                      {pricedUnit(sellingUnits)?.price != null && (
                        <span>· sells for {formatMoney(pricedUnit(sellingUnits)!.price!)}</span>
                      )}
                      {p.categoryName && <span>· {p.categoryName}</span>}
                      {p.costIsEstimated && <span className={styles.estimate}>estimated</span>}
                    </p>

                    {/*
                      The same stock, said in the other units it is sold in.

                      Written as "the same as 12.5 Kgs" and never as a bare second figure, because a
                      bare figure under the first one reads as MORE STOCK. There is one pool behind
                      both — cooking oil sold in litres and in kilogrammes is one drum — and a
                      screen that lets somebody add the two lines together has told them they have
                      twice what they have.
                    */}
                    {sellingUnits.length > 1 && (
                      <p className={styles.itemMeta}>{alsoReadsAs(sellingUnits, lead)}</p>
                    )}
                  </div>
                  {/*
                    WHAT IS ON THE SHELF, SAID IN SHAPES.

                    This read "99.67 crates" — a division of 1,196 bottles by twelve. No shop says
                    that, and nobody can check it against a shelf: the eight loose bottles, which
                    are the whole reason the figure is not round, disappeared into a decimal.
                  */}
                  <div className={styles.itemQty}>
                    {sellingUnits.length > 0 ? (
                      <span className={`${styles.qtyShapes} ${out ? styles.qtyLow : ''}`}>
                        {stockInShapes(sellingUnits)}
                      </span>
                    ) : (
                      <>
                        <span className={`${styles.qtyValue} ${out ? styles.qtyLow : ''}`}>
                          {formatQty(onHand)}
                        </span>
                        <span className={styles.qtyUnit}>
                          {pluralUnit(p.baseUnit, Number(p.onHand))}
                        </span>
                      </>
                    )}
                  </div>
                  <ChevronRightIcon className={styles.itemChevron} />
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Sentinel: loading starts before this is visible, so the list stays ahead of the
              reader rather than stalling at the bottom. */}
          {browse.hasMore && (
            <div ref={sentinelRef} className={styles.sentinel}>
              {browse.loadingMore ? 'Loading more…' : ''}
            </div>
          )}
        </>
      )}
    </PageScaffold>
  );
}
