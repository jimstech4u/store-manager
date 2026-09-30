'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { PrintPreview } from '@/components/settings/PrintPreview';
import { orderShareMessage, orderTrackLink } from '@/components/sell/ShareOrder';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useResource } from '@/lib/stacks/resource';
import {
  chargesTotal,
  depositTotal,
  draftSubtotal,
  draftTotal,
  lineTotal,
  useDraftOrders,
  orderById,
} from '@/lib/stacks/draft-orders';
import { useUncountedToday } from '@/lib/stacks/count-gate';
import { useUnpricedOnSale } from '@/lib/stacks/price-gate';
import { useThisPrinter } from '@/lib/stacks/printer';
import { receiptLines } from '@/lib/escpos-text';
import type { ReceiptImageInput } from '@/lib/share';
import { swapTo } from '@/lib/finish-flow';
import { DocumentActions } from '@/components/ui/DocumentActions';
import { CashIcon } from '@/components/ui/Icon';
import { getSupabase } from '@/lib/supabase/client';
import { ChargesEditor, DepositEditor } from '@/components/sell/OrderExtras';
import { ACCOUNT_DERIVED_SCOPE } from '@/lib/stacks/customer-account';
import { LEDGERS_SCOPE, depositLedger, type DepositMove } from '@/lib/stacks/customer-ledgers';
import { owedRowsFromReceipt, rollUpOwed } from '@/lib/empties-rollup';
import { formatDateTime, formatMoney, formatQtySpoken } from '@/lib/format';
import styles from './order-items-page.module.css';

/**
 * ALL ITEMS — what is on an open order, on its own, before anything is paid.
 *
 * "There is a way we should be able to see just the items alone before we even settle it … a
 * header for the track code and items and a large indicator this is not a receipt, and all items
 * there and amount."
 *
 * A customer on the phone asks what they have been charged for; a driver wants a list to load
 * against; a customer wants it on WhatsApp to check before they pay. None of those is a receipt, and
 * the one thing this page must never be mistaken for is one — so it says NOT A RECEIPT on the
 * screen, on the paper and in the PDF, and it carries the order's tracking link rather than a
 * receipt's.
 *
 * AN ID IS PASSED IN, and the order is read from `useDraftOrders` — the same working state the till
 * writes — so what is shown is what is on the order now, not a copy from the moment of the tap.
 */
