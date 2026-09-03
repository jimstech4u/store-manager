'use client';

import { use, useEffect, useState } from 'react';
import styles from './shared.module.css';
import { Button } from '@/components/ui/Button';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { useDemandState } from '@academix-admin/state-stack';
import { getSupabase } from '@/lib/supabase/client';
import { formatDateTime, formatMoney, formatQty, pluralUnit } from '@/lib/format';

interface SharedReceipt {
  shop: {
    name: string;
    header: string | null;
    footer: string | null;
    printer_width_mm: string;
  };
  sale: {
    id: string;
    occurred_at: string;
    total: string;
    fee_amount: string;
    fee_label: string | null;
    note: string | null;
    transfer_details: string | null;
  };
  customer: { name: string } | null;
  lines: {
    id: string;
    product_name: string;
    base_unit: string;
    entered_qty: string;
    /** The shape it was sold in, already pluralised by the shop's own word for it. */
    unit_name: string | null;
    unit_price: string;
    line_total: string;
    containers_out: string;
    deposit: string;
  }[];
  /** Every extra billed, by name — "what was this ₦2,000 for?" is asked weeks later. */
  charges: { label: string; amount: string; note: string | null }[];
  /** Money held against containers. Not payment for anything: it comes back when they do. */
  deposit_total: string;
  /** What is still out, grouped the way a shop counts it — by category, not by brand. */
  empties: { category: string; qty: string; deposit: string }[];
  /** Grouped by method, because that is what somebody checks against their own record. */
  payments: { amount: string; method: string }[];
  paid_total: string;
}

/**
 * A shared receipt, opened from a link.
 *
 * Public: no sign-in, because the point is that it works for someone who does not use this
 * software and never will. What they get is deliberately narrower than what staff see — no
 * costs, no margin, no running balance. A receipt handed to a customer is not a window into the
 * shop's buying prices.
 *
 * Unknown, revoked and expired tokens all produce the same message, so the page cannot be used
 * to work out whether a token ever existed.
 */
