'use client';

import { useEffect, useMemo, useState } from 'react';
import styles from './sell-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { SearchField, useDebounced } from '@/components/ui/SearchField';
import { InfoPanel } from '@/components/ui/Explain';
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
  lineBaseQty,
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
export default function SellPage() {
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
    const perBase =
      Number(line.unitPrice) / (line.packId && line.packQty ? Number(line.packQty) : 1);
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
      title="Sell"
      subtitle={store.name}
      action={
        <button
          type="button"
          className={styles.claimButton}
          onClick={() => setClaiming((v) => !v)}
          aria-label="Take over an order using its code"
        >
          <ReturnIcon />
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
          <Button
            fullWidth
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
                <span className={styles.customerHint}>
                  Tap to attach someone — only needed for credit
                </span>
              </>
            )}
          </button>

          {activeOrder.code && (
            <div className={styles.codeRow}>
              <span className={styles.codeLabel}>Order code</span>
              <span className={styles.codeValue}>{activeOrder.code}</span>
              <span className={styles.codeHint}>
                {syncing ? 'Saving…' : 'Read this out to hand the order over'}
              </span>
            </div>
          )}

          {/* ── Lines ─────────────────────────────────────────────────────────── */}
          {activeOrder.lines.length > 0 && (
            <div className={styles.lines}>
              {activeOrder.lines.map((line) => {
                const under = belowCost(line);
                return (
                  <div className={styles.line} key={line.key}>
                    <div className={styles.lineHead}>
                      <div>
                        <p className={styles.lineName}>{line.productName}</p>
                        <p className={styles.lineMeta}>
                          {formatQty(lineBaseQty(line))}{' '}
                          {pluralUnit(line.baseUnit, lineBaseQty(line))} in total
                        </p>
                      </div>
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

              <Button
                variant="ghost"
                fullWidth
                onClick={() => closeOrder(activeOrder.clientUuid)}
              >
                Close this tab without selling
              </Button>
            </>
          )}
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
