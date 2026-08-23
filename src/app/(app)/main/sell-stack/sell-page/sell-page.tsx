'use client';

import { useEffect, useMemo, useState } from 'react';
import styles from './sell-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { useStackBack } from '@/hooks/useStackBack';
import { useNav } from '@academix-admin/navigation-stack';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { SearchField, useDebounced } from '@/components/ui/SearchField';
import { InfoPanel } from '@/components/ui/Explain';
import { Collapsible } from '@/components/ui/Collapsible';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { CloseIcon, MinusIcon, PlusIcon, ReceiptIcon, ReturnIcon } from '@/components/ui/Icon';
import { TakePayment } from './TakePayment';
import { CustomerPicker } from '@/components/customers/CustomerPicker';
import { ProductForm } from '@/components/catalog/ProductForm';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { fetchSaleUnits, useProductSearch, type SaleUnit } from '@/lib/stacks/catalog-stack';
import {
  chargesTotal,
  draftSubtotal,
  draftTotal,
  baseUnitsPerSaleUnit,
  lineTotal,
  makeDraftLine,
  useDraftOrders,
  type DraftLine,
} from '@/lib/stacks/draft-orders';
import { formatMoney, formatQty, pluralUnit } from '@/lib/format';
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
/** Stable keys for charge rows, so editing one does not re-key the others and lose focus. */
const newChargeKey = () =>
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
    claimByCode,
    push,
    error: draftError,
    syncing,
  } = useDraftOrders(store?.id ?? null);

  const [picking, setPicking] = useState(false);
  const [addingProduct, setAddingProduct] = useState(false);

  /** Which empties pools each product on the receipt belongs to, keyed by product id. */
  const [returnables, setReturnables] = useState<
    Record<string, { categoryId: string; categoryName: string; kind: string }[]>
  >({});
  const [paying, setPaying] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  // Remembers that the picker was opened mid-payment, so choosing someone returns to the
  // sheet instead of dropping the seller back on the order with the payment half-entered.
  const [resumePayment, setResumePayment] = useState(false);
  const [code, setCode] = useState('');
  // Sale units per product, fetched once when a product is first added to any order.
  const [saleUnits, setSaleUnits] = useState<Record<string, SaleUnit[]>>({});
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query);

  const { products, status } = useProductSearch(store?.id ?? null, picking ? debouncedQuery : null);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  // Nothing open on this device: start one, so the screen is ready to sell rather than empty.
  useEffect(() => {
    if (store && orders.length === 0) startOrder();
  }, [store, orders.length, startOrder]);

  const subtotal = activeOrder ? draftSubtotal(activeOrder) : 0;
  const total = activeOrder ? draftTotal(activeOrder) : 0;

  const addProduct = async (productId: string) => {
    const product = productById.get(productId);
    if (!product || !activeOrder) return;

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
      setPicking(false);
      setQuery('');
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
    setPicking(false);
    setQuery('');
  };

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
   * payment sheet asks — at the point the answer actually matters.
   */
  const openPayment = async () => {
    if (!activeOrder || !store) return;
    await push(activeOrder);
    setPaying(true);
  };

  if (!store) return null;

  return (
    <PageScaffold
      onBack={goBack}
      title="Sell"
      subtitle={store.name}
      action={
        <button
          type="button"
          className={styles.claimButton}
          onClick={() => setClaiming((v) => !v)}
          // The icon and the label both flip. A control that opens a panel and then looks
          // identical while the panel is open gives no way to tell that tapping it again is what
          // closes it — so people hunt for a way out and there isn't one.
          aria-label={claiming ? 'Close the order code box' : 'Take over an order using its code'}
          aria-expanded={claiming}
        >
          {claiming ? <CloseIcon /> : <ReturnIcon />}
        </button>
      }
      footer={
        activeOrder && activeOrder.lines.length > 0 ? (
          <>
            <div className={styles.footerRow}>
              <span className={styles.footerLabel}>Total to pay</span>
              <span className={styles.footerTotal}>{formatMoney(total)}</span>
            </div>
            <Button size="large" fullWidth onClick={() => void openPayment()}>
              Take payment
            </Button>
          </>
        ) : undefined
      }
    >
      {/* ── Customer tabs ───────────────────────────────────────────────────────── */}
      <div className={styles.tabStrip}>
        {orders.map((order, index) => (
          <button
            key={order.clientUuid}
            type="button"
            className={`${styles.tab} ${order.clientUuid === activeId ? styles.tabActive : ''}`}
            onClick={() => setActiveId(order.clientUuid)}
            aria-current={order.clientUuid === activeId ? 'true' : undefined}
          >
            <span>{order.customerName.trim() || order.label.trim() || `Customer ${index + 1}`}</span>
            <span className={styles.tabAmount}>{formatMoney(draftTotal(order))}</span>
          </button>
        ))}
        <button
          type="button"
          className={styles.tabAdd}
          onClick={() => startOrder()}
          aria-label="Start another customer"
        >
          <PlusIcon />
        </button>
      </div>

      {claiming && (
        <div className={styles.claimPanel}>
          <Field
            label="Order code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCDE"
            hint="Ask your colleague for the code shown on their order."
            autoCapitalize="characters"
            autoCorrect="off"
          />
          <div className={styles.claimActions}>
            {/* Cancel sits beside the action rather than only in the header: this panel covers the
                order being worked on, and the way out has to be where the eye already is. */}
            <Button
              variant="secondary"
              onClick={() => {
                setClaiming(false);
                setCode('');
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={async () => {
                const claimed = await claimByCode(code);
                if (claimed) {
                  setClaiming(false);
                  setCode('');
                }
              }}
            >
              Take over this order
            </Button>
          </div>
        </div>
      )}

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
        <>
          {/*
            Customer is an OPTIONAL chip, not a field at the top of the form.

            Most buyers are anonymous walk-ins paying cash, so asking "who is this?" before
            anything can be added to a receipt is a question the seller usually cannot answer and
            does not need to. Attaching someone is available here for a regular you already know,
            and is otherwise asked for at the moment it genuinely matters — when part of the
            money is going on account.
          */}
          <button
            type="button"
            className={styles.customerChip}
            onClick={() => setPickingCustomer(true)}
          >
            {activeOrder.customerId ? (
              <>
                <span className={styles.customerName}>{activeOrder.customerName}</span>
                <span className={styles.customerHint}>Tap to change</span>
              </>
            ) : (
              <>
                <span className={styles.customerName}>Walk-in customer</span>
                <span className={styles.customerHint}>Tap to attach someone</span>
              </>
            )}
          </button>

          {/* The row is always here once a customer is being served; only the CODE waits on the
              server. Rendering the whole block conditionally made it appear a second later and
              push everything below it down — the page visibly jumped while the seller was already
              reading it. Reserving the space costs one row and removes the jump entirely. */}
          <div className={styles.codeRow}>
            <span className={styles.codeLabel}>Order code</span>
            <span className={`${styles.codeValue} ${activeOrder.code ? '' : styles.codePending}`}>
              {activeOrder.code ?? '·····'}
            </span>
            <span className={styles.codeHint}>
              {activeOrder.code
                ? 'Read this out to hand the order over'
                : syncing
                  ? 'Getting a code…'
                  : 'A code appears once this order reaches the shop'}
            </span>
          </div>

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
          {picking ? (
            <div>
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder="Search products or a category"
                label="Search products"
                resultCount={products.length}
                autoFocus
              />

              {status === 'loading' && products.length === 0 ? (
                <FullPageMessage title="Searching" tone="loading" />
              ) : products.length === 0 ? (
                <>
                  <InfoPanel tone="info" title="Nothing found">
                    Try part of the name, or a category like &ldquo;water&rdquo;.
                  </InfoPanel>
                  {/*
                    The most useful moment to add a product is the one where the shop is being
                    asked for something it has never entered. Sending the seller to another screen
                    here means abandoning a half-built receipt, so the form comes to them.
                  */}
                  {can('products.manage') && (
                    <Button
                      variant="secondary"
                      size="large"
                      fullWidth
                      onClick={() => setAddingProduct(true)}
                    >
                      <PlusIcon /> Add &ldquo;{query.trim() || 'a new item'}&rdquo; to your shop
                    </Button>
                  )}
                </>
              ) : (
                <div className={styles.lines}>
                  {products.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={styles.pickItem}
                      onClick={() => void addProduct(p.id)}
                    >
                      <span className={styles.lineName}>{p.name}</span>
                      <span className={styles.lineMeta}>
                        {formatQty(p.onHand)} {pluralUnit(p.baseUnit, Number(p.onHand))} left
                        {p.categoryName ? ` · ${p.categoryName}` : ''}
                        {p.listPrice ? ` · ${formatMoney(p.listPrice)}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <Button
                variant="ghost"
                fullWidth
                onClick={() => {
                  setPicking(false);
                  setQuery('');
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div style={{ marginBottom: 'var(--space-5)' }}>
              <Button variant="secondary" size="large" fullWidth onClick={() => setPicking(true)}>
                <PlusIcon /> Add an item
              </Button>
            </div>
          )}

          {/* ── Totals ────────────────────────────────────────────────────────── */}
          {activeOrder.lines.length > 0 && (
            <>
              <div className={styles.totals}>
                <div className={styles.totalRow}>
                  <span>Items</span>
                  <span className={styles.totalValue}>{formatMoney(subtotal)}</span>
                </div>
                {(activeOrder.charges ?? [])
                  .filter((c) => Number(c.amount) > 0)
                  .map((c) => (
                    <div className={styles.totalRow} key={c.key}>
                      <span>{c.label.trim() || 'Charge'}</span>
                      <span className={styles.totalValue}>{formatMoney(c.amount)}</span>
                    </div>
                  ))}
                <div className={`${styles.totalRow} ${styles.grandRow}`}>
                  <span className={styles.grandLabel}>Total</span>
                  <span className={styles.grandValue}>{formatMoney(total)}</span>
                </div>
              </div>

              {/* Needed on some sales, not most. Collapsed by default so the items and the
                  total own the screen — but the summary states the charge, so folding it away
                  never folds away money. */}
              <Collapsible
                tone="card"
                title="Extra charge or note"
                defaultOpen={(activeOrder.charges?.length ?? 0) > 0 || activeOrder.note !== ''}
                summary={
                  chargesTotal(activeOrder) > 0
                    ? `${activeOrder.charges.length} · ${formatMoney(chargesTotal(activeOrder))}`
                    : activeOrder.note
                      ? 'Note added'
                      : 'None'
                }
              >
                {/*
                  A list, not one box.
                  A distributor's bill routinely carries transport AND loading AND an amount
                  carried over. Added together under one name they become a number the customer
                  cannot check and the shop cannot explain weeks later.
                */}
                {(activeOrder.charges ?? []).map((c, i) => (
                  <div key={c.key} className={styles.chargeRow}>
                    <Field
                      label={`Charge ${i + 1}`}
                      value={c.label}
                      onChange={(e) =>
                        updateOrder(activeOrder.clientUuid, {
                          charges: activeOrder.charges.map((x) =>
                            x.key === c.key ? { ...x, label: e.target.value } : x,
                          ),
                        })
                      }
                      placeholder="Transport"
                    />
                    <Field
                      label="Amount"
                      numeric
                      prefix="₦"
                      value={c.amount}
                      onChange={(e) =>
                        updateOrder(activeOrder.clientUuid, {
                          charges: activeOrder.charges.map((x) =>
                            x.key === c.key ? { ...x, amount: e.target.value } : x,
                          ),
                        })
                      }
                      placeholder="0"
                    />
                    <button
                      type="button"
                      className={styles.chargeRemove}
                      onClick={() =>
                        updateOrder(activeOrder.clientUuid, {
                          charges: activeOrder.charges.filter((x) => x.key !== c.key),
                        })
                      }
                      aria-label={`Remove ${c.label.trim() || `charge ${i + 1}`}`}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                ))}

                <Button
                  variant="secondary"
                  fullWidth
                  onClick={() =>
                    updateOrder(activeOrder.clientUuid, {
                      charges: [
                        ...(activeOrder.charges ?? []),
                        { key: newChargeKey(), label: '', amount: '' },
                      ],
                    })
                  }
                >
                  <PlusIcon /> Add a charge
                </Button>

                <Field
                  label="Note"
                  optional
                  value={activeOrder.note}
                  onChange={(e) => updateOrder(activeOrder.clientUuid, { note: e.target.value })}
                  placeholder="Anything to remember about this sale"
                />
              </Collapsible>

            </>
          )}

          {/* Outside the "has lines" block on purpose. It used to live inside it, so emptying a
              receipt took away the only way to close the tab — leaving a customer tab that could
              not be sold and could not be dismissed. Closing is most needed exactly then. */}
          <Button
            variant="ghost"
            fullWidth
            onClick={() => closeOrder(activeOrder.clientUuid)}
          >
            Close this tab without selling
          </Button>
        </>
      )}
      {activeOrder && (
        <ProductForm
          open={addingProduct}
          onClose={() => setAddingProduct(false)}
          storeId={store.id}
          initialName={query.trim()}
          onSaved={(created) => {
            // Straight onto the receipt. Adding it and then making the seller search for it
            // again would be the same interruption in two steps instead of one.
            setAddingProduct(false);
            void addProduct(created.id);
          }}
        />
      )}

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
              setPaying(true);
            }
          }}
          onClose={() => {
            setPickingCustomer(false);
            // Backing out must also return to the payment sheet — the seller may simply have
            // decided the sale is anonymous after all, and should not have to start again.
            if (resumePayment) {
              setResumePayment(false);
              setPaying(true);
            }
          }}
        />
      )}

      {activeOrder && (
        <TakePayment
          open={paying}
          onClose={() => setPaying(false)}
          order={activeOrder}
          storeId={store.id}
          total={total}
          onNeedCustomer={() => {
            setPaying(false);
            setResumePayment(true);
            setPickingCustomer(true);
          }}
          onSettled={(saleId) => {
            setPaying(false);

            /*
             * Navigate FIRST, then close the tab.
             *
             * Closing empties the order list, which immediately starts a fresh order, and the
             * churn that follows was swallowing whatever came after it — first a sheet's state,
             * then the push itself. The sale is already recorded at this point, so the order of
             * these two is purely about what the seller ends up looking at.
             */
            void nav.push('receipt_page', { id: saleId, fresh: '1' });

            // The tab closes only once the sale is recorded. Closing it optimistically would
            // lose the order if the write failed.
            closeOrder(activeOrder.clientUuid);
          }}
        />
      )}

    </PageScaffold>
  );
}
