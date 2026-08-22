'use client';

import { use, useEffect, useState } from 'react';
import styles from './shared.module.css';
import { Button } from '@/components/ui/Button';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
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
    pack_name: string | null;
    unit_price: string;
    line_total: string;
  }[];
  payments: { amount: string; method: string; occurred_at: string }[];
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
  const [receipt, setReceipt] = useState<SharedReceipt | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await getSupabase().rpc('read_shared_receipt', {
          p_token: token,
        });
        if (cancelled) return;
        if (error) throw error;
        if (!data) {
          setState('missing');
          return;
        }
        setReceipt(data as unknown as SharedReceipt);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

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
  const paid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
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
                <span>
                  {formatQty(l.entered_qty)}{' '}
                  {l.pack_name ?? pluralUnit(l.base_unit, Number(l.entered_qty))} ×{' '}
                  {formatMoney(l.unit_price)}
                </span>
                <span className={styles.lineTotal}>{formatMoney(l.line_total)}</span>
              </div>
            </div>
          ))}
        </div>

        <div className={styles.totals}>
          {Number(sale.fee_amount) > 0 && (
            <div className={styles.row}>
              <span>{sale.fee_label || 'Extra charge'}</span>
              <span className={styles.value}>{formatMoney(sale.fee_amount)}</span>
            </div>
          )}

          <div className={`${styles.row} ${styles.grand}`}>
            <span>Total</span>
            <span className={styles.value}>{formatMoney(sale.total)}</span>
          </div>

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
