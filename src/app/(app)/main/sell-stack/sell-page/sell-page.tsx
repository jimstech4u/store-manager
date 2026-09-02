'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './sell-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { useStackBack } from '@/hooks/useStackBack';
import { useOverlayRoute } from '@/hooks/useOverlayRoute';
import { useNav, scrollIntoViewBelow } from '@academix-admin/navigation-stack';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { CloseIcon, MinusIcon, PlusIcon, ReceiptIcon } from '@/components/ui/Icon';
import { CustomerPicker } from '@/components/customers/CustomerPicker';
import { CustomerTabs } from '@/components/sell/CustomerTabs';
import { ShareOrder } from '@/components/sell/ShareOrder';
import { ConfirmDialog, useConfirm } from '@/components/ui/Dialog';
import { useAsyncAction } from '@/components/ui/AsyncAction';
import { ProductPicker } from '@/components/catalog/ProductPicker';
import { QuickAddItem } from '@/components/sell/QuickAddItem';
import { CountGate } from '@/components/sell/CountGate';
import { whichNeedCount } from '@/lib/stacks/mid-sale';
import type { ProductFormResult } from '@/components/catalog/ProductForm';
import { useAuth } from '@/providers/AuthProvider';
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
import { partsFor, snapQty, startingQty } from '@/lib/quantity-rules';
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


