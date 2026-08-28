'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './sell-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { useStackBack } from '@/hooks/useStackBack';
import { useOverlayRoute } from '@/hooks/useOverlayRoute';
import { useNav } from '@academix-admin/navigation-stack';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { CloseIcon, MinusIcon, PlusIcon, ReceiptIcon } from '@/components/ui/Icon';
import { CustomerPicker } from '@/components/customers/CustomerPicker';
import { CustomerTabs } from '@/components/sell/CustomerTabs';
import { ConfirmDialog, useConfirm } from '@/components/ui/Dialog';
import { useAsyncAction } from '@/components/ui/AsyncAction';
import { ProductPicker } from '@/components/catalog/ProductPicker';
import type { ProductFormResult } from '@/components/catalog/ProductForm';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { FloatingAmount } from '@/components/ui/FloatingAmount';
import {
  fetchProduct,
  fetchSaleUnits,
  type Product,
  type SaleUnit,
} from '@/lib/stacks/catalog-stack';
import {
  draftTotal,
  baseUnitsPerSaleUnit,
  lineTotal,
  makeDraftLine,
  useDraftOrders,
  type DraftLine,
} from '@/lib/stacks/draft-orders';
import { formatMoney, formatQty } from '@/lib/format';
import { getSupabase } from '@/lib/supabase/client';

/**
 * The sale screen — over 90% of what this product does.
 *
 * Built around what the domain expert described:
 *  · several customers served at once, each an open order in the tab strip
 *  · any line editable in place, with ± beside the keypad, because the ±1 change is the common
 *    one and tapping it is far harder to get wrong one-handed than retyping a number
 *  · search over the product list, since scrolling 300 lines while someone waits is not viable
 *  · a share code, so an order can be handed to a colleague to finish
 *  · the total never more than a glance away
 */
/**
 * The part-amounts a seller can add on top of a whole quantity.
 *
 * ADDITIVE AND TOGGLEABLE, not "set the quantity to this". Two and a half crates is the ordinary
 * request, and it is entered as 2 on the stepper plus ½ here. Tapping ½ again takes it back off
 * and leaves 2 — so the button shows the current state rather than firing a one-way action.
 *
 * A fixed list rather than a setting: these are the parts a pack is physically broken into.
 * Which of them appear is decided per line by whether they land on whole base units.
 */
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const FRACTIONS = [
  { label: '¼', value: 0.25 },
  { label: '½', value: 0.5 },
  { label: '¾', value: 0.75 },
] as const;

