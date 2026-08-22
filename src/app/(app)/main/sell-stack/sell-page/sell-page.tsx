'use client';

import { useEffect, useMemo, useState } from 'react';
import styles from './sell-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { useStackBack } from '@/hooks/useStackBack';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { SearchField, useDebounced } from '@/components/ui/SearchField';
import { InfoPanel } from '@/components/ui/Explain';
import { Collapsible } from '@/components/ui/Collapsible';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { CloseIcon, MinusIcon, PlusIcon, ReceiptIcon, ReturnIcon } from '@/components/ui/Icon';
import { TakePayment } from './TakePayment';
import { Receipt } from './Receipt';
import { CustomerPicker } from '@/components/customers/CustomerPicker';
import { Sheet } from '@/components/ui/Sheet';
import { useAuth } from '@/providers/AuthProvider';
import { fetchSaleUnits, useProductSearch, type SaleUnit } from '@/lib/stacks/catalog-stack';
import {
  draftSubtotal,
  draftTotal,
  baseUnitsPerSaleUnit,
  lineTotal,
  makeDraftLine,
  useDraftOrders,
  type DraftLine,
} from '@/lib/stacks/draft-orders';
import { formatMoney, formatQty, pluralUnit } from '@/lib/format';

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
 * The fractional amounts a seller can tap straight onto a line.
 *
 * A fixed list rather than a setting: these are the fractions a pack is physically broken into,
 * and offering an arbitrary one would mean sellers picking a fraction the goods do not divide
 * into. Which of them actually appear is decided per line by whether they land on whole base
 * units.
 */
const FRACTIONS = [
  { label: '¼', value: 0.25 },
  { label: '½', value: 0.5 },
  { label: '¾', value: 0.75 },
  { label: '1', value: 1 },
] as const;

export default function SellPage() {
  const goBack = useStackBack();
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
  const [paying, setPaying] = useState(false);
  const [settledSale, setSettledSale] = useState<string | null>(null);
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

  const step = (line: DraftLine, by: number) => {
    if (!activeOrder) return;
    const current = Number(line.qty);
    const next = (Number.isFinite(current) ? current : 0) + by;
    if (next < 0) return;
    updateLine(activeOrder.clientUuid, line.key, { qty: String(next) });
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
                            onClick={() =>
                              updateLine(activeOrder.clientUuid, line.key, {
                                saleUnitId: u.id,
                                saleUnitName: u.name,
                                saleUnitBaseQty: u.baseQty,
                                // Switching shape switches price: each shape carries its own,
                                // and keeping the previous one would quietly sell a half pack
                                // at the full pack price.
                                unitPrice: u.price ?? line.unitPrice,
                              })
                            }
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
                            onChange={(e) =>
                              updateLine(activeOrder.clientUuid, line.key, { qty: e.target.value })
                            }
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

                      <Field
                        label={line.saleUnitName ? `Price per ${line.saleUnitName.toLowerCase()}` : 'Price each'}
                        numeric
                        prefix="₦"
                        value={line.unitPrice}
                        onChange={(e) =>
                          updateLine(activeOrder.clientUuid, line.key, {
                            unitPrice: e.target.value,
                          })
                        }
                        error={under ? 'Below what this cost you' : null}
                      />
                    </div>

                    {(() => {
                      /*
                       * Quick fractions of whatever is being sold — a quarter, half or three
                       * quarters of a pack, straight onto the quantity.
                       *
                       * Typing "0.25" into a number field at a counter is slower and easier to
                       * get wrong than tapping a button, and these three are most of the
                       * fractional sales a distributor makes.
                       *
                       * OFFERED ONLY WHEN THEY LAND ON WHOLE BASE UNITS. A quarter of a 12-piece
                       * pack is 3 pieces and is real; a quarter of a single bottle is not, and
                       * the database rejects it — so the guard belongs here too rather than
                       * letting the seller build a line that cannot be settled.
                       */
                      const per = baseUnitsPerSaleUnit(line);
                      const options = FRACTIONS.filter((f) => (per * f.value) % 1 === 0);
                      if (options.length === 0) return null;
                      return (
                        <div className={styles.fractionBlock}>
                          <span className={styles.fractionLabel}>Quick amount</span>
                          <div
                            className={styles.fractionRow}
                            role="group"
                            aria-label="Set the quantity to a fraction"
                          >
                            {options.map((f) => {
                              const on = Number(line.qty) === f.value;
                              return (
                                <button
                                  key={f.label}
                                  type="button"
                                  className={`${styles.fraction} ${on ? styles.fractionActive : ''}`}
                                  aria-pressed={on}
                                  onClick={() =>
                                    updateLine(activeOrder.clientUuid, line.key, {
                                      qty: String(f.value),
                                    })
                                  }
                                >
                                  {f.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

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
                <InfoPanel tone="info" title="Nothing found">
                  Try part of the name, or a category like &ldquo;water&rdquo;.
                </InfoPanel>
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
                {Number(activeOrder.feeAmount) > 0 && (
                  <div className={styles.totalRow}>
                    <span>{activeOrder.feeLabel.trim() || 'Extra charge'}</span>
                    <span className={styles.totalValue}>{formatMoney(activeOrder.feeAmount)}</span>
                  </div>
                )}
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
                defaultOpen={Number(activeOrder.feeAmount) > 0 || activeOrder.note !== ''}
                summary={
                  Number(activeOrder.feeAmount) > 0
                    ? `${activeOrder.feeLabel.trim() || 'Charge'} ${formatMoney(activeOrder.feeAmount)}`
                    : activeOrder.note
                      ? 'Note added'
                      : 'None'
                }
              >
                <Field
                  label="Extra charge"
                  optional
                  numeric
                  prefix="₦"
                  value={activeOrder.feeAmount}
                  onChange={(e) =>
                    updateOrder(activeOrder.clientUuid, { feeAmount: e.target.value })
                  }
                  placeholder="0"
                  hint="Delivery or anything else added to this customer's bill."
                />

                {Number(activeOrder.feeAmount) > 0 && (
                  <Field
                    label="What is the charge for?"
                    value={activeOrder.feeLabel}
                    onChange={(e) =>
                      updateOrder(activeOrder.clientUuid, { feeLabel: e.target.value })
                    }
                    placeholder="Delivery"
                  />
                )}

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
          total={total}
          onNeedCustomer={() => {
            setPaying(false);
            setResumePayment(true);
            setPickingCustomer(true);
          }}
          onSettled={(saleId) => {
            setPaying(false);
            setSettledSale(saleId);
            // The tab closes only once the sale is recorded. Closing it optimistically would
            // lose the order if the write failed.
            closeOrder(activeOrder.clientUuid);
          }}
        />
      )}

      {settledSale && (
        <Sheet
          open
          onClose={() => setSettledSale(null)}
          title="Sale recorded"
          footer={
            <Button size="large" fullWidth onClick={() => setSettledSale(null)}>
              Done
            </Button>
          }
        >
          <InfoPanel tone="success" title="Saved">
            The stock has come off your shelf and any unpaid part is on the customer&rsquo;s
            account.
          </InfoPanel>
          <Receipt saleId={settledSale} storeId={store.id} />
        </Sheet>
      )}
    </PageScaffold>
  );
}
