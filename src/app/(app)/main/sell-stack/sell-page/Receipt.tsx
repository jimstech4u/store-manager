'use client';

import { useEffect, useState } from 'react';
import styles from './Receipt.module.css';
import { Button } from '@/components/ui/Button';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { getSupabase } from '@/lib/supabase/client';
import { formatDateTime, formatMoney, formatQty, pluralUnit } from '@/lib/format';
import { renderReceiptImage, shareImage, shareLink } from '@/lib/share';

interface SaleDetail {
  sale: {
    id: string;
    occurred_at: string;
    total: string;
    fee_amount: string;
    fee_label: string | null;
    note: string | null;
    transfer_details: string | null;
  };
  customer: { id: string; name: string; phone: string; balance: string } | null;
  lines: {
    id: string;
    product_name: string;
    base_unit: string;
    entered_qty: string;
    pack_name: string | null;
    base_qty: string;
    unit_price: string;
    line_total: string;
  }[];
  payments: { id: string; amount: string; method: string; reference: string | null }[];
}

/**
 * The printable receipt.
 *
 * Fetched through `sale_detail`, which returns the sale, its lines, its payments and the customer
 * in one call. Assembling this from four client queries would render the header before the lines
 * on a slow connection, which reads as a broken receipt at exactly the moment a customer is
 * looking at it.
 *
 * The print width comes from the store's setting as a CSS custom property, so an unusual printer
 * gets its real width rather than the nearest preset.
 */