export default function SellPage() {
  const goBack = useStackBack();
  const nav = useNav();
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
    settling,
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
   * THE BROWSER DOES THE ARITHMETIC. `scroll-margin-top` exists for exactly this — an element
   * being scrolled to that must clear a sticky thing above it — and `scrollIntoView` then honours
   * it, clamps at the ends of the range, and copes with a smooth scroll that is still in flight.
   *
   * Computing a target by hand did not. It read the box, the bar and the scroller in one go, and
   * every one of those is a moving part while React is swapping a receipt: the numbers came from a
   * layout that had already been replaced. The symptom was an alternating one — the first tap
   * worked, the second did nothing, the third worked — because each measurement was really
   * describing the tab BEFORE it. Frame counting only moves that boundary around; asking the
   * browser removes it.
   */
  /*
   * Put the order's first row back under the bar.
   *
   * `scrollIntoViewBelow` from navigation-stack does the work, and it is a different thing from
   * `scrollIntoView`: it re-measures on every frame, so the bar is allowed to change height while
   * the page travels and the glide simply follows. Nothing is corrected afterwards because nothing
   * was ever aimed at a stale number — which is what the correcting version had to hide with a
   * jump.
   *
   * It also yields to a thumb. Somebody who starts scrolling mid-glide has said what they want.
   */
  const settlePage = useCallback(() => {
    requestAnimationFrame(() => {
      const box = orderTopRef.current;
      if (!box) return;
      void scrollIntoViewBelow(box, {
        below: () =>
          box
            .closest('.navstack-column-body')
            ?.querySelector<HTMLElement>('[class*="CustomerTabs_bar"]') ?? null,
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
  const [sharing, setSharing] = useState(false);
  const [askClearCustomer, setAskClearCustomer] = useState(false);
  /*
   * The two things that used to stop a sale.
   *
   * Something the shop has never entered, and stock nobody has counted today. Both are real
   * questions and both, asked as blocking ones, end with the seller writing the sale on paper.
   */
  const [quickAdd, setQuickAdd] = useState<string | null>(null);
  const [needCount, setNeedCount] = useState<string[]>([]);

  const [askCloseTab, setAskCloseTab] = useState(false);
  /*
   * Which line is having its whole amount typed, and what has been typed so far.
   *
   * Kept here rather than on the line, deliberately. A draft order is working state the shop
   * SYNCS — a half-typed "35" on its way to "35000" would go to the server and to any other till
   * holding the same order, and would be there to restore after a reload. It is a keystroke, not
   * a fact about the sale.
   */
  const [editingTotal, setEditingTotal] = useState<string | null>(null);
  const [totalDraft, setTotalDraft] = useState('');

  const [pickingCustomer, setPickingCustomer] = useState(false);
  // Remembers that the picker was opened mid-payment, so choosing someone returns to the
  // sheet instead of dropping the seller back on the order with the payment half-entered.
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
  const onSettledRef = useRef<((saleId: string) => void) | null>(null);
  const onCustomerCreatedRef = useRef<
    ((customer: { id: string; name: string; phone: string }) => void) | null
  >(null);

  useEffect(() => {
    /*
     * `onNeedCustomer` used to be published here.
     *
     * The payment page called it to send the seller back to this screen, because the picker lived
     * here — and popping that page threw away every charge and note already typed on it. The
     * picker now opens where the seller already is, so there is nobody left to ask and an
     * unpublished callback is one fewer way for two screens to disagree about whose order it is.
     */
    const b = nav.provideObject(
      'onSaleSettled',
      () => (saleId: string) => onSettledRef.current?.(saleId),
      { global: true, scope: 'sell' },
    );
    /*
     * A customer created on the form page comes back here and is attached.
     *
     * Published under the `people` scope because that is where the form looks for it — the form
     * is registered in two stacks and cannot know which one it was pushed from, so the CALLER
     * says what to do with the result rather than the form guessing.
     */
    const c = nav.provideObject(
      'onCustomerCreated',
      () => (customer: { id: string; name: string; phone: string }) =>
        onCustomerCreatedRef.current?.(customer),
      { global: true, scope: 'people' },
    );

    return () => {
      b?.();
      c?.();
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
      /*
       * ONE MORE ONLY MEANS SOMETHING FOR A THING SOLD WHOLE.
       *
       * Tapping a crate twice plainly means two crates. Tapping a chicken twice does not mean two
       * kilogrammes — it means a second bird, whose weight the scale has yet to say — and adding
       * one to a half-crate line that deliberately started at nothing would answer the very
       * question the line is asking.
       *
       * So the quantity is left exactly as the seller set it whenever they are the one who has to
       * state it, and only ever incremented where there is nothing to state.
       */
      const rules = unitRulesFor(existing);
      const soldWholeOnly = rules.wholeDigit && partsFor(rules).length === 0;

      if (soldWholeOnly) {
        const current = Number(existing.qty);
        updateLine(activeOrder.clientUuid, existing.key, {
          qty: String((Number.isFinite(current) ? current : 0) + 1),
        });
      }
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
        /*
         * One crate, or nothing at all.
         *
         * A thing sold only whole starts at one, because there is no question worth asking. A
         * thing sold in halves starts at NOTHING, so the seller has to say which — half a crate
         * recorded as a whole one is a real loss, and one is exactly the guess that gets left
         * there when somebody is hurrying. A weighed thing starts at nothing for the plainer
         * reason that nobody can guess what a chicken weighs.
         */
        qty: String(
          startingQty({
            wholeDigit: first?.wholeDigit ?? true,
            allowQuarter: first?.allowQuarter ?? false,
            allowHalf: first?.allowHalf ?? false,
            allowThreeQuarter: first?.allowThreeQuarter ?? false,
          }),
        ),
      }),
    );
    pickerOps.close();

    /*
     * HAS THIS BEEN COUNTED TODAY?
     *
     * Asked AFTER the line is on the receipt, never before. The sale is not what is in question —
     * the shelf figure is — and a seller who is blocked at the counter reaches for paper, which
     * loses the sale as well as the count.
     *
     * Failures are swallowed on purpose. If the shop cannot be reached, the right outcome is a
     * sale that goes through and a count that gets asked for next time; refusing to sell because
     * a background question could not be answered would be the worst of both.
     */
    try {
      const owing = await whichNeedCount([product.id]);
      if (owing.has(product.id)) {
        setNeedCount((ids) => (ids.includes(product.id) ? ids : [...ids, product.id]));
      }
    } catch {
      // Nothing to say to the seller. The sale stands.
    }
  };

  onCustomerCreatedRef.current = (customer) => {
    if (!activeOrder) return;
    updateOrder(activeOrder.clientUuid, {
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
    });
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

    /*
     * Marked settled BEFORE it is closed.
     *
     * The debounced sync runs on whatever is still in local state, and the shop has already closed
     * this order — so a push would find nothing to update, try to insert, and fail. The seller
     * returned from the receipt to "Not saved to the shop yet" over a sale that had gone through.
     */
    updateOrder(activeOrder.clientUuid, { settled: true });

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
  /** The part-amount rules for whichever unit a line is being sold in. */
  const unitRulesFor = (line: DraftLine) => {
    const unit = saleUnits[line.productId]?.find((u) => u.id === line.saleUnitId);
    return {
      wholeDigit: unit?.wholeDigit ?? true,
      allowQuarter: unit?.allowQuarter ?? false,
      allowHalf: unit?.allowHalf ?? false,
      allowThreeQuarter: unit?.allowThreeQuarter ?? false,
    };
  };

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
        onShare={() => setSharing(true)}
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

      {settling ? (
        /*
         * Still finding out, which is not the same as nothing.
         *
         * A refresh used to land on "No customer being served" for the second or two it takes the
         * shop to answer — telling a seller their three open customers had vanished, at the exact
         * moment they were least able to check.
         */
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>Opening your till</p>
        </div>
      ) : !activeOrder ? (
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
        <div ref={orderTopRef} className={styles.orderBox}>
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
                              // Typed freely while the keyboard is up: snapping mid-word would
                              // fight somebody halfway through "4.5" by rewriting "4." to "4".
                              updateLine(activeOrder.clientUuid, line.key, {
                                qty: e.target.value,
                              });
                              void repriceLine(line, e.target.value, line.saleUnitId);
                            }}
                            onBlur={() => {
                              /*
                               * SNAPPED WHEN THEY LOOK AWAY, not while they type.
                               *
                               * A shop selling half crates gets 4.3 typed at it now and then —
                               * they meant 4.5, and 4.3 is a line the database refuses at the
                               * worst possible moment, after the money has been counted. Rounded
                               * to the NEAREST step, because somebody who overshoots slightly
                               * meant the figure they were reaching for.
                               */
                              const rules = unitRulesFor(line);
                              const typed = Number(line.qty);
                              if (!Number.isFinite(typed)) return;

                              const snapped = snapQty(typed, rules);
                              if (snapped === typed) return;

                              updateLine(activeOrder.clientUuid, line.key, {
                                qty: String(snapped),
                              });
                              void repriceLine(line, String(snapped), line.saleUnitId);
                            }}
                            suffix={line.saleUnitName ?? line.packName ?? line.baseUnit}
                            error={
                              Number(line.qty) > 0
                                ? null
                                : partsFor(unitRulesFor(line)).length > 0
                                  ? // Starting at nothing is deliberate for a unit sold in parts:
                                    // there is no safe default, and half a crate recorded as a
                                    // whole one is a real loss.
                                    'Say how many — tap a part below, or use +'
                                  : 'Add a quantity, or remove this item'
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
                        /*
                         * WHAT THIS SHOP SELLS, not what divides evenly.
                         *
                         * The old rule offered a fraction whenever it landed on whole base units,
                         * so a shop selling half crates of Gulder was offered quarters and
                         * three-quarters too — twelve divides by four — and each was a way to
                         * record something it cannot deliver. The shop states its parts once on
                         * the unit and the till obeys.
                         */
                        const rules = unitRulesFor(line);
                        const options = partsFor(rules);
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
                        Crates and kegs leaving with the goods — STATED, not asked.

                        This was a number field on every line of every beer sale, and the answer
                        was the quantity, every time. The unit itself now says whether it comes
                        back, so three crates sold is three crates owed and the till can simply say
                        so. What is left is the exception a shop really does meet — the customer
                        who brought their own — and that is one tap, not a field to fill in.
                      */}
                      {(() => {
                        const unit = saleUnits[line.productId]?.find((u) => u.id === line.saleUnitId);
                        const container = returnables[line.productId]?.find(
                          (r) => r.kind === 'container',
                        );
                        if (!unit?.isReturnable || !container) return null;

                        const qty = Number(line.qty);
                        const due = Number.isFinite(qty) ? qty : 0;
                        // Empty string means nobody has said otherwise, so the quantity stands.
                        const own = line.containersOut === '0';
                        const going = own ? 0 : due;

                        return (
                          <div className={styles.emptiesLine}>
                            <span>
                              {going > 0
                                ? `${formatQty(going)} ${container.categoryName.toLowerCase()} going out`
                                : `No ${container.categoryName.toLowerCase()} going out`}
                            </span>
                            <button
                              type="button"
                              className={styles.emptiesToggle}
                              aria-pressed={own}
                              onClick={() =>
                                updateLine(activeOrder.clientUuid, line.key, {
                                  containersOut: own ? '' : '0',
                                })
                              }
                            >
                              {own ? 'No — ours are going out' : 'They brought their own'}
                            </button>
                          </div>
                        );
                      })()}

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

                    {/*
                      THE FIGURE THE CUSTOMER ACTUALLY AGREED TO.

                      Haggling in a Nigerian market happens on the total, not the unit price:
                      "give me the four crates for thirty-five thousand". Until now the only box
                      on the screen was price-per-crate, so a seller had to divide 35,000 by 4 at
                      the counter with somebody waiting — and 8,750 is one of the kinder examples.
                      A price typed here divides itself, and the line still warns if the result is
                      below what the stock cost.
                    */}
                    <div className={styles.lineTotal}>
                      {editingTotal === line.key ? (
                        <Field
                          label="Total for this line"
                          numeric
                          prefix="₦"
                          autoFocus
                          value={totalDraft}
                          onChange={(e) => setTotalDraft(e.target.value)}
                          onBlur={() => {
                            const asked = Number(totalDraft);
                            const qty = Number(line.qty);
                            setEditingTotal(null);

                            // Nothing usable typed, or no quantity to divide by: the line keeps
                            // the price it had rather than being handed a zero or an infinity.
                            if (
                              !Number.isFinite(asked) ||
                              asked < 0 ||
                              !Number.isFinite(qty) ||
                              qty <= 0
                            ) {
                              return;
                            }

                            updateLine(activeOrder.clientUuid, line.key, {
                              // Kobo, because a total that will not divide evenly still has to
                              // multiply back to something near what was agreed.
                              unitPrice: String(Number((asked / qty).toFixed(2))),
                              priceTouched: true,
                              priceReason: null,
                            });
                          }}
                          hint={`Split across ${formatQty(Number(line.qty) || 0)} ${
                            line.saleUnitName?.toLowerCase() ?? line.baseUnit
                          }`}
                        />
                      ) : (
                        <>
                          <span>Line total</span>
                          <button
                            type="button"
                            className={`${styles.lineTotalValue} ${under ? styles.belowCost : ''}`}
                            onClick={() => {
                              setTotalDraft(String(lineTotal(line) || ''));
                              setEditingTotal(line.key);
                            }}
                            aria-label={`Line total ${formatMoney(lineTotal(line))} — tap to set the whole amount`}
                          >
                            {formatMoney(lineTotal(line))}
                          </button>
                        </>
                      )}
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
          /*
           * OFFERED TO ANYONE WHO MAY SELL, which is the whole point.
           *
           * It used to appear only for `products.manage`, so a seller who was asked for something
           * the shop had never entered had no way forward at all — and the way they find is paper,
           * which loses the sale as well as the record. Whoever may sell may add; what they cannot
           * do is vouch for it, and the review queue handles that.
           *
           * The quick sheet rather than the full form even for a manager: there is a customer
           * waiting, and the eleven-question form belongs on the item's own screen.
           */
          onAddNew={(typed) => {
            pickerOps.close();
            setQuickAdd(typed ?? '');
          }}
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
        <QuickAddItem
          open={quickAdd !== null}
          onClose={() => setQuickAdd(null)}
          storeId={store.id}
          initialName={quickAdd ?? ''}
          onAdded={(productId) => {
            setQuickAdd(null);
            /*
             * Read back before it goes on the receipt.
             *
             * A line needs more than an id — the unit it is sold in, the price, the cost the
             * below-cost warning compares against. Fetching it here is also what makes this work
             * at all: something created seconds ago is in no list this page is holding.
             */
            void fetchProduct(productId).then((fresh) => {
              if (fresh) void addProductRef.current?.(fresh);
            });
          }}
        />
      )}

      {activeOrder && (
        <CountGate
          open={needCount.length > 0}
          onClose={() => setNeedCount([])}
          items={needCount.flatMap((id) => {
            const line = activeOrder.lines.find((l) => l.productId === id);
            if (!line) return [];
            const unit = saleUnits[id]?.find((u) => u.id === line.saleUnitId);
            return [
              {
                productId: id,
                productName: line.productName,
                unitName: unit?.name ?? line.baseUnit,
                unitPlural: unit?.name ?? line.baseUnit,
                baseQty: Number(unit?.baseQty ?? 1),
              },
            ];
          })}
          onCounted={(done) => setNeedCount((ids) => ids.filter((id) => !done.includes(id)))}
        />
      )}

      {activeOrder && (
        <CustomerPicker
          open={pickingCustomer}
          storeId={store.id}
          initialName={activeOrder.customerName}
          onCreate={(name) => {
            setPickingCustomer(false);
            void nav.push('customer_form_page', { name, then: 'attach-to-sale' });
          }}
          onPick={(c) => {
            updateOrder(activeOrder.clientUuid, {
              customerId: c.id,
              customerName: c.name,
              customerPhone: c.phone,
            });
            setPickingCustomer(false);
          }}
          onClose={() => setPickingCustomer(false)}
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


      {activeOrder && (
        <ShareOrder
          open={sharing}
          onClose={() => setSharing(false)}
          code={activeOrder.code}
          shareToken={activeOrder.shareToken ?? null}
          storeName={store.name}
          customerName={activeOrder.customerName}
          customerId={activeOrder.customerId}
          customerPhone={activeOrder.customerPhone}
          total={formatMoney(total)}
        />
      )}
    </PageScaffold>
  );
}