export default function SellPage() {
  const goBack = useStackBack();
  const nav = useNav();
  const { can } = usePermission();
  const { store } = useAuth();
  const {
    orders,
    activeOrder,
    activeId,
    setActiveId,
    startOrder,
    updateOrder,
    closeOrder,
    addLine,
    updateLine,
    removeLine,
    push,
    error: draftError,
    hydrated,
  } = useDraftOrders(store?.id ?? null);

  /*
   * "When a product gets created, put it straight on this receipt."
   *
   * The add-a-product form is a PAGE now, in the stock stack, and a pushed page has no return
   * value — `nav.push` resolves when the page appears, not when it is done. So the wanted result
   * is published as a callback under a global key and the form page picks it up with `useObject`.
   *
   * Straight onto the receipt is the whole point. A customer has just asked for something the shop
   * has never entered; adding it and then making the seller search for it again is the same
   * interruption in two steps instead of one.
   *
   * Global rather than page-scoped because the form lives in a different stack, and a page-scoped
   * object is addressed by its provider's uid — unfindable from there.
   */
  useEffect(() => {
    const cleanup = nav.provideObject(
      'onProductSaved',
      () => async (created: ProductFormResult) => {
        /*
         * Read the product back before putting it on the receipt.
         *
         * The form hands over an id and a name, and a line needs more than that — the base unit,
         * the pack, the average cost the below-cost warning compares against. Fetching it here is
         * also what makes this work at all: a product created seconds ago is in no list this page
         * is holding.
         */
        const product = await fetchProduct(created.id);
        if (product) await addProductRef.current?.(product);
      },
      { global: true, scope: 'catalog' },
    );
    return cleanup;
  }, [nav]);

  /*
   * Whether the item picker is up — a plain flag, not a second SelectionViewer controller.
   *
   * `ProductPicker` owns the viewer and its controller. This page held one too, so the same sheet
   * had two things claiming to control it; the picker's own theme, search and snap state are its
   * business now, and all this screen has to say is whether it is asking.
   */
  const [isPickerOpen, setPickerOpen] = useState(false);
  const pickerOps = useMemo(
    () => ({ open: () => setPickerOpen(true), close: () => setPickerOpen(false) }),
    [],
  );

  // Back dismisses the picker rather than leaving the app mid-sale.
  useOverlayRoute('sell:picker', isPickerOpen, () => {
    pickerOps.close();
  });

  /** Which empties pools each product on the receipt belongs to, keyed by product id. */
  const [returnables, setReturnables] = useState<
    Record<string, { categoryId: string; categoryName: string; kind: string }[]>
  >({});
  /*
   * Three dialogs, because three of the four customer actions ask something first.
   *
   * A dialog rather than a sheet for each: these interrupt to ask a question that has to be
   * answered before anything else continues, which is exactly the distinction the two surfaces
   * carry everywhere else in the app.
   */
  /*
   * One slot, because only one of these can be in flight at a time — they all act on the same
   * order, and the row they share is where the spinner has to appear.
   */
  /** The top of the active order, so the bar can bring it back under itself. */
  const orderTopRef = useRef<HTMLDivElement | null>(null);

  /*
   * Put the order's first row back under the bar.
   *
   * MEASURED AFTER THE RE-RENDER, which is the whole difficulty. Switching customers swaps the
   * entire receipt, so measuring in the click handler reads the tab you just left — its box is
   * still where it was, the sums come out to "already in place", and nothing moves. That is
   * exactly what tapping a tab looked like: the four actions settled the page and the tabs did
   * not, because only the tabs change what is being measured.
   *
   * Two frames: the first lets React commit the new order, the second lets layout settle before
   * anything is read from it.
   */
  const settlePage = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const box = orderTopRef.current;
        const body = box?.closest<HTMLElement>('.navstack-column-body');
        if (!box || !body) return;

        // Against the bar's own height rather than a guessed number, so it stays right when the
        // bar changes — it grows a row when the four actions collapse.
        const bar = body.querySelector<HTMLElement>('[class*="CustomerTabs_bar"]');
        const clearance = bar ? bar.getBoundingClientRect().height : 0;
        const top = box.getBoundingClientRect().top - body.getBoundingClientRect().top;
        const target = body.scrollTop + top - clearance;

        // Nothing to do when it is already there — a smooth scroll of two pixels reads as a twitch.
        if (Math.abs(target - body.scrollTop) < 4) return;
        body.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
      });
    });
  }, []);

  const customerAction = useAsyncAction();

  const clearCustomerDialog = useConfirm();
  const closeTabDialog = useConfirm();

  /*
   * Whether each dialog is on the page is decided HERE, not read back from the package.
   *
   * Its own `isOpen` does not start false, so mounting on it put a dialog over the till the moment
   * the screen loaded — and its overlay swallows every tap behind it, which on a till means the
   * screen simply stops working. `unmountOnClose` did not help. A flag of our own is unambiguous.
   */
  const [askClearCustomer, setAskClearCustomer] = useState(false);
  const [askCloseTab, setAskCloseTab] = useState(false);

  const [pickingCustomer, setPickingCustomer] = useState(false);
  // Remembers that the picker was opened mid-payment, so choosing someone returns to the
  // sheet instead of dropping the seller back on the order with the payment half-entered.
  const [resumePayment, setResumePayment] = useState(false);
  // Sale units per product, fetched once when a product is first added to any order.
  const [saleUnits, setSaleUnits] = useState<Record<string, SaleUnit[]>>({});
  /*
   * The products this receipt has actually touched — NOT whatever the search is showing.
   *
   * This was `new Map(searchResults)`, and that was wrong in two ways that both failed silently:
   *
   *   Adding a product created mid-sale did nothing at all. The new item was by definition not in
   *   the search results, so the lookup missed and `addProduct` returned without a word — despite
   *   the flow being built specifically so a seller could add an unknown item without abandoning
   *   the receipt.
   *
   *   The below-cost warning came and went. Type a new search and the earlier lines' products fell
   *   out of the map, so a line priced under cost quietly stopped being flagged.
   *
   * A receipt's lines outlive any one search. What the receipt needs is what it has been given.
   */
  const [productById, setProductById] = useState<Map<string, Product>>(new Map());

  const rememberProduct = useCallback((product: Product) => {
    setProductById((prev) => {
      if (prev.get(product.id) === product) return prev;
      const next = new Map(prev);
      next.set(product.id, product);
      return next;
    });
  }, []);


  /*
   * Nothing open ANYWHERE: start one, so the screen is ready to sell rather than empty.
   *
   * Waits for `hydrated`. Without it this fired on the first render of a fresh device, created an
   * empty order, and that order was then the reason hydration decided there was live work here
   * and left the shop's copy alone — so a seller signing in on another phone got a blank till and
   * the customers they were serving stayed invisible.
   */
  useEffect(() => {
    if (store && hydrated && orders.length === 0) startOrder();
  }, [store, hydrated, orders.length, startOrder]);

  const total = activeOrder ? draftTotal(activeOrder) : 0;

  /*
   * Lines with nothing on them.
   *
   * A quantity can reach zero by tapping minus, or by the field being cleared while retyping, and
   * a zero-quantity line is not a sale — it is a line somebody meant to remove. Letting it through
   * puts a row on the customer's receipt for goods that never moved and a stock movement of zero
   * in the ledger, both of which have to be explained later.
   *
   * Flagged rather than silently dropped: quietly deleting a line the seller is halfway through
   * editing is worse than telling them about it.
   */
  const emptyLines = (activeOrder?.lines ?? []).filter((l) => !(Number(l.qty) > 0));

  /*
   * The live `addProduct`, for the callback published above.
   *
   * That callback is provided once, on mount, and must not be re-provided on every render — so it
   * cannot close over `addProduct` directly without capturing the first render's copy of every
   * order and line it touches.
   */
  /*
   * What the payment page needs back from this screen.
   *
   * Taking payment is a page now — the longest form in the product, and it was a sheet until a
   * keyboard put its last row out of reach. A pushed page has no return value, so the two things
   * that have to happen HERE are published as callbacks and picked up there with `useObject`:
   *
   *   attaching a customer, because the picker belongs over the receipt being built — seeing what
   *   is being bought is most of how a seller recognises who is buying it;
   *
   *   and settling, which pushes the receipt and closes the tab.
   *
   * Provided once, through refs, so the callbacks are never a render behind.
   */
  const needCustomerRef = useRef<(() => void) | null>(null);
  const onSettledRef = useRef<((saleId: string) => void) | null>(null);

  useEffect(() => {
    const a = nav.provideObject('onNeedCustomer', () => () => needCustomerRef.current?.(), {
      global: true,
      scope: 'sell',
    });
    const b = nav.provideObject(
      'onSaleSettled',
      () => (saleId: string) => onSettledRef.current?.(saleId),
      { global: true, scope: 'sell' },
    );
    return () => {
      a?.();
      b?.();
    };
  }, [nav]);

  const addProductRef = useRef<((product: Product) => Promise<void>) | null>(null);

  const addProduct = async (product: Product) => {
    if (!activeOrder) return;
    const productId = product.id;
    // Keep it for as long as the receipt does — the line will need its cost and unit long after
    // whatever search found it has been typed over.
    rememberProduct(product);

    // Fetch the shapes this product is sold in, so the line can offer "Half pack" rather than
    // making the seller work out that it means 6.
    let units = saleUnits[productId];
    if (!units) {
      try {
        units = await fetchSaleUnits(productId);
        setSaleUnits((prev) => ({ ...prev, [productId]: units }));
      } catch {
        units = [];
      }
    }
    const first = units[0];

    // Which empties pools this product belongs to, so the line can ask about crates going out.
    // Fetched once per product and cached: a receipt often has the same item added repeatedly.
    if (!returnables[productId]) {
      const { data } = await getSupabase().rpc('returnables_for_sale', {
        p_product_id: productId,
        p_base_qty: 1,
        p_containers: 1,
      });
      setReturnables((prev) => ({
        ...prev,
        [productId]: ((data ?? []) as {
          empties_category_id: string;
          category_name: string;
          kind: string;
        }[]).map((r) => ({
          categoryId: r.empties_category_id,
          categoryName: r.category_name,
          kind: r.kind,
        })),
      }));
    }

    /*
     * Already on this receipt in the same shape? Add to it rather than starting a second line.
     *
     * Sellers add the same item repeatedly as a customer keeps asking for more, and two "Coca-Cola
     * PET" lines on one receipt is how a quantity gets miscounted at the counter and disputed
     * afterwards. Matched on the sale unit too, deliberately: a pack line and a loose-piece line
     * of the same product are genuinely different lines and must stay apart.
     */
    const existing = activeOrder.lines.find(
      (l) => l.productId === product.id && l.saleUnitId === (first?.id ?? null),
    );
    if (existing) {
      const current = Number(existing.qty);
      updateLine(activeOrder.clientUuid, existing.key, {
        qty: String((Number.isFinite(current) ? current : 0) + 1),
      });
      pickerOps.close();
      return;
    }

    addLine(
      activeOrder.clientUuid,
      makeDraftLine({
        productId: product.id,
        productName: product.name,
        baseUnit: product.baseUnit,
        packId: product.packId,
        packName: product.packName,
        packQty: product.packQty,
        // Default to the first configured shape when there is one — usually the whole pack,
        // which is what most sales are.
        saleUnitId: first?.id ?? null,
        saleUnitName: first?.name ?? null,
        saleUnitBaseQty: first?.baseQty ?? null,
        // A starting point, not a rule: the seller sets the real price on the line.
        unitPrice: first?.price ?? product.listPrice ?? '',
      }),
    );
    pickerOps.close();
  };

  needCustomerRef.current = () => {
    setResumePayment(true);
    setPickingCustomer(true);
  };

  onSettledRef.current = (saleId: string) => {
    if (!activeOrder) return;
    /*
     * Navigate FIRST, then close the tab.
     *
     * Closing empties the order list, which immediately starts a fresh order, and the churn that
     * follows was swallowing whatever came after it. The sale is already recorded by this point,
     * so the order of these two is purely about what the seller ends up looking at.
     */
    /*
     * `pushAndPopUntil`, so the payment screen does not stay under the receipt.
     *
     * The payment is finished the moment the sale exists. Left on the stack, Back from the
     * receipt walks into a payment screen for a sale already made — which reads as if it did not
     * go through. Back now returns to the till, ready for the next customer.
     */
    void nav.pushAndPopUntil('receipt_page', (entry) => entry.key === 'sell_page', {
      id: saleId,
      fresh: '1',
    });

    // Only once the sale is recorded. Closing optimistically would lose the order if the write
    // failed.
    closeOrder(activeOrder.clientUuid);
  };

  // Point the published callback at THIS render's `addProduct`, every render. Without this the
  // callback holds null and adding a product mid-sale does nothing at all — silently.
  addProductRef.current = addProduct;

  /**
   * Ask the server what this line should cost at its current quantity and shape.
   *
   * The bulk ladder — "₦3,700 each, ₦3,600 from the sixth" — and any rate agreed with this
   * particular customer live in the database, and `resolve_price` knows to take the better of the
   * two. Until now nothing called it: tiers a shop had carefully set up never reached the
   * counter, and ten bottles were quoted at ten times the single price.
   *
   * Resolved server-side rather than reimplemented here, because the bands, their overlap rules
   * and the customer-price precedence are all enforced in the database. A second copy of that in
   * the client is a second answer waiting to disagree with the first.
   */
  const repriceLine = async (line: DraftLine, qty: string, saleUnitId: string | null) => {
    // Never overwrite a figure the seller typed. Re-suggesting on the next quantity nudge would
    // silently undo a deliberate decision — a favour, a haggle — and nobody would see it happen.
    if (!activeOrder || line.priceTouched) return;

    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0) return;

    const { data, error } = await getSupabase().rpc('resolve_price', {
      p_product_id: line.productId,
      p_qty: n,
      p_sale_unit_id: saleUnitId,
      p_customer_id: activeOrder.customerId ?? null,
    });

    // A failure here must not break the line. The seller can always type a price, and a sale that
    // cannot be built because a suggestion failed to load is far worse than one priced by hand.
    if (error || !data) return;

    const r = data as { suggested?: string | number | null; reason?: string | null };
    if (r.suggested === null || r.suggested === undefined) return;

    updateLine(activeOrder.clientUuid, line.key, {
      unitPrice: String(r.suggested),
      priceReason: r.reason ?? null,
    });
  };

  const step = (line: DraftLine, by: number) => {
    if (!activeOrder) return;
    const current = Number(line.qty);
    const next = (Number.isFinite(current) ? current : 0) + by;
    if (next < 0) return;
    updateLine(activeOrder.clientUuid, line.key, { qty: String(next) });
    void repriceLine(line, String(next), line.saleUnitId);
  };

  /** Priced under what the stock cost. A warning, never a block — the seller may mean it. */
  const belowCost = (line: DraftLine): boolean => {
    const product = productById.get(line.productId);
    if (!product || !line.unitPrice) return false;
    // Divide by what is actually being sold, not by the pack. Dividing a half-pack price by 12
    // made every half pack and every single piece look like it was sold at a loss.
    const perBase = Number(line.unitPrice) / baseUnitsPerSaleUnit(line);
    return Number.isFinite(perBase) && perBase < Number(product.avgUnitCost);
  };

  /**
   * Open the payment sheet.
   *
   * Only pushes the order so it exists server-side (and so a colleague could claim it). No
   * customer is created here: an anonymous cash sale never needs one, and when credit does, the
   * payment page asks — at the point the answer actually matters.
   */
  const payment = useAsyncAction();

  const openPayment = async () => {
    if (!activeOrder || !store) return;
    // The button is disabled for this, but the check is repeated here because `openPayment` is
    // also reachable from the payment page's resume path after choosing a customer.
    if (emptyLines.length > 0) return;
    const saved = await push(activeOrder);
    /*
     * The order's own id travels, not "whichever tab is active".
     *
     * Taking payment is a page, and a page can be refreshed — or reached on another phone after
     * this one dies. Addressed by id it resolves to the same order every time; relying on the
     * active tab meant a reload landed on whatever tab happened to be first afterwards, which is
     * a payment screen for the wrong customer.
     */
    await nav.push('take_payment_page', { id: saved?.id ?? activeOrder.id });
  };

  if (!store) return null;

  return (
    <PageScaffold
      onBack={goBack}
      title="Sell"
      subtitle={store.name}
      /*
       * The header travels with the receipt.
       *
       * The customer bar below it is sticky, and two things cannot both own the top of the screen.
       * Scrolling into a long order takes the title away and leaves the bar in its place; scrolling
       * back brings it down again with the page.
       */
      headerScrolls
      /*
       * The header action is SALES, the same one the money screen carries.
       *
       * Taking over a colleague's order used to live here, opening a panel over the order being
       * worked on. It has moved to the customer bar, where the rest of the per-customer actions
       * are. What belongs in a page header is the way OUT to a related page, and from a till the
       * related page is what has already been sold.
       */
      actions={[
        {
          key: 'sales',
          icon: <ReceiptIcon />,
          onClick: () => void nav.push('sales_page'),
          ariaLabel: 'All sales and receipts',
        },
      ]}
    >
      {/*
        The running total, floating at the right-hand end of the tab bar's line.
        Replaces the action bar this page used to pin to its own bottom edge, which cost a row of
        the order on every sale and covered the last line in the list.
      */}
      {activeOrder && activeOrder.lines.length > 0 && (
        <FloatingAmount
          /*
           * Whose money this is, above the amount.
           *
           * The button used to say only "Take payment ₦3,700". With several tabs open that is the
           * one number on screen that must not be taken on trust — tapping it settles a sale, and
           * which sale depended on remembering which tab was active. The name and the amount
           * together mean the button says what it is about to do.
           */
          who={
            activeOrder.customerName.trim() ||
            activeOrder.label.trim() ||
            `Customer ${Math.max(1, orders.findIndex((o) => o.clientUuid === activeId) + 1)}`
          }
          label={emptyLines.length > 0 ? 'Fix the quantity' : 'Take payment'}
          amount={formatMoney(total)}
          disabled={emptyLines.length > 0}
          busy={payment.state === 'busy'}
          onClick={() => payment.run(openPayment)}
        />
      )}

      {/* ── Who is being served ─────────────────────────────────────────────────── */}
      <CustomerTabs
        tabs={orders.map((order, index) => ({
          id: order.clientUuid,
          name: order.customerName.trim() || order.label.trim() || `Customer ${index + 1}`,
          amount: formatMoney(draftTotal(order)),
        }))}
        activeId={activeId}
        onSelect={setActiveId}
        onAdd={() => startOrder()}
        onSetCustomer={() => setPickingCustomer(true)}
        onClearCustomer={() => setAskClearCustomer(true)}
        onCloseTab={() => setAskCloseTab(true)}
        onClaim={() => void nav.push('claim_page')}
        hasCustomer={Boolean(activeOrder?.customerId)}
        orderCode={activeOrder?.code ?? null}
        /*
         * Settle the page under the bar.
         *
         * The bar is pinned, so by the time somebody reaches for it the receipt has usually
         * scrolled beneath it — and every control on it is about the order they then cannot see.
         * This puts the first row back directly under the bar, so acting on a customer always
         * leaves that customer's order in front of you.
         */
        onSettlePage={settlePage}
        actionState={customerAction.state}
        actionProblem={customerAction.problem}
        onRetryAction={customerAction.retry}
        onDismissAction={customerAction.dismiss}
      />

      {draftError && (
        <InfoPanel tone="warning" title="Not saved to the shop yet">
          {draftError} Your order is safe on this phone — it will save when the connection is back.
        </InfoPanel>
      )}

      {!activeOrder ? (
        <div className={styles.emptyState}>
          <ReceiptIcon size="40px" />
          <p className={styles.emptyTitle}>No customer being served</p>
          <Button size="large" fullWidth onClick={() => startOrder()}>
            Start a customer
          </Button>
        </div>
      ) : (
        /*
         * The active order's own box, watched so the customer bar knows when it has scrolled away.
         *
         * Wraps the whole receipt rather than just the line list: "show me the active order" means
         * the items AND the button that adds to them, not the first row of a list whose top is
         * under the sticky bar.
         */
        <div ref={orderTopRef}>
          {/* ── Lines ─────────────────────────────────────────────────────────── */}
          {activeOrder.lines.length > 0 && (
            <div className={styles.lines}>
              {activeOrder.lines.map((line) => {
                const under = belowCost(line);
                return (
                  <div className={styles.line} key={line.key}>
                    <div className={styles.lineHead}>
                      {/* Just the name. The base-unit total ("12 pieces in total") used to sit
                          here and was read as a second quantity to check against the one being
                          entered — two numbers for one line, with nothing saying which mattered. */}
                      <p className={styles.lineName}>{line.productName}</p>
                      <button
                        type="button"
                        className={styles.lineRemove}
                        onClick={() => removeLine(activeOrder.clientUuid, line.key)}
                        aria-label={`Remove ${line.productName}`}
                      >
                        <CloseIcon />
                      </button>
                    </div>

                    {(saleUnits[line.productId]?.length ?? 0) > 1 && (
                      <div className={styles.unitBlock}>
                        <span className={styles.unitLabel}>Selling as</span>
                        <div className={styles.unitRow} role="group" aria-label="How it is being sold">
                        {saleUnits[line.productId].map((u) => (
                          <button
                            key={u.id}
                            type="button"
                            className={`${styles.unit} ${
                              line.saleUnitId === u.id ? styles.unitActive : ''
                            }`}
                            aria-pressed={line.saleUnitId === u.id}
                            onClick={() => {
                              updateLine(activeOrder.clientUuid, line.key, {
                                saleUnitId: u.id,
                                saleUnitName: u.name,
                                saleUnitBaseQty: u.baseQty,
                                // Switching shape switches price: each shape carries its own,
                                // and keeping the previous one would quietly sell a half pack
                                // at the full pack price.
                                unitPrice: u.price ?? line.unitPrice,
                              });
                              // ...then let any bulk band for the NEW shape apply on top.
                              void repriceLine(line, line.qty, u.id);
                            }}
                          >
                            {u.name}
                          </button>
                        ))}
                        </div>
                      </div>
                    )}

                    <div className={styles.lineGrid}>
                      <div className={styles.stepper}>
                        <button
                          type="button"
                          className={styles.stepperButton}
                          onClick={() => step(line, -1)}
                          disabled={Number(line.qty) <= 0}
                          aria-label={`One less ${line.productName}`}
                        >
                          <MinusIcon />
                        </button>
                        <div className={styles.stepperField}>
                          <Field
                            label="Quantity"
                            numeric
                            value={line.qty}
                            onChange={(e) => {
                              updateLine(activeOrder.clientUuid, line.key, {
                                qty: e.target.value,
                              });
                              void repriceLine(line, e.target.value, line.saleUnitId);
                            }}
                            suffix={line.saleUnitName ?? line.packName ?? line.baseUnit}
                            error={
                              Number(line.qty) > 0 ? null : 'Add a quantity, or remove this item'
                            }
                          />
                        </div>
                        <button
                          type="button"
                          className={styles.stepperButton}
                          onClick={() => step(line, 1)}
                          aria-label={`One more ${line.productName}`}
                        >
                          <PlusIcon />
                        </button>
                      </div>

                      {(() => {
                        /*
                         * Part-amounts on top of the whole number in the stepper.
                         *
                         * OFFERED ONLY WHEN THEY LAND ON WHOLE BASE UNITS. A quarter of a 12-piece
                         * pack is 3 pieces and is real; a quarter of a single bottle is not, and
                         * the database rejects it — so the guard belongs here too rather than
                         * letting the seller build a line that cannot be settled.
                         */
                        const per = baseUnitsPerSaleUnit(line);
                        const options = FRACTIONS.filter((f) => (per * f.value) % 1 === 0);
                        if (options.length === 0) return null;

                        const current = Number(line.qty);
                        const safe = Number.isFinite(current) && current >= 0 ? current : 0;
                        const whole = Math.floor(safe);
                        // Rounded before comparing: 2.5 - 2 is not exactly 0.5 in binary floating
                        // point, and an un-rounded compare leaves the button that IS selected
                        // looking unselected.
                        const part = Number((safe - whole).toFixed(4));

                        return (
                          <div className={styles.fractionBlock}>
                            <span className={styles.fractionLabel}>
                              Add a part{part > 0 ? ` — now ${formatQty(safe)}` : ''}
                            </span>
                            <div
                              className={styles.fractionRow}
                              role="group"
                              aria-label="Add a part of one to the quantity"
                            >
                              {options.map((f) => {
                                const on = part === f.value;
                                return (
                                  <button
                                    key={f.label}
                                    type="button"
                                    className={`${styles.fraction} ${on ? styles.fractionActive : ''}`}
                                    aria-pressed={on}
                                    onClick={() => {
                                      // Tapping the selected part removes it and leaves the whole
                                      // number behind.
                                      const next = String(on ? whole : whole + f.value);
                                      updateLine(activeOrder.clientUuid, line.key, { qty: next });
                                      void repriceLine(line, next, line.saleUnitId);
                                    }}
                                  >
                                    {f.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}

                      {/*
                        Crates, kegs and dispenser bottles leaving with the goods.

                        The line already carried `containersOut` and it was sent to the server on
                        every settle — with nothing anywhere able to set it. So a shop could sell
                        three crates of beer and the crates themselves were never recorded as owed
                        back, which is the larger half of what a distributor is actually tracking.

                        Bottles are not asked about: for a 'content' pool the server derives the
                        count from the quantity sold, because twelve bottles sold is twelve bottles
                        owed and asking would be asking someone to restate what they just entered.
                        Containers genuinely have to be declared — a customer often brings their own
                        crates, or takes the goods loose.
                      */}
                      {(returnables[line.productId]?.some((r) => r.kind === 'container') ?? false) && (
                        <div className={styles.emptiesBlock}>
                          <Field
                            label={`${
                              returnables[line.productId].find((r) => r.kind === 'container')
                                ?.categoryName ?? 'Containers'
                            } going out`}
                            optional
                            numeric
                            value={line.containersOut}
                            onChange={(e) =>
                              updateLine(activeOrder.clientUuid, line.key, {
                                containersOut: e.target.value,
                              })
                            }
                            placeholder="0"
                            hint="Leave empty if they brought their own, or took it loose."
                          />
                        </div>
                      )}

                      <Field
                        label={line.saleUnitName ? `Price per ${line.saleUnitName.toLowerCase()}` : 'Price each'}
                        numeric
                        prefix="₦"
                        value={line.unitPrice}
                        onChange={(e) =>
                          updateLine(activeOrder.clientUuid, line.key, {
                            unitPrice: e.target.value,
                            // From here on, this line keeps the seller's own figure.
                            priceTouched: true,
                            priceReason: null,
                          })
                        }
                        error={under ? 'Below what this cost you' : null}
                        /*
                         * Say why this figure appeared. A price that changes on its own when the
                         * quantity crosses a band looks like a glitch unless it explains itself —
                         * and the seller needs to be able to tell the customer what they are
                         * getting, which is half the point of offering a bulk price at all.
                         */
                        hint={
                          line.priceTouched
                            ? 'Your own price'
                            : line.priceReason === 'bulk'
                              ? 'Bulk price for this quantity'
                              : line.priceReason === 'customer'
                                ? "This customer's agreed price"
                                : undefined
                        }
                      />
                    </div>

                    <div className={styles.lineTotal}>
                      <span>Line total</span>
                      <span className={`${styles.lineTotalValue} ${under ? styles.belowCost : ''}`}>
                        {formatMoney(lineTotal(line))}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Add an item ───────────────────────────────────────────────────── */}
          <div style={{ marginBottom: 'var(--space-5)' }}>
            <Button variant="secondary" size="large" fullWidth onClick={pickerOps.open}>
              <PlusIcon /> Add an item
            </Button>
          </div>

          {/*
            The running total and the extra charge have moved to the payment screen.

            Both are about what is OWED, and the till is about what is being bought. A seller
            adding items reads the list and the floating button; the breakdown only matters at
            the moment somebody is handing money over, which is a different screen. Leaving
            them here meant scrolling past a total to reach the button that acts on it.
          */}

        </div>
      )}
      {/*
        Choosing a product is a SELECTION, so it uses the selection viewer.

        It was an inline branch that replaced the whole receipt with a search box and a list —
        the seller lost sight of what they were building at the exact moment they were adding to
        it. A sheet keeps the order on screen behind it, gets the full height for results, and
        brings its own search, empty and error states rather than this page hand-rolling three
        more.

        zIndex 1000: the tab bar is 50 and a sibling of the page, so anything lower is a sheet the
        tabs punch through.
      */}
      {activeOrder && (
        <ProductPicker
          open={isPickerOpen}
          onClose={pickerOps.close}
          storeId={store.id}
          onPick={(p) => void addProduct(p)}
          onAddNew={
            can('products.manage')
              ? (typed) => {
                  pickerOps.close();
                  void nav.push('product_form_page', typed ? { name: typed } : undefined);
                }
              : undefined
          }
        />
      )}

      {/*
        Reserves the pill's height at the foot of the page.

        A floating control still covers whatever is under it — measured, the total sat squarely on
        the quick-fraction buttons of the last line. `--nav-height` already clears the tab bar;
        this clears the pill that now sits above it. Rendered only while the pill is, so a page
        with nothing to pay for does not carry a blank gap.
      */}
      {activeOrder && activeOrder.lines.length > 0 && <div className={styles.floatSpacer} />}

      {activeOrder && (
        <CustomerPicker
          open={pickingCustomer}
          storeId={store.id}
          initialName={activeOrder.customerName}
          onPick={(c) => {
            updateOrder(activeOrder.clientUuid, {
              customerId: c.id,
              customerName: c.name,
              customerPhone: c.phone,
            });
            setPickingCustomer(false);
            if (resumePayment) {
              setResumePayment(false);
              void nav.push('take_payment_page');
            }
          }}
          onClose={() => {
            setPickingCustomer(false);
            // Backing out must also return to the payment page — the seller may simply have
            // decided the sale is anonymous after all, and should not have to start again.
            if (resumePayment) {
              setResumePayment(false);
              void nav.push('take_payment_page');
            }
          }}
        />
      )}



      {/* ── The three questions the customer bar asks ─────────────────────────────── */}

      {/*
        Rendered ONLY while open.

        The package leaves its overlay in the page when the dialog is closed, and that overlay
        swallows taps meant for what is behind it — the sell screen quietly stopped responding to
        anything, which is the worst failure a till can have. `unmountOnClose` did not remove it,
        so the mounting is decided here instead.
      */}
      {askClearCustomer && (
      <ConfirmDialog
        controller={clearCustomerDialog}
        title="Take the customer off this sale?"
        message={
          activeOrder
            ? `${activeOrder.customerName || 'This customer'} will be taken off. The items stay ` +
              `— it becomes a sale with no name against it.`
            : undefined
        }
        confirmText="Take them off"
        tone="danger"
        onDismiss={() => setAskClearCustomer(false)}
        onConfirm={() =>
          activeOrder &&
          customerAction.run(async () => {
            updateOrder(activeOrder.clientUuid, {
              customerId: null,
              customerName: '',
              customerPhone: '',
            });
            // Pushed rather than left to the debounce, so the spinner covers the real write and a
            // failure is reported where it was caused.
            await push({
              ...activeOrder,
              customerId: null,
              customerName: '',
              customerPhone: '',
            });
          })
        }
      />
      )}

      {askCloseTab && (
      <ConfirmDialog
        controller={closeTabDialog}
        title="Close this tab without selling?"
        message="Everything on it is discarded, and the order code goes back for someone else to use."
        confirmText="Discard it"
        tone="danger"
        onDismiss={() => setAskCloseTab(false)}
        onConfirm={() => activeOrder && customerAction.run(() => closeOrder(activeOrder.clientUuid))}
      />
      )}

    </PageScaffold>
  );
}
