'use client';

import { useMemo, useState } from 'react';
import { useLocation } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { DocumentActions } from '@/components/ui/DocumentActions';
import { PrintPreview } from '@/components/settings/PrintPreview';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useMergeableReceipts, useMergedReceipts } from '@/lib/stacks/merged-receipts';
import { usePrintSettings } from '@/lib/stacks/print-settings';
import { useThisPrinter } from '@/lib/stacks/printer';
import { receiptLines } from '@/lib/escpos-text';
import { formatDateTime, formatMoney } from '@/lib/format';
import { receiptDocument } from '../sell-page/Receipt';
import styles from './combine-page.module.css';

/**
 * RECEIPTS PUT TOGETHER — one customer's receipts, printed and shared as one. A VIEW: nothing is
 * written, every receipt stays exactly as it was recorded. (Route key `combine_page`, kept because a
 * route is its position.)
 *
 * "Same customer's sales merged into one whole sale: one receipt had 20 Bigi, the other 5, it is 25
 * Bigi — the same for the other products — then the balance only once, with the charges, still with
 * you and all the money and outstanding. A different customer is not allowed."
 *
 * Reached from a receipt (`id`), which arrives ticked; receipts that still owe are listed first.
 * Under the list, the receipt they make together, as it will print, with what a receipt offers.
 */
export default function CombinePage() {
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const saleId = (location?.params?.id as string | undefined) ?? null;

  const receipts = useMergeableReceipts(saleId);
  const rows = useMemo(() => receipts.data ?? [], [receipts.data]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const chosen = useMemo(() => picked ?? new Set(saleId ? [saleId] : []), [picked, saleId]);
  const merged = useMergedReceipts(chosen.size >= 2 ? [...chosen] : []);

  const settings = usePrintSettings(store?.id ?? null);
  const width = settings.data?.width ?? 80;
  const printer = useThisPrinter(store?.id ?? null, width);

  const ordered = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const owe = Number(b.outstanding > 0.005) - Number(a.outstanding > 0.005);
        return owe !== 0 ? owe : b.occurredAt.localeCompare(a.occurredAt);
      }),
    [rows],
  );

  if (!store) return null;

  const status: PageStatus = !saleId
    ? { state: 'empty', title: 'Open a receipt first', body: 'Receipts are put together from one of them.' }
    : receipts.data
      ? rows.length === 0
        ? {
            state: 'empty',
            title: 'Only a named customer’s receipts go together',
            body: 'This receipt has no customer on it. Name the customer on it first (Something on this is wrong).',
          }
        : { state: 'ready' }
      : receipts.error
        ? { state: 'error', what: 'their receipts', error: String(receipts.error), onRetry: receipts.reload }
        : { state: 'loading', what: 'their receipts' };

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const doc = merged.data && chosen.size >= 2 ? receiptDocument(merged.data, store.name, settings.data ?? null) : null;
  const name = merged.data?.customer?.name ?? '';

  return (
    <PageScaffold onBack={goBack} title="Put receipts together" subtitle={name || 'One paper for one customer'}>
      <PageState status={status}>
        {() => (
          <>
            <Explain label="Does this change anything?">
              No. It is a way to print or send several of one customer&rsquo;s receipts as one paper:
              the same item at the same price is added up (20 Bigi and 5 Bigi is 25 Bigi), every
              charge and payment is on it, and what they owe and what is still with them is said once,
              as it stands now. Every receipt stays exactly as it was.
            </Explain>

            <ul className={styles.list}>
              {ordered.map((r) => (
                <li key={r.saleId}>
                  <label className={styles.row}>
                    <input type="checkbox" checked={chosen.has(r.saleId)} onChange={() => toggle(r.saleId)} />
                    <span className={styles.body}>
                      <span className={styles.name}>
                        #{r.saleId.slice(0, 8).toUpperCase()}
                        {r.saleId === saleId ? ' · this receipt' : ''}
                      </span>
                      <span className={styles.meta}>
                        {formatDateTime(r.occurredAt)} · {r.lineCount} {r.lineCount === 1 ? 'item' : 'items'}
                        {r.outstanding > 0.005 ? ` · owes ${formatMoney(r.outstanding)}` : ' · paid'}
                      </span>
                    </span>
                    <span className={styles.amount}>{formatMoney(r.total)}</span>
                  </label>
                </li>
              ))}
            </ul>

            {chosen.size < 2 ? (
              <InfoPanel tone="info" title="Tick another receipt">
                Tick at least two of their receipts to see them as one.
              </InfoPanel>
            ) : merged.error && !merged.data ? (
              <InfoPanel tone="danger" title="Could not put them together">
                {String(merged.error)}
              </InfoPanel>
            ) : !doc ? (
              <p className={styles.meta}>Putting them together…</p>
            ) : (
              <>
                <div className={styles.paper} data-print-root style={{ ['--receipt-width' as string]: `${width}mm` }}>
                  <PrintPreview lines={receiptLines(doc, printer.layout)} layout={printer.layout} />
                </div>
                <DocumentActions
                  storeId={store.id}
                  doc={doc}
                  filename={`receipts-${name.toLowerCase().replace(/\s+/g, '-') || 'customer'}`}
                  title={`Receipts from ${store.name}`}
                  message={`${name ? `${name}, your` : 'Your'} receipts from ${store.name}, put together.`}
                  whatsapp={{
                    phone: merged.data?.customer?.phone,
                    customerId: merged.data?.customer?.id,
                    customerName: name,
                  }}
                />
              </>
            )}
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
