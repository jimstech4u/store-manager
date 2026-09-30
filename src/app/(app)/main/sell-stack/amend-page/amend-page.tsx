'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { CameraIcon, PlusIcon } from '@/components/ui/Icon';
import { ConfirmDialog, useConfirm } from '@/components/ui/Dialog';
import { FloatingAmount } from '@/components/ui/FloatingAmount';
import { ProductPicker } from '@/components/catalog/ProductPicker';
import { BarcodeScanner } from '@/components/catalog/BarcodeScanner';
import { CustomerPicker } from '@/components/customers/CustomerPicker';
import { SaleLineRow } from '@/components/sell/SaleLineRow';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useTillShapes } from '@/lib/stacks/till-shapes';
import { findByBarcode } from '@/lib/stacks/mid-sale';
import { amendCharges, amendDeposits, amendItems, amendTotal, useAmendDraft } from '@/lib/stacks/amend-draft';
import { formatMoney } from '@/lib/format';

import styles from './amend-page.module.css';

/**
 * CORRECTING A RECEIPT — the till again, for a sale that already happened.
 *
 * It used to be a narrow form: change how many, change the price, on the lines already there. That
 * covers a mis-keyed quantity and nothing else. A crate that went out and never reached the receipt
 * had no path at all, and the last line could be taken off but not the last one — so a sale that
 * never happened could be corrected down to almost nothing and never cancelled.
 *
 * NOT A VOID AND A RE-KEY. The customer is holding a printed copy with this number on it and a
 * tracking link that has to keep resolving. Voiding loses both, loses the payment allocation, and
 * makes two documents out of one sale. The receipt keeps its id and gains a revision.
 *
 * THE CUSTOMER CANNOT BE CHANGED HERE, and that is deliberate: a receipt belongs to whoever it was
 * made out to, and moving it would move the debt with it. A WALK-IN is the exception — it has
 * nobody, and the server refuses a correction leaving money owing with no account to carry it, so
 * naming somebody is the only way to finish. Naming, not changing.
 *
 * THE FLOW: here, then the money, then why, then the receipt. The reason comes LAST because it is
 * about what was done, and until the money is settled nobody knows what that was.
 */
