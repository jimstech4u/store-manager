'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './Receipt.module.css';
import { useNav } from '@academix-admin/navigation-stack';
import { Button } from '@/components/ui/Button';
import { WhatsAppIcon } from '@/components/ui/Icon';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { useDemandState } from '@academix-admin/state-stack';
import { getSupabase } from '@/lib/supabase/client';
import { formatDateTime, formatMoney, formatQty, pluralUnit, messageOf } from '@/lib/format';
import { renderReceiptCanvas, renderReceiptImage, shareImage, shareLink } from '@/lib/share';
import { receiptPdf, sharePdf } from '@/lib/pdf';
import { appUrl } from '@/lib/app-url';

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
  /** Named additions to the bill — transport, loading — each answerable on its own. */
  charges: { label: string; amount: string }[];
  /** What the customer still holds of the shop's, per pool, after this sale. */
  empties: { category: string; qty: string; held: string }[];
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
  /*
   * A settled receipt in state-stack, keyed by sale.
   *
   * A receipt is the most re-opened screen in the app and the most fixed: once a sale is settled
   * its lines, its total and the shop's own header can no longer change. Refetching all three from
   * scratch every time somebody taps back into it — from the statement, from the day's takings,
   * from a customer's history — put a blank rectangle in front of a customer who was handed a
   * phone to look at their receipt.
   *
   * Nothing invalidates this deliberately, and nothing needs to: the key is the sale id, and a
   * sale that gets voided is a different screen.
   */
  const [snapshot, demand] = useDemandState<{
    detail: SaleDetail | null;
    shopName: string;
    settings: { width: number; header: string | null; footer: string | null } | null;
    error: string | null;
  }>(
    { detail: null, shopName: '', settings: null, error: null },
    {
      key: `receipt:${saleId}`,
      scope: 'receipt_flow',
      persist: true,
      deps: [saleId, storeId],
      revalidateOnMount: false,
    },
  );

  // Readable from the loader without becoming a dependency of it.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const detail = snapshot.detail;
  const shopName = snapshot.shopName;
  const settings = snapshot.settings;
  const error = snapshot.error;

  const [sharing, setSharing] = useState(false);
  const nav = useNav();
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [sharingWhatsApp, setSharingWhatsApp] = useState(false);
  const [makingPdf, setMakingPdf] = useState(false);

  useEffect(() => {
    demand(async ({ set }) => {
      const supabase = getSupabase();
      try {
        const [{ data: d, error: dErr }, { data: s }, { data: store }] = await Promise.all([
          supabase.rpc('sale_detail', { p_sale_id: saleId }),
          supabase.rpc('ensure_store_settings', { p_store_id: storeId }),
          supabase.from('stores').select('name').eq('id', storeId).maybeSingle(),
        ]);
        if (dErr) throw dErr;

        const row = (Array.isArray(s) ? s[0] : s) as
          | { printer_width_mm: string; receipt_header: string | null; receipt_footer: string | null }
          | null;

        set(
          {
            detail: d as unknown as SaleDetail,
            shopName: (store as { name: string } | null)?.name ?? '',
            settings: {
              width: Number(row?.printer_width_mm ?? 80),
              header: row?.receipt_header ?? null,
              footer: row?.receipt_footer ?? null,
            },
            error: null,
          },
          { override: true },
        );
      } catch (e: unknown) {
        // A receipt that has already been read once stays readable. It cannot have changed —
        // it is a settled sale — so a failed re-read is a network problem, not a reason to take
        // the receipt off the screen of whoever is looking at it.
        set(
          {
            ...snapshotRef.current,
            error: snapshotRef.current.detail
              ? null
              : messageOf(e, 'Could not load the receipt'),
          },
          { override: true },
        );
      }
    });
  }, [saleId, storeId, demand]);

  if (error) {
    return <FullPageMessage title="Could not load the receipt" tone="error">{error}</FullPageMessage>;
  }
  if (!detail) {
    return <FullPageMessage title="Preparing the receipt" tone="loading" />;
  }

  const { sale, customer, lines, payments, charges, empties } = detail;
  const paid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const owing = Number(sale.total) - paid;
  const width = settings?.width ?? 80;
  // Below roughly 58mm there is not enough width for a two-column row, so the layout stacks.
  const narrow = width < 58;

  /**
   * What gets drawn, for the picture and the PDF alike.
   *
   * One definition on purpose: these two were about to be separate copies of the same twenty-line
   * object, and the moment a charge or a line of the header changed, one of them would have
   * silently kept the old shape.
   */
  const receiptPayload = () => ({
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
      // Every named charge on its own line, exactly as the printed page shows them. This used to
      // read `sale.fee_amount`, so a receipt shared as a picture or a PDF showed one lumped
      // "extra charge" while the paper itemised transport and loading separately — two documents
      // for one sale, disagreeing.
      ...(charges ?? []).map((c) => ({ label: c.label, value: formatMoney(c.amount) })),
      ...((charges ?? []).length === 0 && Number(sale.fee_amount) > 0
        ? [{ label: sale.fee_label || 'Extra charge', value: formatMoney(sale.fee_amount) }]
        : []),
      { label: 'Total', value: formatMoney(sale.total), strong: true },
      ...payments.map((p) => ({
        label: `Paid (${p.method})`,
        value: formatMoney(p.amount),
      })),
      ...(owing > 0 ? [{ label: 'Balance', value: formatMoney(owing), strong: true }] : []),
      // What the customer still holds of the shop's. The crates are the half of an account that
      // gets disputed, precisely because nobody has anything in writing about them.
      ...((empties ?? []).length > 0
        ? [{ label: 'Still with you', value: '', strong: true }]
        : []),
      ...(empties ?? []).map((e) => ({
        label: e.category,
        value: `${formatQty(e.qty)}${Number(e.held) > 0 ? ` (${formatMoney(e.held)} held)` : ''}`,
      })),
    ],
    note: sale.note,
    transferDetails: sale.transfer_details,
    });


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
          {/* Each charge on its own line. Summing them under one heading is exactly what makes
              a bill unanswerable when the customer asks about it a fortnight later. */}
          {(charges ?? []).map((c, i) => (
            <div className={styles.row} key={`${c.label}-${i}`}>
              <span>{c.label}</span>
              <span className={styles.value}>{formatMoney(c.amount)}</span>
            </div>
          ))}

          {/* An order started on an older build still carries its fee here and nowhere else. */}
          {(charges ?? []).length === 0 && Number(sale.fee_amount) > 0 && (
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

        {/*
          What the customer still has of ours, printed on the receipt itself.
          The money half of an account has always been printed and the containers never were — and
          the containers are the half that gets disputed, because nobody has anything in writing
          about them.
        */}
        {(empties ?? []).length > 0 && (
          <div className={styles.totals}>
            <div className={styles.row}>
              <span className={styles.emptiesHead}>Still with you</span>
            </div>
            {empties.map((e) => (
              <div className={styles.row} key={e.category}>
                <span>{e.category}</span>
                <span className={styles.value}>
                  {formatQty(e.qty)}
                  {Number(e.held) > 0 ? ` · ${formatMoney(e.held)} held` : ''}
                </span>
              </div>
            ))}
          </div>
        )}

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

              const url = appUrl(`/r/${token}`);
              const result = await shareLink(url, `Receipt from ${shopName}`);
              if (result === 'copied') setShareNote('Link copied. Paste it into a chat.');
            } catch (e: unknown) {
              setShareNote(messageOf(e, 'Could not create a link'));
            } finally {
              setSharing(false);
            }
          }}
        >
          Share receipt
        </Button>

        {/*
          The same link, sent to a phone.
          *
          * "Share receipt" hands it to whatever the device offers, which is right when the
          * customer is standing there. This is for when they are not — which is most regulars, and
          * is how a shop here actually reaches them.
          *
          * The number comes from the sale when it has one, and the next screen lets it be changed:
          * the customer on file is nearly always who it is going to, and the number on file is
          * nearly always the one that has moved on.
        */}
        <Button
          variant="secondary"
          fullWidth
          busy={sharingWhatsApp}
          busyLabel="Preparing"
          onClick={async () => {
            setSharingWhatsApp(true);
            setShareNote(null);
            try {
              const { data: token, error: err } = await getSupabase().rpc('create_share_link', {
                p_store_id: storeId,
                p_kind: 'receipt',
                p_ref_id: saleId,
              });
              if (err) throw err;

              const url = appUrl(`/r/${token}`);
              void nav.push('share_whatsapp_page', {
                message: `Your receipt from ${shopName}.\n${url}`,
                phone: detail?.customer?.phone ?? '',
                customerId: detail?.customer?.id ?? '',
                customerName: detail?.customer?.name ?? '',
              });
            } catch (e: unknown) {
              setShareNote(messageOf(e, 'Could not create a link'));
            } finally {
              setSharingWhatsApp(false);
            }
          }}
        >
          <WhatsAppIcon /> Send on WhatsApp
        </Button>

        <Button
          variant="secondary"
          fullWidth
          onClick={async () => {
            // An image previews inline in a chat, where a link is just text somebody has to
            // decide to tap.
            const blob = await renderReceiptImage(receiptPayload(), width);
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
          Print
        </Button>

        {/*
          A real PDF, not the browser's print-to-PDF.
          Most shops here have no thermal printer, and `window.print()` offers "Save as PDF" on a
          desktop and often nothing at all on a phone — so without this there was no way to hand a
          customer anything they could keep. A PDF goes on WhatsApp and prints later from anywhere.
        */}
        <Button
          variant="secondary"
          fullWidth
          busy={makingPdf}
          busyLabel="Preparing"
          onClick={async () => {
            setMakingPdf(true);
            setShareNote(null);
            try {
              const canvas = await renderReceiptCanvas(receiptPayload(), width);
              if (!canvas) throw new Error('Could not draw the receipt');
              const pdf = await receiptPdf(canvas, { widthMm: width });
              const where = await sharePdf(
                pdf,
                `receipt-${sale.id.slice(0, 8)}.pdf`,
                `Receipt from ${shopName}`,
              );
              if (where === 'downloaded') setShareNote('PDF saved to your downloads.');
            } catch (e: unknown) {
              setShareNote(messageOf(e, 'Could not make a PDF'));
            } finally {
              setMakingPdf(false);
            }
          }}
        >
          Save as PDF
        </Button>
      </div>
    </>
  );
}
