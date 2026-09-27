'use client';

import { useCallback, useState } from 'react';
import { useLocation } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { Explain } from '@/components/ui/Explain';
import { PrintPreview } from '@/components/settings/PrintPreview';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useResource } from '@/lib/stacks/resource';
import { ACCOUNT_DERIVED_SCOPE } from '@/lib/stacks/customer-account';
import { saleDocument, saleRevisions, type Revision, type SaleDocument } from '@/lib/stacks/amend';
import { useThisPrinter } from '@/lib/stacks/printer';
import { asInstruction, receiptLines } from '@/lib/escpos-text';
import { openPrinterAppWith } from '@/lib/print-handoff';
import { printCanvas } from '@/lib/bluetooth-print';
import { printCanvasOverUsb } from '@/lib/usb-print';
import { renderReceiptCanvas } from '@/lib/share';
import { formatDateTime, formatMoney, formatQty, messageOf, pluralUnit } from '@/lib/format';
import styles from './receipt-history-page.module.css';

/**
 * EVERYTHING THIS RECEIPT HAS EVER SAID.
 *
 * A corrected receipt keeps its number, which is the whole point — the customer is holding a
 * printed copy and a link that has to keep resolving. The cost of that is a document whose meaning
 * changes, and six weeks later the question is not "what does it say" but "what did the copy in
 * their hand say, and why is this one different".
 *
 * `sale_revisions` has kept the answer since 0131: every version, whole, with its reason and who
 * made it. Nothing read it back until now, so the record existed and nobody could see it.
 *
 * AND AN OLD VERSION CAN BE PRINTED. A customer arrives holding revision 1 and disputing revision
 * 3; the shop needs to put the two side by side on paper. It prints through the same
 * `receiptLines` as everything else, so an old revision on paper looks like a receipt rather than
 * like a database row.
 */
