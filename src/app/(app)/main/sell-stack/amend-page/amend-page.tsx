'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { ConfirmDialog, useConfirm } from '@/components/ui/Dialog';
import { FloatingAmount } from '@/components/ui/FloatingAmount';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { ProductPicker } from '@/components/catalog/ProductPicker';
import { useFinishedGuard } from '@/components/sell/FinishedItem';
import { BarcodeScanner } from '@/components/catalog/BarcodeScanner';
import { CustomerPicker } from '@/components/customers/CustomerPicker';
import { SaleLineRow } from '@/components/sell/SaleLineRow';
import { TillLine } from '@/components/sell/TillLine';
import { QuickAdd } from '@/components/sell/QuickAdd';
import { ContainersBack } from '@/components/empties/ContainersBack';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useTillShapes } from '@/lib/stacks/till-shapes';
import { findByBarcode } from '@/lib/stacks/mid-sale';
import { amendCharges, amendDeposits, amendItems, amendTotal, useAmendDraft } from '@/lib/stacks/amend-draft';
import { LEDGERS_SCOPE } from '@/lib/stacks/customer-ledgers';
import { correctedBack, saleEmpties, type SaleContainer } from '@/lib/stacks/sale-empties';
import { containersGoingOut, shapesOf } from '@/lib/empties-back';
import { useSellingUnits } from '@/lib/stacks/selling-units';
import { formatMoney, formatQtySpoken, shapeWord } from '@/lib/format';
import type { DraftLine } from '@/lib/stacks/draft-orders';

import styles from './amend-page.module.css';

/**
 * CORRECTING A RECEIPT — the till, for a sale that already happened, with the trace of what it said.
 *
 * "Correcting a receipt is just exactly like a normal sale; the difference is that here we have traces
 * of old changes." So this is the till's own parts: the one box that takes "3 b/s" (QuickAdd), the
 * compact lines with − and + and the parts (TillLine), a line's full row a tap away — here, in place,
 * because a correction is one page. What a sale does not have is the trace: each line says what it was
 * ("was 3 crates", "was ₦9,500", "new"), what was taken off is listed with Put back, and the empties
 * that went out and came back with it are set here and saved with the correction (0280) — a receipt
 * corrected from three crates to two can no longer keep three "brought back".
 *
 * NOT A VOID AND A RE-KEY: the receipt keeps its number, its link and its payments, and gains a
 * revision. THE CUSTOMER IS NOT CHANGED here (a walk-in may be named): a receipt belongs to whoever it
 * was made out to, and moving it would move the debt. THE FLOW: here, the money, why, the receipt.
 */