export default function OrderItemsPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const wantedId = (location?.params?.id as string | undefined) ?? null;

  const { orders, activeOrder: current, push, syncing, updateOrder } = useDraftOrders(
    store?.id ?? null,
  );
  // By id first; the active tab only when no id travelled with the push.
  const order = wantedId ? orderById(orders, wantedId) : current;

  /*
   * THE CODE AND THE LINK EXIST ONCE THE SHOP HAS THE ORDER. A tab opened a second ago may not have
   * been saved yet, so it is saved once here — the same push "Take payment" makes.
   */
  const saving = useRef(false);
  useEffect(() => {
    if (!order || order.code || order.lines.length === 0 || saving.current) return;
    saving.current = true;
    void push(order).finally(() => {
      saving.current = false;
    });
  }, [order, push]);

  /* The shop's roll width and letterhead — what the receipt prints with. */
  const settings = useResource<{ width: number; header: string | null }>({
    key: `print-settings:${store?.id ?? 'none'}`,
    scope: 'store_settings',
    enabled: Boolean(store),
    read: async () => {
      const { data, error } = await getSupabase().rpc('ensure_store_settings', {
        p_store_id: store?.id,
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as
        | { printer_width_mm: string; receipt_header: string | null }
        | null;
      return {
        width: Number(row?.printer_width_mm ?? 80) || 80,
        header: row?.receipt_header ?? null,
      };
    },
  });
  const width = settings.data?.width ?? 80;
  const printer = useThisPrinter(store?.id ?? null, width);

  /* SHARING SENDS THE CUSTOMER A PRICE, so the till's two gates stand in front of it. */
  const { uncounted } = useUncountedToday(
    store?.id ?? null,
    (order?.lines ?? []).map((l) => l.productId),
  );
  const { unpriced } = useUnpricedOnSale(store?.id ?? null, order?.lines);

  const [busy, setBusy] = useState<'pay' | null>(null);

  /*
   * WHAT ELSE GOES ON THE LIST — the customer sees the bill as it will be, and changes it now rather
   * than having the receipt corrected afterwards.
   *
   * Balance and "still with you" are what the paper SHOWS (the order is untouched). Charges and a
   * deposit are what the order CARRIES: the same forms Take payment uses, writing the same rows it
   * settles, so ticking one off here takes it off the bill. Each is on the screen, the paper, the
   * PDF and every share, because they all draw `input()` below.
   */
  const [showBalance, setShowBalance] = useState(false);
  const [showEmpties, setShowEmpties] = useState(false);
  const [chargesOpen, setChargesOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const customerId = order?.customerId ?? null;

  /* What they owe already — the same cached read Take payment makes. */
  const balance = useResource<number>({
    key: `balance:${customerId ?? 'none'}`,
    scope: ACCOUNT_DERIVED_SCOPE,
    enabled: Boolean(customerId) && showBalance,
    read: async () => {
      const { data, error } = await getSupabase().rpc('customer_balance_total', {
        p_store_customer_id: customerId,
      });
      if (error) throw error;
      return Number(data ?? 0);
    },
  });

  /* What the shop already holds of theirs, said beside a new deposit because the two add up. */
  const heldLedger = useResource<DepositMove[]>({
    key: `area:deposit-ledger:${customerId ?? 'none'}`,
    scope: LEDGERS_SCOPE,
    enabled: Boolean(customerId) && (depositOpen || (order?.deposits ?? []).length > 0),
    read: () => depositLedger(customerId!),
  });
  const alreadyHeld =
    heldLedger.data && heldLedger.data.length > 0 ? heldLedger.data[0].running : 0;

  /*
   * STILL WITH YOU, as the receipt will say it: what they hold now plus what this order sends out
   * (0241 — the server's own rule for both), rolled up by the receipt's own `rollUpOwed`.
   */
  const emptyLines = useMemo(
    () =>
      (order?.lines ?? [])
        .filter((l) => l.saleUnitId && Number(l.qty) > 0)
        .map((l) => ({ product_id: l.productId, sale_unit_id: l.saleUnitId, qty: Number(l.qty) })),
    [order?.lines],
  );
  const empties = useResource<unknown[]>({
    key: `order-empties:${order?.clientUuid ?? 'none'}:${customerId ?? 'none'}:${JSON.stringify(emptyLines)}`,
    scope: LEDGERS_SCOPE,
    enabled: Boolean(store && order) && showEmpties,
    read: async () => {
      const { data, error } = await getSupabase().rpc('order_empties_preview', {
        p_store_id: store?.id,
        p_customer_id: customerId,
        p_lines: emptyLines,
      });
      if (error) throw error;
      return (data ?? []) as unknown[];
    },
  });
  const stillWithYou = useMemo(
    () =>
      showEmpties && empties.data
        ? rollUpOwed(owedRowsFromReceipt(empties.data)).filter((l) => l.side === 'they_hold')
        : [],
    [showEmpties, empties.data],
  );

  if (!store) return null;

  const status: PageStatus = order
    ? { state: 'ready' }
    : syncing || (wantedId && orders.length === 0)
      ? { state: 'loading', what: 'this order' }
      : {
          state: 'empty',
          title: 'This order is no longer open',
          body: 'It was settled or closed. Its receipt is under Sales.',
        };

  /*
   * THEIR ACCOUNT BESIDE THE BILL, when asked for. Nothing is paid on this list, so "owed in all" is what
   * clears everything if they pay today: what they owed plus what this comes to — or, when the shop
   * owes THEM, what is left after their credit.
   */
  const balanceRows = (): { label: string; value: string; strong?: boolean }[] => {
    if (!order || !showBalance || !customerId || balance.data == null) return [];
    const owed = balance.data;
    const comes = draftTotal(order);
    if (owed > 0.005) {
      return [
        { label: 'Owed before', value: formatMoney(owed) },
        { label: 'Owed in all', value: formatMoney(owed + comes), strong: true },
      ];
    }
    if (owed < -0.005) {
      return [
        { label: 'Your credit', value: formatMoney(-owed) },
        { label: 'After your credit', value: formatMoney(Math.max(0, comes + owed)), strong: true },
      ];
    }
    return [{ label: 'Owed before', value: 'Nothing' }];
  };

  /** The document, once — the screen, the paper and the PDF all draw these lines. */
  const input = (): ReceiptImageInput | null => {
    if (!order) return null;
    const items = draftSubtotal(order);
    const charges = chargesTotal(order);
    const held = depositTotal(order);
    const fee = Number(order.feeAmount) || 0;
    return {
      shopName: store.name,
      banner: 'NOT A RECEIPT',
      header: ['Items on this order - nothing paid yet', settings.data?.header]
        .filter(Boolean)
        .join('. '),
      footer: 'This is a list of items, not a receipt. A receipt is given when it is paid for.',
      meta: [
        formatDateTime(new Date().toISOString()),
        ...(order.code ? [`Order ${order.code}`] : []),
        ...(order.customerName.trim() ? [order.customerName.trim()] : []),
      ],
      lines: order.lines.map((l) => {
        const qty = `${formatQtySpoken(l.qty || '0')}${l.saleUnitName ? ` ${l.saleUnitName}` : ''}`;
        return {
          name: l.productName,
          detail: `${qty} x ${formatMoney(Number(l.unitPrice) || 0)}`,
          qty,
          amount: formatMoney(lineTotal(l)),
        };
      }),
      totals: [
        ...(charges + held + fee > 0.005 ? [{ label: 'Items', value: formatMoney(items) }] : []),
        ...(order.charges ?? [])
          .filter((c) => Number(c.amount) > 0)
          .map((c) => ({ label: c.label || 'Charge', value: formatMoney(Number(c.amount)) })),
        ...(fee > 0 ? [{ label: order.feeLabel || 'Extra charge', value: formatMoney(fee) }] : []),
        ...(held > 0.005 ? [{ label: 'Deposit on containers', value: formatMoney(held) }] : []),
        { label: 'Comes to', value: formatMoney(draftTotal(order)), strong: true },
        ...balanceRows(),
        ...(showEmpties && empties.data
          ? stillWithYou.length > 0
            ? [
                { label: 'Still with you', value: '', strong: true },
                ...stillWithYou.map((e) => ({
                  label: `${e.label} ${e.unit.toLowerCase()}`,
                  value: e.said,
                })),
              ]
            : [{ label: 'Still with you', value: 'None' }]
          : []),
      ],
      note: order.note || null,
    };
  };

  const doc = input();
  const lines = doc ? receiptLines(doc, printer.layout) : [];
  const filename = `items-${order?.code ?? 'order'}`;
  const title = `Items at ${store.name}`;

  /** The till's gates, before anything with a price on it leaves the shop. */
  const gated = () => {
    if (uncounted.length > 0) {
      void nav.push('count_gate_page', { why: 'share' });
      return true;
    }
    if (unpriced.length > 0) {
      void nav.push('price_gate_page', { why: 'share' });
      return true;
    }
    return false;
  };

  const link = order?.code ? orderTrackLink(order.code, order.shareToken ?? null) : null;
  const message = link && order ? orderShareMessage(store.name, link, formatMoney(draftTotal(order))) : '';

  return (
    <PageScaffold onBack={goBack} title="All items" subtitle={order?.customerName || 'This order'}>
      <PageState status={status}>
        {() =>
          order && doc && (
            <>
              {/* SAID LARGE, before anything else on the page. */}
              <div className={styles.banner} role="note">
                <strong className={styles.bannerHead}>Not a receipt</strong>
                <span className={styles.bannerBody}>
                  {order.lines.length} {order.lines.length === 1 ? 'item' : 'items'} on order{' '}
                  {order.code ?? '…'} · comes to {formatMoney(draftTotal(order))} · nothing paid yet
                </span>
              </div>

              <section
                className={styles.extras}
                data-print-no-print
                aria-label="What goes on this list"
              >
                {customerId && (
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={showBalance}
                      onChange={(e) => setShowBalance(e.target.checked)}
                    />
                    <span>
                      Their balance
                      {showBalance && balance.data == null && (
                        <span className={styles.checkNote}>
                          {balance.error ? ' (could not be read)' : ' (checking)'}
                        </span>
                      )}
                    </span>
                  </label>
                )}

                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={chargesOpen || (order.charges ?? []).length > 0}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setChargesOpen(true);
                      } else {
                        // Off the list is off the bill.
                        updateOrder(order.clientUuid, { charges: [] });
                        setChargesOpen(false);
                      }
                    }}
                  />
                  <span>Charges</span>
                </label>
                {(chargesOpen || (order.charges ?? []).length > 0) && (
                  <ChargesEditor
                    charges={order.charges ?? []}
                    onChange={(charges) => updateOrder(order.clientUuid, { charges })}
                    listed
                    collapsed={!chargesOpen}
                    onExpand={() => setChargesOpen(true)}
                    onCancel={() => setChargesOpen(false)}
                  />
                )}

                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={depositOpen || (order.deposits ?? []).length > 0}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setDepositOpen(true);
                      } else {
                        updateOrder(order.clientUuid, { deposits: [] });
                        setDepositOpen(false);
                      }
                    }}
                  />
                  <span>Deposit</span>
                </label>
                {(depositOpen || (order.deposits ?? []).length > 0) && (
                  <>
                    <DepositEditor
                      deposits={order.deposits ?? []}
                      onChange={(deposits) => updateOrder(order.clientUuid, { deposits })}
                      alreadyHeld={alreadyHeld}
                      listed
                      collapsed={!depositOpen}
                      onExpand={() => setDepositOpen(true)}
                      onCancel={() => setDepositOpen(false)}
                    />
                    {!customerId && (
                      <p className={styles.checkNote}>
                        A deposit is held for somebody: add a customer before it is paid.
                      </p>
                    )}
                  </>
                )}

                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={showEmpties}
                    onChange={(e) => setShowEmpties(e.target.checked)}
                  />
                  <span>
                    Still with you (empties)
                    {showEmpties && empties.data == null && (
                      <span className={styles.checkNote}>
                        {empties.error ? ' (could not be read)' : ' (checking)'}
                      </span>
                    )}
                  </span>
                </label>
              </section>

              {order.lines.length === 0 ? (
                <p className={styles.empty}>Nothing is on this order yet.</p>
              ) : (
                <div
                  className={styles.paper}
                  data-print-root
                  style={{ ['--receipt-width' as string]: `${width}mm` }}
                >
                  <PrintPreview lines={lines} layout={printer.layout} />
                </div>
              )}

              {order.lines.length > 0 && (
                <div className={styles.actions} data-print-no-print>
                  {/*
                    ON TO PAYMENT, from the list the customer just agreed to. This page is swapped
                    for Take payment — popped, not left underneath — so Back from the payment goes
                    to the till, never back to a list of items. The till's gates first, as the pay
                    button does: an uncounted or unpriced item is dealt with before money is.
                  */}
                  <Button
                    fullWidth
                    busy={busy === 'pay'}
                    busyLabel="Opening"
                    onClick={async () => {
                      if (uncounted.length > 0) {
                        void nav.push('count_gate_page', { why: 'pay' });
                        return;
                      }
                      if (unpriced.length > 0) {
                        void nav.push('price_gate_page', { why: 'pay' });
                        return;
                      }
                      setBusy('pay');
                      try {
                        const saved = await push(order);
                        await swapTo(nav, 'take_payment_page', { id: saved.id ?? order.id ?? '' });
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    <CashIcon /> Take payment · {formatMoney(draftTotal(order))}
                  </Button>

                  {/*
                    EVERYTHING A RECEIPT CAN DO — share (with the tracking link), WhatsApp, a picture,
                    print, PDF — through the one component every document uses. The till's gates
                    still stand in front of anything with a price on it leaving the shop.
                  */}
                  {uncounted.length > 0 || unpriced.length > 0 ? (
                    <InfoPanel tone="warning" title="Before this goes to the customer">
                      {uncounted.length > 0
                        ? 'Some items here have not been counted today.'
                        : 'Some items here have no price yet.'}{' '}
                      <Button size="small" onClick={() => void gated()}>
                        {uncounted.length > 0 ? 'Count them' : 'Price them'}
                      </Button>
                    </InfoPanel>
                  ) : (
                    <DocumentActions
                      storeId={store.id}
                      doc={doc}
                      filename={filename}
                      title={title}
                      message={message || `${title}: ${formatMoney(draftTotal(order))}`}
                      whatsapp={{
                        phone: order.customerPhone,
                        customerId: order.customerId,
                        customerName: order.customerName,
                      }}
                    />
                  )}

                  {!link && (
                    <p className={styles.note}>Saving the order so it has a code to share…</p>
                  )}
                </div>
              )}
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