export default function ReceiptHistoryPage() {
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const saleId = (location?.params?.id as string | undefined) ?? null;
  const printer = useThisPrinter(store?.id ?? null);

  const read = useCallback(async () => {
    if (!saleId) return null;
    const [now, past] = await Promise.all([saleDocument(saleId), saleRevisions(saleId)]);
    return { now, past };
  }, [saleId]);

  const area = useResource<{ now: SaleDocument | null; past: Revision[] } | null>({
    key: `receipt-history:${saleId ?? 'none'}`,
    scope: ACCOUNT_DERIVED_SCOPE,
    enabled: Boolean(saleId),
    deps: [saleId ?? ''],
    read,
  });

  const [showing, setShowing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!store) return null;

  const status: PageStatus = !saleId
    ? { state: 'empty', title: 'No receipt chosen', body: 'History is reached from a receipt.' }
    : !area.loaded
      ? { state: 'loading', what: 'what this receipt has said' }
      : area.error
        ? { state: 'error', what: 'this history', error: String(area.error), onRetry: area.reload }
        : { state: 'ready' };

  /** A stored document, in the shape the printer and the preview read. */
  const asPayload = (doc: SaleDocument) => ({
    shopName: store.name,
    header: null,
    footer: null,
    meta: [
      formatDateTime(doc.occurredAt),
      `#${doc.saleId.slice(0, 8).toUpperCase()} rev ${doc.revision}`,
      ...(doc.customer ? [doc.customer.name] : []),
    ],
    lines: doc.lines.map((l) => ({
      name: l.productName,
      detail: `${formatQty(l.enteredQty)} ${l.unitName ?? pluralUnit('piece', l.enteredQty)} x ${formatMoney(l.unitPrice)}`,
      qty: `${formatQty(l.enteredQty)} ${l.unitName ?? pluralUnit('piece', l.enteredQty)}`,
      amount: formatMoney(l.lineTotal),
    })),
    totals: [
      ...(doc.feeAmount > 0
        ? [{ label: doc.feeLabel || 'Extra charge', value: formatMoney(doc.feeAmount) }]
        : []),
      { label: 'Total', value: formatMoney(doc.total), strong: true },
    ],
    note: doc.note,
    transferDetails: null,
  });

  /** Put an old version on paper, whichever way this device reaches its printer. */
  const printOld = async (doc: SaleDocument) => {
    setBusy(true);
    setNote(null);
    try {
      const lines = receiptLines(asPayload(doc), printer.layout);
      if (printer.kind === 'ios_app') {
        await openPrinterAppWith(asInstruction(lines));
        return;
      }
      if (printer.kind === 'usb' || printer.kind === 'bluetooth') {
        /*
         * The direct routes send a raster, and the raster is drawn from the same payload — so an
         * old revision on paper is laid out by the same code as a current one. A second renderer
         * for history is a second document nobody would notice was wrong.
         */
        const canvas = await renderReceiptCanvas(asPayload(doc), printer.widthMm);
        if (!canvas) throw new Error('Could not draw that version');
        if (printer.kind === 'usb') await printCanvasOverUsb(canvas, printer.widthMm);
        else await printCanvas(canvas, printer.widthMm);
        return;
      }
      window.print();
    } catch (e: unknown) {
      setNote(messageOf(e, 'Could not print that version'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="What this receipt has said"
      subtitle="Every version, and why it changed"
    >
      <PageState status={status}>
        {() => {
          const data = area.data;
          if (!data?.now) return null;
          const past = data.past;

          return (
            <>
              <Explain label="Why does a receipt have versions?">
                A corrected receipt keeps its number, so the link you sent the customer still works
                and the payments stay attached to it. What it said before is kept in full — because
                somebody may still be holding that copy, and the question later is why the two
                disagree.
              </Explain>

              {/* ── What it says now ────────────────────────────────────────── */}
              <h2 className={styles.section}>Now</h2>
              <button
                type="button"
                className={`${styles.version} ${showing === null ? styles.versionOpen : ''}`}
                onClick={() => setShowing(null)}
              >
                <span className={styles.versionHead}>
                  <span className={styles.versionName}>
                    Revision {data.now.revision}
                    {past.length > 0 ? ' — the current one' : ''}
                  </span>
                  <span className={styles.versionTotal}>{formatMoney(data.now.total)}</span>
                </span>
                <span className={styles.versionWhen}>{formatDateTime(data.now.occurredAt)}</span>
              </button>

              {past.length === 0 ? (
                <p className={styles.note}>
                  This receipt has never been corrected, so there is only the one version.
                </p>
              ) : (
                <>
                  {/* ── And what it said before ──────────────────────────────── */}
                  <h2 className={styles.section}>Before</h2>
                  <p className={styles.note}>
                    Newest first. Each one is what the receipt said until the correction under it.
                  </p>

                  {past.map((r) => (
                    <button
                      key={r.revision}
                      type="button"
                      className={`${styles.version} ${showing === r.revision ? styles.versionOpen : ''}`}
                      onClick={() => setShowing(showing === r.revision ? null : r.revision)}
                    >
                      <span className={styles.versionHead}>
                        <span className={styles.versionName}>Revision {r.revision}</span>
                        <span className={styles.versionTotal}>
                          {formatMoney(r.document.total)}
                        </span>
                      </span>
                      {/*
                        THE REASON IS THE POINT OF THE ROW. The figures say what changed; only this
                        says why, and it is the sentence somebody is looking for when they open
                        this page.
                      */}
                      <span className={styles.versionWhy}>{r.reason}</span>
                      <span className={styles.versionWhen}>
                        {formatDateTime(r.amendedAt)}
                        {r.actorName ? ` · ${r.actorName}` : ''}
                      </span>
                    </button>
                  ))}
                </>
              )}

              {/* ── The one being looked at, as it will print ────────────────── */}
              {(() => {
                const doc =
                  showing === null
                    ? data.now
                    : (past.find((r) => r.revision === showing)?.document ?? data.now);
                return (
                  <>
                    <h2 className={styles.section}>
                      {showing === null ? 'What it says now' : `What revision ${showing} said`}
                    </h2>
                    <PrintPreview
                      lines={receiptLines(asPayload(doc), printer.layout)}
                      layout={printer.layout}
                    />
                    <Button
                      variant="secondary"
                      fullWidth
                      busy={busy}
                      busyLabel="Printing"
                      onClick={() => void printOld(doc)}
                    >
                      Print this version
                    </Button>
                  </>
                );
              })()}

              {note && (
                <p className={styles.note} role="status">
                  {note}
                </p>
              )}
            </>
          );
        }}
      </PageState>
    </PageScaffold>
  );
}