export default function AmendPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const saleId = (location?.params?.id as string | undefined) ?? null;
  const { draft, loaded, patch, patchOrder, updateLine, removeLine, addLine } = useAmendDraft(saleId);
  const productIds = (draft.order?.lines ?? []).map((l) => l.productId);
  const { shapes: saleUnits, ensure: ensureShapes } = useTillShapes(store?.id ?? null, productIds);
  // Every shape each item comes in, so a crate can come back as "3 bottles".
  const { units: sellingUnits } = useSellingUnits(store?.id ?? null);

  const [picking, setPicking] = useState(false);
  const finishedGuard = useFinishedGuard();
  const [scanning, setScanning] = useState(false);
  const [namingCustomer, setNamingCustomer] = useState(false);
  // A line's full row, open in place (the till pushes its line page; a correction stays one page).
  const [openKey, setOpenKey] = useState<string | null>(null);

  // What its containers did before this correction: out, back — to trace and to carry forward.
  const before = useLoadArea<SaleContainer[]>(() => saleEmpties(saleId!), [saleId], {
    key: `sale-empties:${saleId ?? 'none'}`,
    scope: LEDGERS_SCOPE,
    whenNot: !saleId,
  });

  /* A customer created for this correction is named on it (see customer-form-page). */
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
  const [askCancel, setAskCancel] = useState(false);

  const order = draft.order;
  const was = draft.was;
  const lines = useMemo(() => order?.lines ?? [], [order?.lines]);

  /** Containers going out now, per shape: a returnable line sends out its quantity (amend-reason-page). */
  const outNow = useMemo(
    () =>
      containersGoingOut(lines, before.data ?? [], (pu) =>
        Object.values(saleUnits).some((shapes) => shapes.some((u) => u.id === pu && u.isReturnable)),
      ),
    [lines, before.data, saleUnits],
  );
  const backNow = useMemo(
    () => correctedBack(before.data ?? [], outNow, draft.emptiesBack ?? {}),
    [before.data, outNow, draft.emptiesBack],
  );

  if (!store) return null;

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
  const emptied = lines.length === 0;
  const shapesFor = (productId: string) => saleUnits[productId] ?? [];
  const rulesFor = (productId: string, saleUnitId: string | null) => {
    const unit = shapesFor(productId).find((u) => u.id === saleUnitId);
    return {
      wholeDigit: unit?.wholeDigit ?? true,
      allowQuarter: unit?.allowQuarter ?? false,
      allowHalf: unit?.allowHalf ?? false,
      allowThreeQuarter: unit?.allowThreeQuarter ?? false,
    };
  };

  /** What the receipt said for this item in this shape — the trace. */
  const wasOf = (productId: string, saleUnitId: string | null) =>
    (was?.lines ?? []).filter((l) => l.productId === productId && l.saleUnitId === saleUnitId);
  const trace = (l: DraftLine): string | null => {
    const old = wasOf(l.productId, l.saleUnitId);
    if (old.length === 0) return 'New on this receipt';
    const qty = old.reduce((n, o) => n + o.enteredQty, 0);
    const bits: string[] = [];
    if (Math.abs(qty - (Number(l.qty) || 0)) > 1e-9) {
      bits.push(`was ${formatQtySpoken(qty)} ${shapeWord(String(qty), old[0].unitName ?? '').toLowerCase()}`);
    }
    if (Math.abs(old[0].unitPrice - (Number(l.unitPrice) || 0)) > 0.005) bits.push(`was ${formatMoney(old[0].unitPrice)} each`);
    return bits.length ? bits.join(' · ') : null;
  };
  // Taken off: on the receipt before, in no line now.
  const takenOff = (was?.lines ?? []).filter(
    (o) => !lines.some((l) => l.productId === o.productId && l.saleUnitId === o.saleUnitId),
  );

  /** An item onto the receipt, in its first shape at its usual price — as the till puts it. */
  const put = async (product: { id: string; name: string }, qty: number | null = null) => {
    const putBack = (was?.lines ?? [])
      .filter((l) => l.productId === product.id)
      .reduce((sum, l) => sum + (Number(l.baseQty) || 0), 0);
    if (!(await finishedGuard.allow(product, putBack))) return;
    const shapes = await ensureShapes(product.id);
    const first = shapes[0];
    addLine({
      key: `${product.id}-${Date.now().toString(36)}`,
      productId: product.id,
      productName: product.name,
      baseUnit: '',
      qty: String(qty ?? 1),
      packId: null,
      packName: null,
      packQty: null,
      unitPrice: first?.price ?? '',
      containersOut: first?.isReturnable ? '1' : '0',
      depositCharged: '0',
      saleUnitId: first?.id ?? null,
      saleUnitName: first?.name ?? null,
      saleUnitBaseQty: first?.baseQty ?? '1',
    });
  };

  /** Put a taken-off line back, exactly as the receipt had it. */
  const putBackLine = (o: (typeof takenOff)[number]) =>
    addLine({
      key: `${o.productId}-${o.saleUnitId ?? 'base'}-${Date.now().toString(36)}`,
      productId: o.productId,
      productName: o.productName,
      baseUnit: '',
      qty: String(o.enteredQty),
      packId: null,
      packName: null,
      packQty: null,
      unitPrice: String(o.unitPrice),
      containersOut: String(o.containersOut),
      depositCharged: '0',
      saleUnitId: o.saleUnitId,
      saleUnitName: o.unitName,
      saleUnitBaseQty: o.enteredQty > 0 ? String(o.baseQty / o.enteredQty) : '1',
    });

  // The empties rows: every shape that went out before or goes out now — counted in bottles too.
  const containerRows = (() => {
    const known = new Map((before.data ?? []).map((c) => [c.productUnitId, c]));
    const ids = new Set([...known.keys(), ...Object.keys(outNow)]);
    return [...ids].map((id) => {
      const c = known.get(id);
      const line = lines.find((l) => l.saleUnitId === id);
      const out = outNow[id] ?? 0;
      const back = backNow[id] ?? 0;
      return {
        id,
        name: c?.productName ?? line?.productName ?? '',
        unitName: c?.unitName ?? line?.saleUnitName ?? '',
        unitPlural: c?.unitPlural ?? (line?.saleUnitName ? `${line.saleUnitName}s` : ''),
        out,
        back,
        // Older crates already recorded may stay; never more than that or what goes out now.
        max: Math.max(out, Math.min(back, c?.cameBack ?? 0)),
        was: c?.cameBack ?? 0,
        shapes: shapesOf(sellingUnits, id),
      };
    }).filter((r) => r.out > 0 || r.back > 0 || r.was > 0);
  })();

  return (
    <PageScaffold
      layout="record"
      onBack={goBack}
      title="Correct this receipt"
      subtitle={was ? `#${was.saleId.slice(0, 8).toUpperCase()} · it said ${formatMoney(was.total)}` : 'What it should have said'}
    >
      <PageState status={status}>
        {() =>
          order && (
            <>
              {was && was.revision > 1 && (
                <InfoPanel tone="info" title={`Already corrected ${was.revision - 1} ${was.revision === 2 ? 'time' : 'times'}`}>
                  Everything it has said is kept.
                </InfoPanel>
              )}

              {order.customerId ? (
                <p className={styles.who}>
                  For <strong>{order.customerName}</strong>
                </p>
              ) : (
                <>
                  <InfoPanel tone="warning" title="Nobody is named on this receipt">
                    It was sold over the counter. If your correction leaves money owing or containers out, there
                    has to be somebody to owe it.
                  </InfoPanel>
                  <Button variant="secondary" fullWidth onClick={() => setNamingCustomer(true)}>
                    Add a customer to it
                  </Button>
                </>
              )}

              {/* ── The lines, as the till shows them, each with its trace ─────────── */}
              <div className={styles.lines}>
                {lines.map((line) => {
                  const said = trace(line);
                  const isNew = said === 'New on this receipt';
                  return (
                    <div key={line.key} className={`${styles.lineWrap} ${said ? (isNew ? styles.lineNew : styles.lineChanged) : ''}`}>
                      {said && <p className={styles.trace}>{said}</p>}
                      {openKey === line.key ? (
                        <>
                          <SaleLineRow
                            line={line}
                            shapes={shapesFor(line.productId)}
                            rules={rulesFor(line.productId, line.saleUnitId)}
                            total={(Number(line.qty) || 0) * (Number(line.unitPrice) || 0)}
                            belowCost={false}
                            onPatch={(next) => updateLine(line.key, next)}
                            onRemove={() => removeLine(line.key)}
                            onStep={(direction) =>
                              updateLine(line.key, { qty: String(Math.max(0, (Number(line.qty) || 0) + direction)) })
                            }
                            // No repricing on a correction: this morning's price list is not that day's.
                            onReprice={() => {}}
                          />
                          <button type="button" className={styles.done} onClick={() => setOpenKey(null)}>
                            Done
                          </button>
                        </>
                      ) : (
                        <TillLine
                          line={line}
                          shapes={shapesFor(line.productId)}
                          rules={rulesFor(line.productId, line.saleUnitId)}
                          total={(Number(line.qty) || 0) * (Number(line.unitPrice) || 0)}
                          belowCost={false}
                          onPatch={(next) => updateLine(line.key, next as Partial<DraftLine>)}
                          onRemove={() => removeLine(line.key)}
                          onStep={(direction) =>
                            updateLine(line.key, { qty: String(Math.max(0, (Number(line.qty) || 0) + direction)) })
                          }
                          onReprice={() => {}}
                          onOpen={() => setOpenKey(line.key)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* What was on it and is not now — one tap back on. */}
              {takenOff.length > 0 && (
                <section className={styles.off} aria-label="Taken off this receipt">
                  <h2 className={styles.sectionTitle}>Taken off</h2>
                  <ul className={styles.offList}>
                    {takenOff.map((o, i) => (
                      <li key={`${o.productId}-${o.saleUnitId}-${i}`} className={styles.offRow}>
                        <span className={styles.offWhat}>
                          <s>{o.productName}</s>
                          <span className={styles.offMeta}>
                            {formatQtySpoken(o.enteredQty)} {shapeWord(String(o.enteredQty), o.unitName ?? '').toLowerCase()} ·{' '}
                            {formatMoney(o.lineTotal)}
                          </span>
                        </span>
                        <Button size="small" variant="secondary" onClick={() => putBackLine(o)}>
                          Put back
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {emptied && (
                <InfoPanel tone="warning" title="Nothing left on this receipt">
                  Correcting it with no items cancels it. The stock goes back, the containers come off the
                  customer, and anything paid becomes credit to them.
                </InfoPanel>
              )}

              {/* ── The till's own box: "3 b/s", Enter, and the camera ─────────── */}
              <div className={styles.add}>
                <QuickAdd
                  storeId={store.id}
                  onAdd={(product, qty) => put({ id: product.id, name: product.name }, qty)}
                  onScan={() => setScanning(true)}
                />
                <button type="button" className={styles.browse} onClick={() => setPicking(true)}>
                  Browse all items
                </button>
              </div>

              {/* ── The empties that went out with it, and what came back ──────── */}
              {order.customerId && containerRows.length > 0 && (
                <section className={styles.empties} aria-label="Empties with this receipt">
                  <h2 className={styles.sectionTitle}>Empties with this receipt</h2>
                  <LoadArea area={before} what="its empties" compact>
                    {() => (
                      <ContainersBack
                        rows={containerRows}
                        onChange={(id, back) => patch({ emptiesBack: { ...(draft.emptiesBack ?? {}), [id]: back } })}
                      />
                    )}
                  </LoadArea>
                  <p className={styles.note}>Saved with the correction. A line sending out fewer can only have had that many of its own back.</p>
                </section>
              )}

              {was && (
                <div className={styles.totals}>
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
                  {Math.abs(total - was.total) > 0.005 && (
                    <div className={`${styles.totalRow} ${total > was.total ? styles.up : styles.down}`}>
                      <span>Difference</span>
                      <span>
                        {total > was.total ? '+' : '−'}
                        {formatMoney(Math.abs(total - was.total))}
                      </span>
                    </div>
                  )}
                  {(was.depositTaken ?? 0) > 0.005 && (
                    <div className={styles.totalRow}>
                      <span>
                        Deposit put down with it
                        {(was.depositUnpaid ?? 0) > 0.005 ? ` (${formatMoney(was.depositUnpaid ?? 0)} not paid)` : ''}
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

              <Explain label="What happens to the old copy?">
                The receipt keeps its number, so the link you sent the customer still works. What it said
                before is kept in full, and the new copy says it replaces the old one.
              </Explain>
            </>
          )
        }
      </PageState>

      {order && !emptied && (
        <FloatingAmount
          who={order.customerName || 'this receipt'}
          label="Correct payment"
          amount={formatMoney(total)}
          onClick={() => void nav.push('amend_payment_page', { id: saleId ?? '' })}
        />
      )}
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

      {finishedGuard.dialog}
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