export default function SharedReceiptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  /*
   * KEPT, because a receipt does not change and the people opening this have the worst
   * connections in the product.
   *
   * It was held in `useState`, so every visit to a link somebody had already opened went back to
   * the network and showed "Opening receipt" while it did — for a document that was finished the
   * moment it was created. Filed under the token, so one customer's receipt can never be shown
   * under another's link.
   */
  const [receipt, demandReceipt] = useDemandState<SharedReceipt | null>(null, {
    key: `shared-receipt:${token}`,
    scope: 'public_receipt',
    persist: true,
    deps: [token],
    revalidateOnMount: false,
  });

  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>(
    // A receipt already on this device is shown at once; there is nothing to wait for.
    receipt ? 'ready' : 'loading',
  );

  useEffect(() => {
    let cancelled = false;
    void demandReceipt(async ({ set }) => {
      try {
        const { data, error } = await getSupabase().rpc('read_shared_receipt', {
          p_token: token,
        });
        if (cancelled) return;
        if (error) throw error;
        if (!data) {
          // Only when there was nothing to show anyway. A link that has since been revoked should
          // not blank a receipt the customer is looking at.
          setState((prev) => (prev === 'ready' ? prev : 'missing'));
          return;
        }
        set(data as unknown as SharedReceipt);
        setState('ready');
      } catch {
        if (!cancelled) setState((prev) => (prev === 'ready' ? prev : 'error'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token, demandReceipt]);

  if (state === 'loading') {
    return <FullPageMessage title="Opening receipt" tone="loading" />;
  }

  if (state === 'missing') {
    return (
      <FullPageMessage title="This receipt is not available" tone="empty">
        The link may have expired, or the shop may have withdrawn it. Ask them to send a new one.
      </FullPageMessage>
    );
  }

  if (state === 'error' || !receipt) {
    return (
      <FullPageMessage title="Could not open this receipt" tone="error">
        Check your connection and try again.
      </FullPageMessage>
    );
  }

  const { shop, sale, customer, lines, payments } = receipt;
  const charges = receipt.charges ?? [];
  const empties = receipt.empties ?? [];
  const depositHeld = Number(receipt.deposit_total ?? 0);
  /*
   * The server's figure, not a sum of what this page happened to be sent.
   *
   * Adding up the payments on the page meant the receipt and the shop's books could disagree the
   * moment the two lists differed for any reason — a payment allocated elsewhere, a rounding, a
   * partial. `paid_total` is computed from the allocations by the same query that lists them.
   */
  const paid = Number(receipt.paid_total ?? 0);
  const owing = Number(sale.total) - paid;
  const width = Number(shop.printer_width_mm) || 80;
  const narrow = width < 58;

  return (
    <div className={styles.page}>
      <div
        className={styles.receipt}
        data-print-root
        style={{ ['--receipt-width' as string]: `${width}mm` }}
      >
        <div className={styles.head}>
          <p className={styles.shop}>{shop.name}</p>
          {shop.header && <p className={styles.headLine}>{shop.header}</p>}
        </div>

        <div className={styles.meta}>
          <span>{formatDateTime(sale.occurred_at)}</span>
          <span>#{sale.id.slice(0, 8).toUpperCase()}</span>
        </div>

        {customer && (
          <div className={styles.meta}>
            <span>{customer.name}</span>
          </div>
        )}

        <div className={styles.lines}>
          {lines.map((l) => (
            <div className={styles.line} key={l.id}>
              <p className={styles.lineName}>{l.product_name}</p>
              <div className={styles.lineDetail} style={narrow ? { display: 'block' } : undefined}>
                {/*
                  THE SHAPE, as the seller said it.

                  `pack_name` came from `product_packs`, the one-pack-per-product model 0061
                  replaced. A shop that defined its shapes on this software has no pack, so this
                  fell through to the base unit and a customer who bought three crates was handed
                  a receipt for thirty-six pieces.
                */}
                <span>
                  {formatQty(l.entered_qty)}{' '}
                  {l.unit_name ?? pluralUnit(l.base_unit, Number(l.entered_qty))} ×{' '}
                  {formatMoney(l.unit_price)}
                </span>
                <span className={styles.lineTotal}>{formatMoney(l.line_total)}</span>
              </div>
            </div>
          ))}
        </div>

        <div className={styles.totals}>
          {/*
            EVERY CHARGE, BY NAME.

            The receipt showed one `fee_amount` under whatever label the till happened to carry, so
            a bill with a delivery fee AND a loading charge showed one of them and quietly added
            the other to the total. `sale_charges` has held them separately since 0042; this page
            had never read it.

            The order-level fee is written into `sale_charges` too (0074), so listing both would
            bill the customer twice on paper. The named list wins where there is one.
          */}
          {charges.length > 0
            ? charges.map((c, i) => (
                <div className={styles.row} key={i}>
                  <span>
                    {c.label}
                    {c.note ? ` — ${c.note}` : ''}
                  </span>
                  <span className={styles.value}>{formatMoney(c.amount)}</span>
                </div>
              ))
            : Number(sale.fee_amount) > 0 && (
                <div className={styles.row}>
                  <span>{sale.fee_label || 'Extra charge'}</span>
                  <span className={styles.value}>{formatMoney(sale.fee_amount)}</span>
                </div>
              )}

          {/*
            THE DEPOSIT, said as its own line.

            It is inside the total the customer paid, and it is not payment for anything — it comes
            back when the containers do. Folded into the total and named nowhere, the receipt read
            as though the drinks cost that much more, and the customer had nothing in writing
            saying the shop owes it.
          */}
          {depositHeld > 0 && (
            <div className={styles.row}>
              <span>Deposit on containers</span>
              <span className={styles.value}>{formatMoney(depositHeld)}</span>
            </div>
          )}

          <div className={`${styles.row} ${styles.grand}`}>
            <span>Total</span>
            <span className={styles.value}>{formatMoney(sale.total)}</span>
          </div>

          {/* Grouped by method by the reader: "Cash ₦20,000, Transfer ₦9,950" is what somebody
              checks against their own record, rather than nine rows of the same word. */}
          {payments.map((p, i) => (
            <div className={styles.row} key={i}>
              <span>Paid ({p.method})</span>
              <span className={styles.value}>{formatMoney(p.amount)}</span>
            </div>
          ))}

          {owing > 0 && (
            <div className={`${styles.row} ${styles.owing}`}>
              <span>Balance</span>
              <span className={styles.value}>{formatMoney(owing)}</span>
            </div>
          )}
        </div>

        {/*
          WHAT THE CUSTOMER IS HOLDING.

          Grouped the way a shop counts it — two Gulder and two Star are four NBL crates, because
          that is what goes on the pallet. Netted, so somebody who has already brought some back
          sees what is left rather than the number they originally left with, and the deposit
          against it only where one was actually taken: containers sent out on trust are still owed
          back, and saying "₦0 held" beside them reads like nothing is owed at all.
        */}
        {empties.length > 0 && (
          <div className={styles.totals}>
            <div className={styles.row}>
              <span className={styles.emptiesHead}>Still to come back</span>
            </div>
            {empties.map((e, i) => (
              <div className={styles.row} key={i}>
                <span>
                  {formatQty(e.qty)} {e.category}
                </span>
                {Number(e.deposit) > 0 && (
                  <span className={styles.value}>{formatMoney(e.deposit)} held</span>
                )}
              </div>
            ))}
          </div>
        )}

        {sale.note && <p className={styles.foot}>{sale.note}</p>}
        {sale.transfer_details && <div className={styles.transfer}>{sale.transfer_details}</div>}
        {shop.footer && <p className={styles.foot}>{shop.footer}</p>}
      </div>

      <div className={styles.actions} data-print-no-print>
        <Button variant="secondary" fullWidth onClick={() => window.print()}>
          Save as PDF or print
        </Button>
      </div>
    </div>
  );
}