export default function AmendPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const saleId = (location?.params?.id as string | undefined) ?? null;
  const { draft, loaded, patchOrder, updateLine, removeLine, addLine } = useAmendDraft(saleId);
  /*
   * THE SHAPES, from the same place the till reads them.
   *
   * A first version mapped them into a shape of its own and the types caught it: `SaleUnit.baseQty`
   * is a string and mine was a number. That mismatch is the small end of a real hazard — two
   * answers to "what shapes does this item come in", differing on a detail nobody checks until a
   * half-crate prices itself wrong.
   */
  const productIds = (draft.order?.lines ?? []).map((l) => l.productId);
  const { shapes: saleUnits, ensure: ensureShapes } = useTillShapes(store?.id ?? null, productIds);

  const [picking, setPicking] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [namingCustomer, setNamingCustomer] = useState(false);

  /*
   * A CUSTOMER CREATED FOR THIS CORRECTION IS NAMED ON IT.
   *
   * The form has always looked for `onCustomerForAmend` — and nothing ever provided it, so a walk-in
   * named by creating somebody new came back to a correction still asking who it was for. The
   * seller then found them in the picker and chose them again: the "second click".
   */
  const nameRef = useRef<((customer: { id: string; name: string }) => void) | null>(null);
  nameRef.current = (customer) => patchOrder({ customerId: customer.id, customerName: customer.name });
  useEffect(() => {
    const off = nav.provideObject(
      'onCustomerForAmend',
      () => (customer: { id: string; name: string; phone: string }) => nameRef.current?.(customer),
      { global: true, scope: 'people' },
    );
    return () => {
      off?.();
    };
  }, [nav]);
  const cancelAsk = useConfirm();
  /*
   * WHETHER THE DIALOG IS ON THE PAGE IS DECIDED HERE — "mounted means asked".
   *
   * `ConfirmDialog` opens itself on mount and its overlay swallows every tap behind it, so leaving
   * one mounted puts an invisible sheet over a working screen. The till learned this the hard way.
   */
  const [askCancel, setAskCancel] = useState(false);

  if (!store) return null;

  const order = draft.order;
  const was = draft.was;

  const status: PageStatus = !saleId
    ? { state: 'empty', title: 'No receipt chosen', body: 'Corrections are reached from a receipt.' }
    : !loaded
      ? { state: 'loading', what: 'this receipt' }
      : was && was.status !== 'posted'
        ? {
            state: 'empty',
            title: `This receipt is ${was.status}`,
            body: 'There is nothing to correct on a receipt that has already been cancelled.',
          }
        : { state: 'ready' };

  const total = amendTotal(draft);
  const lines = order?.lines ?? [];
  const emptied = lines.length === 0;

  const shapesFor = (productId: string) => saleUnits[productId] ?? [];

  /** The parts this shape may be sold in, exactly as the till decides it. */
  const rulesFor = (productId: string, saleUnitId: string | null) => {
    const unit = shapesFor(productId).find((u) => u.id === saleUnitId);
    return {
      wholeDigit: unit?.wholeDigit ?? true,
      allowQuarter: unit?.allowQuarter ?? false,
      allowHalf: unit?.allowHalf ?? false,
      allowThreeQuarter: unit?.allowThreeQuarter ?? false,
    };
  };

  /**
   * An item onto the receipt, in its default shape at its usual price.
   *
   * Its shapes are ASKED FOR first. They are fetched per item and this receipt's own items are the
   * only ones loaded, so something added now has none yet — and a line with no shape cannot be
   * priced, cannot offer its parts, and cannot say whether a crate goes out with it.
   */
  const put = async (product: { id: string; name: string }) => {
    /*
     * `ensure` hands the shapes BACK as well as caching them. Reading `saleUnits` straight after
     * calling it would be reading the render that has not happened yet — the line would be added
     * with no shape, no price and no answer about whether a crate goes out with it.
     */
    const shapes = await ensureShapes(product.id);
    const first = shapes[0];
    addLine({
      key: `${product.id}-${Date.now().toString(36)}`,
      productId: product.id,
      productName: product.name,
      baseUnit: '',
      qty: '1',
      packId: null,
      packName: null,
      packQty: null,
      unitPrice: first?.price ?? '0',
      containersOut: first?.isReturnable ? '1' : '0',
      depositCharged: '0',
      saleUnitId: first?.id ?? null,
      saleUnitName: first?.name ?? null,
      saleUnitBaseQty: first?.baseQty ?? '1',
    });
  };

  return (
    <PageScaffold onBack={goBack} title="Correct this receipt" subtitle="What it should have said">
      <PageState status={status}>
        {() =>
          order && (
            <>
              <Explain label="What happens to the old copy?">
                The receipt keeps its number, so the link you sent the customer still works. What it
                said before is kept in full, and the new copy says it replaces the old one — because
                somebody may still be holding that.
              </Explain>

              {was && was.revision > 1 && (
                <InfoPanel tone="info" title={`This is already revision ${was.revision}`}>
                  It has been corrected before. Everything it has said is kept.
                </InfoPanel>
              )}

              {/*
                WHOSE RECEIPT IT IS — shown, not offered.

                A receipt belongs to whoever it was made out to. Changing that would move the debt
                and the containers to somebody who never took them.
              */}
              {order.customerId ? (
                <p className={styles.who}>
                  For <strong>{order.customerName}</strong>
                </p>
              ) : (
                <>
                  <InfoPanel tone="warning" title="Nobody is named on this receipt">
                    It was sold over the counter. If your correction leaves money owing or containers
                    out, there has to be somebody to owe it.
                  </InfoPanel>
                  <Button variant="secondary" fullWidth onClick={() => setNamingCustomer(true)}>
                    Add a customer to it
                  </Button>
                </>
              )}

              {/* ── The lines, edited exactly as they are at the till ─────────── */}
              <div className={styles.lines}>
                {lines.map((line) => (
                  <SaleLineRow
                    key={line.key}
                    line={line}
                    shapes={shapesFor(line.productId)}
                    rules={rulesFor(line.productId, line.saleUnitId)}
                    total={(Number(line.qty) || 0) * (Number(line.unitPrice) || 0)}
                    belowCost={false}
                    onPatch={(next) => updateLine(line.key, next)}
                    onRemove={() => removeLine(line.key)}
                    onStep={(direction) =>
                      updateLine(line.key, {
                        qty: String(Math.max(0, (Number(line.qty) || 0) + direction)),
                      })
                    }
                    /*
                     * No repricing on a correction. A bulk band is today's price list, and this
                     * receipt was made on a day that has gone — quietly repricing a line the seller
                     * did not touch would rewrite history to match this morning's prices.
                     */
                    onReprice={() => {}}
                  />
                ))}
              </div>

              {emptied && (
                <InfoPanel tone="warning" title="Nothing left on this receipt">
                  Correcting it with no items cancels it. The stock goes back, the containers come
                  off the customer, and anything paid becomes credit to them.
                </InfoPanel>
              )}

              {/* ── The two ways onto a receipt, the same two the till offers ─── */}
              <div className={styles.add}>
                <Button variant="secondary" fullWidth onClick={() => setPicking(true)}>
                  <PlusIcon /> Add an item
                </Button>
                <Button variant="secondary" fullWidth onClick={() => setScanning(true)}>
                  <CameraIcon /> Scan a barcode
                </Button>
              </div>

              {was && (
                <div className={styles.totals}>
                  {/*
                    THE WHOLE ARITHMETIC, not just the two ends of it.

                    This showed "It said N5,000 / It should say N5,000" and nothing else, so a
                    seller looking at a corrected receipt could not see WHICH part had moved —
                    and when the two figures matched, could not tell whether that was right or
                    whether their edit had failed to register.

                    The steps only appear when there is more than one, because on a plain sale
                    "Items" and "It should say" are the same number twice.
                  */}
                  {(amendCharges(draft) > 0.005 || amendDeposits(draft) > 0.005) && (
                    <>
                      <div className={styles.totalRow}>
                        <span>Items</span>
                        <span>{formatMoney(amendItems(draft))}</span>
                      </div>
                      {(order?.charges ?? [])
                        .filter((c) => Number(c.amount) > 0)
                        .map((c) => (
                          <div className={styles.totalRow} key={c.key}>
                            <span>{c.label || 'Charge'}</span>
                            <span>{formatMoney(Number(c.amount))}</span>
                          </div>
                        ))}
                      {amendDeposits(draft) > 0.005 && (
                        <div className={styles.totalRow}>
                          <span>Deposit on containers</span>
                          <span>{formatMoney(amendDeposits(draft))}</span>
                        </div>
                      )}
                    </>
                  )}

                  <div className={styles.totalRow}>
                    <span>It said</span>
                    <span>{formatMoney(was.total)}</span>
                  </div>
                  <div className={styles.totalRow}>
                    <strong>It should say</strong>
                    <strong>{formatMoney(total)}</strong>
                  </div>
                  {/*
                    AND WHAT SITS BESIDE IT: the deposit put down with the sale, and what has been
                    paid. "The correct receipt page should also load the breakdown." Changed on the
                    next step, where each has its own cancel.
                  */}
                  {(was.depositTaken ?? 0) > 0.005 && (
                    <div className={styles.totalRow}>
                      <span>
                        Deposit put down with it
                        {(was.depositUnpaid ?? 0) > 0.005
                          ? ` (${formatMoney(was.depositUnpaid ?? 0)} not paid)`
                          : ''}
                      </span>
                      <span>{formatMoney(was.depositTaken ?? 0)}</span>
                    </div>
                  )}
                  {(was.payments ?? []).map((pay, i) => (
                    <div className={styles.totalRow} key={pay.paymentId ?? `paid-${i}`}>
                      <span>Paid ({pay.method})</span>
                      <span>{formatMoney(pay.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )
        }
      </PageState>

      {/*
        CORRECT PAYMENT, not Take payment.

        The money is the next step, not this one — a correction routinely finds more owing and the
        customer pays the difference standing there. Floating, in the same place the till puts its
        own, because this screen IS the till and a seller's thumb is already there.
      */}
      {order && !emptied && (
        <FloatingAmount
          who={order.customerName || 'this receipt'}
          label="Correct payment"
          amount={formatMoney(total)}
          onClick={() => void nav.push('amend_payment_page', { id: saleId ?? '' })}
        />
      )}

      {/*
        AND WHEN IT HAS BEEN EMPTIED, the button says what it will actually do.

        Sending somebody to a payment screen for a receipt that is about to be cancelled would be
        the software pretending not to know.
      */}
      {order && emptied && (
        <FloatingAmount
          who={order.customerName || 'this receipt'}
          label="Cancel this receipt"
          amount={formatMoney(0)}
          onClick={() => setAskCancel(true)}
        />
      )}

      {askCancel && (
        <ConfirmDialog
          controller={cancelAsk}
          title="Cancel this receipt?"
          message={
            'Everything comes off: the stock goes back on your shelf, the containers come off the ' +
            'customer, and anything paid becomes credit to them. You will be asked why.'
          }
          confirmText="Yes, cancel it"
          tone="danger"
          onDismiss={() => setAskCancel(false)}
          onConfirm={() => {
            setAskCancel(false);
            void nav.push('amend_reason_page', { id: saleId ?? '' });
          }}
        />
      )}

      <ProductPicker
        open={picking}
        onClose={() => setPicking(false)}
        storeId={store.id}
        onPick={(product) => {
          void put(product);
          setPicking(false);
        }}
      />

      <BarcodeScanner
        open={scanning}
        onClose={() => setScanning(false)}
        onRead={(code) => {
          setScanning(false);
          void (async () => {
            const found = await findByBarcode(store.id, code);
            if (found) await put({ id: found.id, name: found.name });
          })();
        }}
      />

      {/*
        NAMING a walk-in, never moving a receipt to somebody else. The picker opens ON this page so
        popping a pushed one cannot throw away the correction being built.
      */}
      <CustomerPicker
        open={namingCustomer}
        onClose={() => setNamingCustomer(false)}
        storeId={store.id}
        onPick={(customer) => {
          patchOrder({ customerId: customer.id, customerName: customer.name });
          setNamingCustomer(false);
        }}
        onCreate={(name) => {
          setNamingCustomer(false);
          void nav.push('customer_form_page', {
            ...(name.trim() ? { name } : {}),
            then: 'attach-to-amend',
            required: 'minimum',
          });
        }}
      />
    </PageScaffold>
  );
}
