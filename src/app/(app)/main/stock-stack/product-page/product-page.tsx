'use client';

import { LEDGERS_SCOPE } from '@/lib/stacks/customer-ledgers';
import { setProductCountWhenLow, useProductCountWhenLow } from '@/lib/stacks/count-gate-settings';
import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { StockHistoryCard } from '@/components/stock/StockHistory';
import { InfoPanel } from '@/components/ui/Explain';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { PhotoUpload } from '@/components/ui/PhotoUpload';
import { ChevronRightIcon, EditIcon, TrashIcon } from '@/components/ui/Icon';
import { getSupabase } from '@/lib/supabase/client';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useStackBack } from '@/hooks/useStackBack';
import { useProduct, type Product } from '@/lib/stacks/catalog-stack';
import {
  clearShapeLowStock,
  setShapeLowStock,
  shapeLowLevels,
  useLowStockRule,
  type ShapeLowLevel,
} from '@/lib/stacks/low-stock';
import { useResource } from '@/lib/stacks/resource';
import { CATALOG_SCOPE } from '@/lib/stacks/customer-account';
import { useListNotifier } from '@/hooks/useListChannel';
import { stockInShapes, useSellingUnits } from '@/lib/stacks/selling-units';
import { unitGaps, useProductUnits } from '@/lib/stacks/product-units';
import { productEmptiesOut, type ShapeOut } from '@/lib/stacks/empties';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { saidAsPart } from '@/lib/empties-rollup';
import { formatMoney, formatQtySpoken, pluralUnit, messageOf } from '@/lib/format';
import styles from './product-page.module.css';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';

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
  const { can, canOpen } = usePermission();

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
  const {
    byProduct,
    loaded: unitsLoaded,
    error: unitsError,
    reload: reloadUnits,
  } = useSellingUnits(store?.id ?? null);
  const { units: productUnits } = useProductUnits(productId);

  /*
   * WHEN TO BE TOLD THIS ONE IS RUNNING OUT.
   *
   * Here as well as on the form and on the Running low page, and deliberately: somebody who has just
   * discovered this item ran out on Saturday is looking at THIS page — at what is on the shelf, what
   * it cost and how it sells. Sending them to a settings screen to act on what they are reading is
   * how a setting goes unused.
   *
   * The shop's general level comes along so the box can say what it is overriding. A level of 5 means
   * nothing without "everything else is 20" beside it.
   */
  const rule = useLowStockRule(store?.id ?? null);

  const [savingLow, setSavingLow] = useState(false);
  const [lowNote, setLowNote] = useState<string | null>(null);

  /*
   * The shapes that already have a level of their own, and the composer's two boxes.
   *
   * `removingLevel` holds the line being confirmed rather than a boolean, so the dialog can name
   * what it is about to undo — "put bottles back on the shop's level" rather than "are you sure".
   */
  const [addShape, setAddShape] = useState<string | null>(null);
  const [addLevel, setAddLevel] = useState('');
  const [removingLevel, setRemovingLevel] = useState<ShapeLowLevel | null>(null);
  const removeLevelDialog = useConfirm();

  /*
   * Read into its own area, so a failure says so.
   *
   * The pool reader swallowed its error and returned an empty list, which on this screen reads as
   * "nothing is out" — a statement about the shop made on the strength of a request that never
   * arrived.
   */
  const outArea = useLoadArea<ShapeOut[]>(() => productEmptiesOut(productId!), [productId], {
    key: `product-empties-out:${productId ?? 'none'}`,
    // A sale sends containers out, a return brings them back; both notify the ledgers.
    scope: LEDGERS_SCOPE,
    whenNot: !productId,
  });
  const sellingUnits = byProduct.get(productId ?? '') ?? [];
  const gapUnits = unitGaps(productUnits).map((u) => u.name.toLowerCase());

  /** Every shape, largest first — the order a shop names them in. */
  const shapes = [...sellingUnits].sort((a, b) => b.baseQty - a.baseQty);

  /*
   * THE SHAPE THE RUNNING-LOW LEVEL IS SAID IN, and how many base units one of them is.
   *
   * At component level rather than inside the control, because the field, the seeding and the
   * save all need the same answer. Three copies of "how many pieces is a crate" is three chances
   * to disagree, and the way that shows up is a level twelve times too small.
   */

  /** This item's own per-shape levels (0191), and the shapes still free to be given one. */
  const lowLevels = useResource<ShapeLowLevel[]>({
    key: `product-low-levels:${productId ?? 'none'}`,
    scope: CATALOG_SCOPE,
    deps: [productId ?? ''],
    read: () => shapeLowLevels(productId as string),
    enabled: Boolean(productId),
  });
  /*
   * COUNT WHEN LOW, this item's say (0250): follows the shop until ticked or unticked here, and
   * "Follow the shop" puts it back.
   */
  const countLow = useProductCountWhenLow(productId ?? null);
  const [savingCountLow, setSavingCountLow] = useState(false);
  const taken = new Set((lowLevels.data ?? []).map((l) => l.productUnitId));
  const freeShapes = shapes.filter((u) => !taken.has(u.productUnitId));
  const shopSaidGeneral = rule.data?.level == null ? null : formatQtySpoken(rule.data.level);


  const removeDialog = useConfirm();
  const [removing, setRemoving] = useState(false);
  const removeError = useProblem();
  const [busy, setBusy] = useState(false);


  if (!store) return null;

  /*
   * ONE HEADER, whatever the body has to say. No product chosen is reachable by editing the URL,
   * since the stack serialises its params there; the header's back arrow is the way out.
   */
  const status: PageStatus = !productId
    ? { state: 'empty', title: 'No product was chosen', body: 'Open a product from the Stock list.' }
    : product
      ? unitsLoaded
        ? { state: 'ready' }
        : // Its shapes and prices are most of this page; "no shapes yet" before they are read is
          // a claim about the item nobody has checked.
          unitsError
          ? { state: 'error', what: 'its shapes and prices', error: unitsError, onRetry: reloadUnits }
          : { state: 'loading', what: 'its shapes and prices' }
      : error
        ? { state: 'error', what: 'this product', error, onRetry: () => void load() }
        : loading
          ? { state: 'loading', what: 'this product' }
          : {
              state: 'empty',
              title: 'That product is gone',
              body: 'It may have been removed since this page was opened.',
            };

  const onHand = Number(product?.onHand ?? 0);

  return (
    <PageScaffold
      onBack={goBack}
      title={product?.name ?? 'Item'}
      subtitle={product ? product.categoryName ?? store.name : undefined}
      actions={
        product && can('products.manage')
          ? [
              { key: 'edit', icon: <EditIcon />, onClick: () => void nav.push('product_form_page', { id: productId }),
                ariaLabel: 'Edit this item' },
              /*
                Not offered again while the last one is still going. The dialog closes the moment
                it is confirmed, so the bin was live again for the second the archive took — and a
                second tap sends a second `archive_product` for an item already gone.
              */
              { key: 'remove', icon: <TrashIcon />, onClick: () => { if (!busy) setRemoving(true); },
                ariaLabel: busy ? 'Removing this item' : 'Remove this item' },
            ]
          : undefined
      }
    >
      <PageState status={status}>
        {() =>
          product && (
            <>
      {/*
        Removing asks for a reason and warns about stock still on the shelf.
        The server refuses outright while stock remains unless it is told to go ahead, so the
        sheet has to be able to say that and offer the override — otherwise the seller meets a
        raw database error with no way forward.
      */}
      <ProblemDialog problem={removeError} title="Not removed" />

      {/*
        A CONFIRMATION IS A DIALOG (DialogViewer), not a bottom sheet — and mounted only while it is
        being asked, because `ConfirmDialog` opens itself on mount.
      */}
      {removing && (
        <ConfirmDialog
          controller={removeDialog}
          title={`Remove ${product.name}?`}
          message={
            (onHand !== 0
              ? `There ${onHand === 1 ? 'is' : 'are'} still ${
                  sellingUnits.length > 0
                    ? stockInShapes(sellingUnits)
                    : `${formatQtySpoken(product.onHand)} ${pluralUnit(product.baseUnit, onHand)}`
                } on the shelf. Removing it now takes that stock out of what your shop is worth — ` +
                'do this only if the item is finished, written off, or was never really there. '
              : '') +
            'Past sales keep this item and still add up correctly. It just stops appearing when ' +
            'you are selling or counting.'
          }
          confirmText="Remove it"
          cancelText="Keep it"
          tone="danger"
          onDismiss={() => setRemoving(false)}
          onConfirm={() => {
            void (async () => {
              setBusy(true);
              try {
                const { error } = await getSupabase().rpc('archive_product', {
                  p_product_id: product.id,
                  p_reason: null,
                  p_force: onHand !== 0,
                });
                if (error) throw error;
                // The list is told it is gone — this device knows exactly which row went.
                notifyProducts({ type: 'remove', id: product.id });
                nav.pop();
              } catch (e) {
                removeError.show(messageOf(e, 'Could not remove it.'));
              } finally {
                setBusy(false);
              }
            })();
          }}
        />
      )}

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt className={styles.factLabel}>On the shelf</dt>
          <dd className={`${styles.factValue} ${onHand <= 0 ? styles.low : ''}`}>
            {/*
              IN THE SHAPES THE SHOP NAMES.

              This said "1196 bottles" — true, and not what a distributor keeps in their head or
              can check against a wall of crates. The base unit is the unit the ARITHMETIC is done
              in; it was never meant to be the unit the shop is spoken to in.
            */}
            {sellingUnits.length > 0 ? (
              stockInShapes(sellingUnits)
            ) : (
              <>
                {formatQtySpoken(product.onHand)}{' '}
                <span className={styles.factUnit}>{pluralUnit(product.baseUnit, onHand)}</span>
              </>
            )}
          </dd>
        </div>

        {/*
          IN A SHAPE THE SHOP NAMED.

          This read "₦422.40 per piece" three inches under "Sold in packs, bottles" — "piece" being
          the base unit, which this product has no shape for and nobody here says. The stock list one
          tap earlier says "cost ₦5,068.80 a pack", and the two screens are about the same item.
        */}
        {/*
          WHAT EACH SHAPE COSTS AND SELLS FOR, in one table.

          This was two separate facts that each picked their own shape — cost in the counting shape,
          price in whichever shape carried one — so a product could read "₦422.40 per piece" above
          "You sell 1 pack for ₦5,200" and look like a shop that buys pieces and sells packs.

          A product has no single cost or price. A crate costs what twelve bottles cost and sells
          for what the shop charges for a crate, and saying both against each shape is the only
          version of this that cannot contradict itself.
        */}
        {shapes.length > 0 ? (
          <div className={styles.shapeMoney}>
            <div className={`${styles.shapeRow} ${styles.shapeHead}`}>
              <span>Shape</span>
              <span>Cost</span>
              <span>You sell for</span>
            </div>
            {shapes.map((u) => (
              <div className={styles.shapeRow} key={u.productUnitId}>
                <span className={styles.shapeName}>
                  {u.name}
                  {u.baseQty > 1 && <span className={styles.shapeOf}> of {u.baseQty}</span>}
                </span>
                <span>{u.avgCost > 0 ? formatMoney(u.avgCost, 2) : '—'}</span>

                {/*
                  THE PRICE IS THE CONTROL, because it is the figure a shop changes.

                  Tapping it opens one field with the cost beside it, rather than the eleven-question
                  edit form or the shapes screen — which sends the whole tree back to move one
                  number. Only for a shape customers actually buy in: a price on any other can never
                  reach a receipt.
                */}
                {u.isSold && !canOpen('shape_price_page') ? (
                  // Somebody who cannot change prices reads the price; it is not a button for them.
                  <span className={styles.shapePrice}>
                    {u.price != null ? formatMoney(u.price) : 'no price yet'}
                  </span>
                ) : u.isSold ? (
                  <button
                    type="button"
                    className={styles.shapePriceButton}
                    onClick={() =>
                      void nav.push('shape_price_page', {
                        id: product.id,
                        shape: u.productUnitId,
                      })
                    }
                  >
                    {u.price != null ? formatMoney(u.price) : 'set a price'}
                  </button>
                ) : (
                  <span className={styles.shapePrice}>not sold</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.fact}>
            <dt className={styles.factLabel}>What it cost you</dt>
            <dd className={styles.factValue}>
              {formatMoney(product.avgUnitCost, 2)}
              <span className={styles.factUnit}> a {product.baseUnit}</span>
            </dd>
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
        WHAT IS OUT, IN THIS ITEM'S OWN SHAPES.

        This read `product_empties`, which answers in POOLS — so a page about Goldberg showed
        "NBL bottle 2940 · 60 customers", a figure covering eight beers, and the note underneath
        had to admit it: "across every product that shares these pools, not this item alone". A
        shop reads the number on the page it is looking at as being about the item it is looking
        at, and it was not.

        It also said "you usually hold ₦125 each" and offered a tap through to declare the pool's
        return shapes. Both are gone: a deposit is a round sum against a customer rather than a
        rate per container (0109), and which shapes come back is a tick on the shape, asked on the
        product form where the shapes are defined.
      */}
      {/*
        ─── RUNNING LOW, FOR THIS ITEM ───────────────────────────────────────────

        Blank means it follows the shop's level. Zero does not: zero is a real level meaning "tell me
        only when there are none at all", which is the right answer for something rare that gets
        ordered in when a customer asks for it. The two are kept apart the whole way down to the
        column, so an empty box can never be saved as a nought.
      */}
      {/*
        ── A LEVEL FOR EACH SHAPE, as a list ──────────────────────────────────────────

        The shop sets one general level and it means that many of WHATEVER SHAPE you are looking
        at: ten crates, and ten bottles. This is where an item disagrees — crates at 25 because
        they move, bottles left on the shop's ten, or bottles at 5 because a handful is plenty.

        A LIST rather than one box, because there is no single right answer for an item sold two
        ways, and the old single box had to pick one shape and convert the other — which is how a
        general level of 10 came to be displayed as "0.8333 packs".

        The selector only offers shapes that have no line yet, so once every shape is spoken for
        there is nothing left to add and the composer goes.
      */}
      <section className={styles.empties}>
        <h2 className={styles.emptiesTitle}>Running low</h2>

        <p className={styles.lowIntro}>
          {shopSaidGeneral == null
            ? 'Your shop has no general level, so nothing warns unless you set one here.'
            : `Your shop warns at ${shopSaidGeneral} of any shape. Set a different level below for
               a shape that should be treated differently.`}
        </p>

        {lowLevels.data === null && !lowLevels.error && (
          <p className={styles.lowIntro}>Reading this item&rsquo;s levels…</p>
        )}

        {(lowLevels.data ?? []).map((l) => (
          <div className={styles.lowLine} key={l.productUnitId}>
            <button
              type="button"
              className={styles.lowRemove}
              aria-label={`Put ${l.plural.toLowerCase()} back on the shop's level`}
              onClick={() => setRemovingLevel(l)}
            >
              ×
            </button>
            <span className={styles.lowLineText}>
              <strong>{l.plural}</strong> at {formatQtySpoken(l.level)}
            </span>
          </div>
        ))}

        {freeShapes.length > 0 && (
          <div className={styles.lowAdd}>
            <label className={styles.lowShape}>
              <span className={styles.lowShapeLabel}>Shape</span>
              <select
                className={styles.lowShapeSelect}
                value={addShape ?? freeShapes[0].productUnitId}
                onChange={(e) => setAddShape(e.target.value)}
              >
                {freeShapes.map((u) => (
                  <option key={u.productUnitId} value={u.productUnitId}>
                    {u.plural}
                  </option>
                ))}
              </select>
            </label>

            <Field
              label="Warn me at"
              numeric
              value={addLevel}
              onChange={(e) => setAddLevel(e.target.value)}
              placeholder="e.g. 25"
            />

            <Button
              variant="secondary"
              fullWidth
              busy={savingLow}
              busyLabel="Adding"
              disabled={addLevel.trim() === '' || !Number.isFinite(Number(addLevel))}
              onClick={async () => {
                const unitId = addShape ?? freeShapes[0].productUnitId;
                setSavingLow(true);
                setLowNote(null);
                try {
                  await setShapeLowStock(product.id, unitId, Number(addLevel));
                  setAddLevel('');
                  setAddShape(null);
                  await lowLevels.reload();
                } catch (e: unknown) {
                  setLowNote(messageOf(e, 'Could not add that level'));
                } finally {
                  setSavingLow(false);
                }
              }}
            >
              Add this level
            </Button>
          </div>
        )}

        {countLow.data && (
          <label className={styles.countLow}>
            <input
              type="checkbox"
              checked={countLow.data.own ?? countLow.data.shop}
              disabled={savingCountLow}
              onChange={async (e) => {
                setSavingCountLow(true);
                setLowNote(null);
                try {
                  await setProductCountWhenLow(product.id, e.target.checked);
                  countLow.reload();
                } catch (err: unknown) {
                  setLowNote(messageOf(err, 'Could not save that'));
                } finally {
                  setSavingCountLow(false);
                }
              }}
            />
            <span className={styles.countLowBody}>
              <span>Count it when it runs low</span>
              <span className={styles.countLowNote}>
                {countLow.data.own === null
                  ? `Following the shop (${countLow.data.shop ? 'on' : 'off'}).`
                  : `Set for this item — the shop is ${countLow.data.shop ? 'on' : 'off'}.`}
              </span>
              {countLow.data.own !== null && (
                <button
                  type="button"
                  className={styles.countLowFollow}
                  disabled={savingCountLow}
                  onClick={async (e) => {
                    e.preventDefault();
                    setSavingCountLow(true);
                    try {
                      await setProductCountWhenLow(product.id, null);
                      countLow.reload();
                    } catch (err: unknown) {
                      setLowNote(messageOf(err, 'Could not save that'));
                    } finally {
                      setSavingCountLow(false);
                    }
                  }}
                >
                  Follow the shop
                </button>
              )}
            </span>
          </label>
        )}

        {lowNote && <p className={styles.lowNote}>{lowNote}</p>}

        {/*
          Confirmed, because removing a line is not the same as setting it to nought — it puts the
          shape back under the shop's general level, and somebody who meant "never warn me" would
          otherwise get the opposite of what they asked for.
        */}
        {removingLevel && (
          <ConfirmDialog
            controller={removeLevelDialog}
            title={`Put ${removingLevel.plural.toLowerCase()} back on the shop's level?`}
            message={`This item warns at ${formatQtySpoken(removingLevel.level)} ${removingLevel.plural.toLowerCase()}. Removing that means it follows the shop${
              shopSaidGeneral == null ? '' : `, which warns at ${shopSaidGeneral}`
            }.`}
            confirmText="Remove it"
            tone="danger"
            onDismiss={() => setRemovingLevel(null)}
            onConfirm={async () => {
              const going = removingLevel;
              setRemovingLevel(null);
              try {
                await clearShapeLowStock(product.id, going.productUnitId);
                await lowLevels.reload();
              } catch (e: unknown) {
                setLowNote(messageOf(e, 'Could not remove that level'));
              }
            }}
          />
        )}
      </section>

      <section className={styles.empties}>
        <h2 className={styles.emptiesTitle}>Containers out</h2>
        <LoadArea area={outArea} what="what is out with customers">
          {(shapes) =>
            shapes.length === 0 ? (
              <p className={styles.emptiesNote}>
                Nothing on this item is marked as coming back. Tick a shape on the item to start
                counting its containers.
              </p>
            ) : (
              <>
                <ul className={styles.emptiesList}>
                  {shapes.map((sh) => (
                    <li key={sh.productUnitId} className={styles.emptiesRow}>
                      <span>
                        <span className={styles.emptiesName}>{sh.unitPlural}</span>
                        {/*
                          "one is 12 bottles" — the shop's own word, and pluralised.

                          This said "one is 12 piece": `products.base_unit`, which is a fixed
                          vocabulary of seven storage codes and not a word anybody uses, in the
                          singular for twelve of them. Every shape has carried its plural since the
                          unit form started asking for it separately, and nothing was reading it.
                        */}
                        <span className={styles.emptiesMeta}>
                          {sh.innerPlural
                            ? `one is ${formatQtySpoken(sh.baseQty)} ${
                                sh.baseQty === 1
                                  ? (sh.innerName ?? '').toLowerCase()
                                  : sh.innerPlural.toLowerCase()
                              }`
                            : 'the smallest this comes in'}
                        </span>
                      </span>
                      <span className={styles.emptiesQty}>
                        {saidAsPart(sh.outNow)}{' '}
                        <span className={styles.emptiesUnit}>
                          {sh.outNow === 1 ? sh.unitName.toLowerCase() : sh.unitPlural.toLowerCase()}
                        </span>
                        <span className={styles.emptiesWho}>
                          {sh.customersOut === 1 ? '1 customer' : `${sh.customersOut} customers`}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className={styles.emptiesNote}>
                  This item only, counted in the shapes it goes out in. Settle them on whoever has
                  them.
                </p>
              </>
            )
          }
        </LoadArea>
      </section>

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
              {sellingUnits.filter((u) => u.isSold).length > 0
                ? `Sold in ${sellingUnits
                    .filter((u) => u.isSold)
                    .map((u) => u.plural.toLowerCase())
                    .join(', ')}`
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
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