export function Receipt({ saleId, storeId }: { saleId: string; storeId: string }) {
  const [detail, setDetail] = useState<SaleDetail | null>(null);
  const [shopName, setShopName] = useState('');
  const [settings, setSettings] = useState<{
    width: number;
    header: string | null;
    footer: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = getSupabase();

    void (async () => {
      try {
        const [{ data: d, error: dErr }, { data: s }, { data: store }] = await Promise.all([
          supabase.rpc('sale_detail', { p_sale_id: saleId }),
          supabase.rpc('ensure_store_settings', { p_store_id: storeId }),
          supabase.from('stores').select('name').eq('id', storeId).maybeSingle(),
        ]);
        if (dErr) throw dErr;
        if (cancelled) return;

        setDetail(d as unknown as SaleDetail);
        setShopName((store as { name: string } | null)?.name ?? '');

        const row = (Array.isArray(s) ? s[0] : s) as
          | { printer_width_mm: string; receipt_header: string | null; receipt_footer: string | null }
          | null;
        setSettings({
          width: Number(row?.printer_width_mm ?? 80),
          header: row?.receipt_header ?? null,
          footer: row?.receipt_footer ?? null,
        });
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the receipt');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [saleId, storeId]);

  if (error) {
    return <FullPageMessage title="Could not load the receipt" tone="error">{error}</FullPageMessage>;
  }
  if (!detail) {
    return <FullPageMessage title="Preparing the receipt" tone="loading" />;
  }

  const { sale, customer, lines, payments } = detail;
  const paid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const owing = Number(sale.total) - paid;
  const width = settings?.width ?? 80;
  // Below roughly 58mm there is not enough width for a two-column row, so the layout stacks.
  const narrow = width < 58;

  return (
    <>
      <div
        className={styles.receipt}
        // data-print-root is what the global print rules reveal; --receipt-width drives
        // both the @page size and the printed width. See globals.css.
        data-print-root
        style={{ ['--receipt-width' as string]: `${width}mm` }}
      >
        <div className={styles.head}>
          <p className={styles.shop}>{shopName}</p>
          {settings?.header && <p className={styles.headLine}>{settings.header}</p>}
        </div>

        <div className={styles.meta}>
          <span>{formatDateTime(sale.occurred_at)}</span>
          <span>#{sale.id.slice(0, 8).toUpperCase()}</span>
        </div>

        {customer && (
          <div className={styles.meta}>
            <span>{customer.name}</span>
            <span>{customer.phone}</span>
          </div>
        )}

        <div className={styles.lines}>
          {lines.map((l) => (
            <div className={styles.line} key={l.id}>
              <p className={styles.lineName}>{l.product_name}</p>
              <div className={styles.lineDetail} style={narrow ? { display: 'block' } : undefined}>
                <span>
                  {formatQty(l.entered_qty)}{' '}
                  {l.pack_name ?? pluralUnit(l.base_unit, Number(l.entered_qty))}
                  {' × '}
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

          {payments.map((p) => (
            <div className={styles.row} key={p.id}>
              <span>
                Paid ({p.method}
                {p.reference ? ` ${p.reference}` : ''})
              </span>
              <span className={styles.value}>{formatMoney(p.amount)}</span>
            </div>
          ))}

          {owing > 0 && (
            <div className={styles.row}>
              <span>Balance</span>
              <span className={styles.value}>{formatMoney(owing)}</span>
            </div>
          )}

          {customer && Number(customer.balance) > 0 && (
            <div className={styles.row}>
              <span>Total owed</span>
              <span className={styles.value}>{formatMoney(customer.balance)}</span>
            </div>
          )}
        </div>

        {sale.note && <p className={styles.foot}>{sale.note}</p>}

        {/* The account snapshot taken when the sale was recorded — so reprinting an old receipt
            shows the account it was issued with, even if the shop has since changed banks. */}
        {sale.transfer_details && <div className={styles.transfer}>{sale.transfer_details}</div>}

        {settings?.footer && <p className={styles.foot}>{settings.footer}</p>}
      </div>

      {shareNote && (
        <p className={styles.shareNote} role="status">
          {shareNote}
        </p>
      )}

      <div className={styles.actions} data-print-no-print>
        <Button
          fullWidth
          busy={sharing}
          busyLabel="Preparing"
          onClick={async () => {
            setSharing(true);
            setShareNote(null);
            try {
              // A link first: it opens anywhere, needs no download, and lets the recipient
              // print or save their own PDF.
              const { data: token, error: err } = await getSupabase().rpc('create_share_link', {
                p_store_id: storeId,
                p_kind: 'receipt',
                p_ref_id: saleId,
              });
              if (err) throw err;

              const url = `${window.location.origin}/r/${token}`;
              const result = await shareLink(url, `Receipt from ${shopName}`);
              if (result === 'copied') setShareNote('Link copied. Paste it into a chat.');
            } catch (e: unknown) {
              setShareNote(e instanceof Error ? e.message : 'Could not create a link');
            } finally {
              setSharing(false);
            }
          }}
        >
          Share receipt
        </Button>

        <Button
          variant="secondary"
          fullWidth
          onClick={async () => {
            // An image previews inline in a chat, where a link is just text somebody has to
            // decide to tap.
            const blob = await renderReceiptImage(
              {
                shopName,
                header: settings?.header,
                footer: settings?.footer,
                meta: [
                  formatDateTime(sale.occurred_at),
                  `#${sale.id.slice(0, 8).toUpperCase()}`,
                  ...(customer ? [customer.name] : []),
                ],
                lines: lines.map((l) => ({
                  name: l.product_name,
                  detail: `${formatQty(l.entered_qty)} ${
                    l.pack_name ?? pluralUnit(l.base_unit, Number(l.entered_qty))
                  } x ${formatMoney(l.unit_price)}`,
                  amount: formatMoney(l.line_total),
                })),
                totals: [
                  ...(Number(sale.fee_amount) > 0
                    ? [{ label: sale.fee_label || 'Extra charge', value: formatMoney(sale.fee_amount) }]
                    : []),
                  { label: 'Total', value: formatMoney(sale.total), strong: true },
                  ...payments.map((p) => ({
                    label: `Paid (${p.method})`,
                    value: formatMoney(p.amount),
                  })),
                  ...(owing > 0 ? [{ label: 'Balance', value: formatMoney(owing), strong: true }] : []),
                ],
                note: sale.note,
                transferDetails: sale.transfer_details,
              },
              width,
            );
            if (!blob) {
              setShareNote('Could not create the image');
              return;
            }
            const result = await shareImage(
              blob,
              `receipt-${sale.id.slice(0, 8)}.png`,
              `Receipt from ${shopName}`,
            );
            if (result === 'downloaded') setShareNote('Saved to your downloads.');
          }}
        >
          Send as picture
        </Button>

        <Button variant="secondary" fullWidth onClick={() => window.print()}>
          Print / PDF
        </Button>
      </div>
    </>
  );
}
