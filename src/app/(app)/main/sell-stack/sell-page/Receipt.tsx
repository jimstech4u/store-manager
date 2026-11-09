'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './Receipt.module.css';
import { useNav } from '@academix-admin/navigation-stack';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { WhatsAppIcon } from '@/components/ui/Icon';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { useResource } from '@/lib/stacks/resource';
import { ACCOUNT_DERIVED_SCOPE } from '@/lib/stacks/customer-account';
import { getSupabase } from '@/lib/supabase/client';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatQty,
  formatQtySpoken,
  pluralUnit,
  messageOf,
} from '@/lib/format';
import { owedRowsFromReceipt, rollUpOwed } from '@/lib/empties-rollup';
import {
  renderReceiptCanvas,
  renderReceiptImage,
  shareImage,
  shareLink,
} from '@/lib/share';
import { receiptPdf, sharePdf } from '@/lib/pdf';
import { useThisPrinter } from '@/lib/stacks/printer';
import { openPrinterAppWith } from '@/lib/print-handoff';
import { reopenSale } from '@/lib/stacks/amend';
import { usePermission } from '@/hooks/usePermission';
import { asInstruction, receiptLines } from '@/lib/escpos-text';
import { PrintPreview } from '@/components/settings/PrintPreview';
import { appUrl } from '@/lib/app-url';
import { EmptiesBroughtBack } from '@/components/empties/EmptiesBroughtBack';
import { receiptDocument, type SaleDetail } from '@/lib/receipt-document';
import { ChangeOwed } from '@/components/sell/ChangeOwed';
import { autoPrintOn, useAutoPrint } from '@/lib/auto-print';

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
export function Receipt({
  saleId,
  storeId,
  after,
  emptiesAtCounter = false,
  autoPrint = false,
  onAutoPrinted,
}: {
  saleId: string;
  storeId: string;
  /**
   * The sale was just made, at the counter: ask whether they brought empties in with them, BEFORE
   * the receipt is printed or shared, so "still with you" is true on the paper.
   */
  emptiesAtCounter?: boolean;
  /**
   * What the page puts under the receipt — drawn only once the receipt is, so no action stands
   * under a loader acting on a receipt nobody can see yet.
   */
  after?: ReactNode;
  /**
   * The sale was just saved at the counter: print it by itself after this device's countdown, when
   * this device is set to (`useAutoPrint`), once the empties question is answered.
   */
  autoPrint?: boolean;
  /** Printed by itself and this device wants the till back next ("then the next customer"). */
  onAutoPrinted?: () => void;
}) {
  /*
   * A settled receipt in state-stack, keyed by sale.
   *
   * A receipt is the most re-opened screen in the app and the most fixed: once a sale is settled
   * its lines, its total and the shop's own header can no longer change. Refetching all three from
   * scratch every time somebody taps back into it — from the statement, from the day's takings,
   * from a customer's history — put a blank rectangle in front of a customer who was handed a
   * phone to look at their receipt.
   *
   * KEPT, AND RE-READ WHEN THE SALE'S FIGURES MOVE. This used to say nothing needs to invalidate it
   * — but a credit sale is paid later and a sale can be amended, and both change what this receipt
   * says it is owed. It now re-reads under the account figures' scope (a payment, an amendment, the
   * same on another till), keeping what is shown until the answer lands. And its error is no longer
   * stored WITH the receipt: a failed first read was cached as the receipt, with no way to ask again.
   */
  const res = useResource<{
    detail: SaleDetail;
    shopName: string;
    settings: { width: number; header: string | null; footer: string | null };
  }>({
    key: `receipt:v4:${saleId}`,
    scope: ACCOUNT_DERIVED_SCOPE,
    deps: [storeId],
    read: async () => {
      const supabase = getSupabase();
      const [{ data: d, error: dErr }, { data: s }, { data: store }] = await Promise.all([
        supabase.rpc('sale_detail', { p_sale_id: saleId }),
        supabase.rpc('ensure_store_settings', { p_store_id: storeId }),
        supabase.from('stores').select('name').eq('id', storeId).maybeSingle(),
      ]);
      if (dErr) throw dErr;

      const row = (Array.isArray(s) ? s[0] : s) as
        | { printer_width_mm: string; receipt_header: string | null; receipt_footer: string | null }
        | null;

      return {
        detail: d as unknown as SaleDetail,
        shopName: (store as { name: string } | null)?.name ?? '',
        settings: {
          width: Number(row?.printer_width_mm ?? 80),
          header: row?.receipt_header ?? null,
          footer: row?.receipt_footer ?? null,
        },
      };
    },
  });

  const detail = res.data?.detail ?? null;
  const shopName = res.data?.shopName ?? '';
  const settings = res.data?.settings ?? null;

  /*
   * HOW THIS DEVICE PRINTS, from the shop's own setting (0175) rather than from anything this
   * component works out for itself.
   *
   * An earlier version of this decided on the spot: if the browser had Web Bluetooth, print over
   * Bluetooth. Which would have taken printing AWAY from a shop on a laptop with a real driver and a
   * working print dialog, and handed them a device chooser instead. The shop says which; the hook
   * re-acquires the connection silently where the browser allows it.
   *
   * CALLED HERE, above the early returns for loading and failure. It sat below them for one build and
   * the receipt died with React error 310 — "rendered more hooks than during the previous render" —
   * because the first pass returned early and the second did not. A hook cannot live after a return.
   */
  const printer = useThisPrinter(storeId, Number(settings?.width) || undefined);
  const route: 'direct' | 'app' | 'browser' =
    (printer.kind === 'usb' || printer.kind === 'bluetooth') && printer.ready
      ? 'direct'
      : printer.kind === 'ios_app'
        ? 'app'
        : 'browser';
  // Only a receipt never read is an error screen; a failed re-read keeps the receipt readable.
  const error = res.data ? null : res.error;

  const [sharing, setSharing] = useState(false);
  const nav = useNav();
  const [shareNote, setShareNote] = useState<string | null>(null);
  /*
   * The link this screen made, so it can be taken back.
   *
   * You cannot revoke a token you did not keep, and the shop has no other way to see it — the token
   * is the link. Held per screen rather than fetched: the only link worth withdrawing in a hurry is
   * the one just sent to the wrong number.
   */
  const [sharedToken, setSharedToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [sharingWhatsApp, setSharingWhatsApp] = useState(false);
  const [makingPdf, setMakingPdf] = useState(false);
  const [printing, setPrinting] = useState(false);

  /*
   * ── PRINTING BY ITSELF, after a countdown that can be cancelled ─────────────────────────
   *
   * "after saving order we remember the last printer connected and print to it after the countdown
   * but can cancel within the time." The printer is this device's saved one (`useThisPrinter`);
   * whether, and after how long, is this device's setting (`useAutoPrint`, Receipt and printer).
   *
   * IT WAITS FOR THE EMPTIES QUESTION. A sale that sent crates out asks whether any came back before
   * the paper goes, so "still with you" is the answer rather than the question. Until it is answered
   * the banner says so, with "None came back" to go on at once.
   *
   * `printRef` is the Print button's own routine, set further down where the receipt exists: the
   * timer runs above the early returns (hooks cannot live below them) and calls it when it is due.
   */
  const { setting: auto } = useAutoPrint();
  const [emptiesAsking, setEmptiesAsking] = useState<number | null>(null);
  const [autoPhase, setAutoPhase] = useState<'idle' | 'waiting' | 'counting' | 'done' | 'off'>('idle');
  const [left, setLeft] = useState(0);
  const printRef = useRef<(() => Promise<boolean>) | null>(null);
  const autoPrintedRef = useRef(onAutoPrinted);
  autoPrintedRef.current = onAutoPrinted;

  const hasCustomer = Boolean(detail?.customer);
  const autoWanted =
    autoPrint &&
    Boolean(detail) &&
    printer.loaded &&
    !printer.reconnecting &&
    detail?.sale.status !== 'voided' &&
    autoPrintOn(auto, route);
  const emptiesOpen = emptiesAtCounter && hasCustomer && emptiesAsking !== 0;

  useEffect(() => {
    if (!autoWanted) return;
    if (autoPhase === 'idle' || autoPhase === 'waiting') {
      if (emptiesOpen) {
        if (autoPhase !== 'waiting') setAutoPhase('waiting');
        return;
      }
      setLeft(auto.wait);
      setAutoPhase('counting');
    }
  }, [autoWanted, emptiesOpen, autoPhase, auto.wait]);

  useEffect(() => {
    if (autoPhase !== 'counting') return;
    if (left <= 0) {
      setAutoPhase('done');
      void (async () => {
        const went = await printRef.current?.();
        if (went && auto.thenTill) autoPrintedRef.current?.();
      })();
      return;
    }
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [autoPhase, left, auto.thenTill]);

  /*
   * REOPENING A CANCELLATION — offered here because this is the screen somebody is looking at when
   * they realise. The permission is the same one that cancels and corrects: undoing a cancellation
   * is the same kind of act, and gating it more tightly would mean the person who made the mistake
   * cannot fix it.
   */
  const { can } = usePermission();
  const canAmend = can('sales.amend');
  const [reopening, setReopening] = useState(false);
  const [reopenWhy, setReopenWhy] = useState('');
  const [askReopen, setAskReopen] = useState(false);

  /*
   * WHICH WAY THIS DEVICE CAN REACH A PRINTER. See src/lib/printing.ts for the whole reasoning.
   *
   * Decided after mounting, not during the render, because it reads the user agent and the Bluetooth
   * API: the server has no opinion about which phone this is, and answering differently on the two
   * passes would make React throw the markup away and rebuild it.
   *
   * Three routes, in order of how little they ask of the shop:
   *
   *   · BLUETOOTH DIRECT, where the browser has Web Bluetooth — Android, and Chrome on a desktop.
   *     One tap, nothing installed, straight to the paired roll.
   *   · THE PRINTER APP, on iOS, through a URL scheme. One tap, and the receipt goes as a picture.
   *   · THE SHARE SHEET, when neither works — always available, three taps.
   */


  if (error) {
    return (
      <FullPageMessage
        title="Could not load the receipt"
        tone="error"
        inPage
        action={
          <Button fullWidth onClick={res.reload}>
            Try again
          </Button>
        }
      >
        {error}
      </FullPageMessage>
    );
  }
  if (!detail) {
    return <FullPageMessage title="Preparing the receipt" tone="loading" inPage />;
  }

  const { sale, customer, corrected } = detail;
  const width = settings?.width ?? 80;
  const receiptPayload = () => receiptDocument(detail, shopName, settings);

  /*
   * THE RECEIPT AS LINES — one description, read by the screen, the preview and the printer.
   *
   * Built here rather than inside the render so the screen and the Print button cannot end up
   * looking at different arrays. `receiptPayload()` is the single source of the figures; this is
   * the single source of how they are set out.
   */
  const printedLines = receiptLines(receiptPayload(), printer.layout);
  // What is still owed to them in change on this sale — the ChangeOwed block gives it.
  const changeOwed = Math.max(
    (Number(detail.change?.owed ?? 0) || 0) -
      (detail.change?.given ?? []).reduce((sum, g) => sum + (Number(g.amount) || 0), 0),
    0,
  );


  /*
   * PRINT, by whatever this device can do (see the Print button below for the routes). Shared by the
   * button and the countdown; true when something went to a printer or a print window.
   */
  const printNow = async (): Promise<boolean> => {
    setShareNote(null);

    if (route === 'browser') {
      window.print();
      return true;
    }

    setPrinting(true);
    try {
      if (route === 'direct') {
        const canvas = await renderReceiptCanvas(receiptPayload(), width, printer.layout);
        if (!canvas) throw new Error('Could not draw the receipt');
        await printer.print(canvas);
        setShareNote('Sent to the printer.');
        return true;
      }

      /*
       * IOS: THE RECEIPT IN THE PRINTER'S OWN LETTERS, as ESC/POS text — sharp, because the glyphs
       * live in the printer's ROM at the head's dot pitch, where a browser bitmap prints thin and
       * smudged. ₦ becomes N (escpos-text.ts); no upload, no public URL. The share sheet when no
       * printer app answers.
       */
      const went = await openPrinterAppWith(asInstruction(printedLines));
      if (went) return true;
      setShareNote('No printer app answered. Pick your printer’s own app in the share sheet.');

      const blob = await renderReceiptImage(receiptPayload(), width, printer.layout);
      if (!blob) throw new Error('Could not draw the receipt');
      const result = await shareImage(
        blob,
        `receipt-${sale.id.slice(0, 8)}.png`,
        `Receipt from ${shopName}`,
      );
      if (result === 'downloaded') {
        setShareNote('Saved to your downloads — open it to print.');
      }
      return false;
    } catch (e: unknown) {
      setShareNote(messageOf(e, 'Could not print this receipt'));
      return false;
    } finally {
      setPrinting(false);
    }
  };
  printRef.current = printNow;

  /*
   * THE QUESTIONS THAT CHANGE THE PAPER — change still owed to them, and the empties they brought
   * back. At the counter they come FIRST, straight under the print banner and above the receipt:
   * below it, a fifteen-line receipt had to be scrolled past to answer them, while the customer
   * waited for the paper. Anywhere else (a receipt opened later) they stay under it.
   */
  const counterQuestions = (
    <>
      {/*
        EMPTIES THEY CARRIED IN, settled before the paper goes out.

        "so receipt will not carry 'still with you' if they brought it already." Recorded at the
        sale's moment and against the sale, so the receipt — which reads its containers as at the
        sale — re-reads and prints the true figure, or none at all.
      */}
      {/* CHANGE OWED, given where it is read — before the paper goes out, or when they come back. */}
      {sale.status !== 'voided' && changeOwed > 0.005 && (
        <div data-print-no-print>
          <ChangeOwed
            storeId={storeId}
            saleId={sale.id}
            owed={changeOwed}
            atSale={emptiesAtCounter}
            onGiven={() => void res.reload()}
          />
        </div>
      )}

      {customer && sale.status !== 'voided' && (
        <div data-print-no-print>
          <EmptiesBroughtBack
            storeId={storeId}
            customerId={customer.id}
            forSale={{
              id: sale.id,
              // At the counter: back at the sale's moment, so the paper is right before it prints.
              occurredAt: emptiesAtCounter ? sale.occurred_at : null,
            }}
            title={emptiesAtCounter ? 'Did they bring any empties back?' : 'Empties from this receipt'}
            onRecorded={() => void res.reload()}
            onAsking={setEmptiesAsking}
          />
        </div>
      )}
    </>
  );

  return (
    <>
      {/*
        THE RECEIPT, DRAWN FROM THE LINES THE PRINTER IS SENT.

        This screen used to lay the receipt out in its own markup — a head, a meta block, a list of
        lines, a totals table. It looked like a receipt and it was not the one that came out of the
        printer: different wrapping, different rounding of where things sat, the unit price shown
        here and not there. A shop comparing the screen with the paper found two documents, and
        could not tell which was wrong.

        So it renders `receiptLines`, the exact array `asInstruction` tags and sends. Monospaced,
        at the same characters-per-line, because that is what a printer's built-in font is. There
        is no second layout left to drift.

        `data-print-root` stays: the browser's own print still reveals exactly this, so a shop on a
        laptop prints the same document too.
      */}
      {/*
        PRINTING BY ITSELF — the countdown, and the empties question it waits on. Above the receipt,
        where the eye already is when the sale is saved.
      */}
      {autoPhase === 'waiting' && (
        <div className={`${styles.auto} ${styles.autoAsk}`} role="status" data-print-no-print>
          <span className={styles.autoText}>
            <strong>Say what empties came back, and it prints</strong>
            <span>Just below. Nothing came back? Print now.</span>
          </span>
          <span className={styles.autoActions}>
            <Button size="small" onClick={() => { setLeft(auto.wait); setAutoPhase('counting'); }}>
              None came back — print
            </Button>
            <Button size="small" variant="secondary" onClick={() => setAutoPhase('off')}>
              Don&rsquo;t print
            </Button>
          </span>
        </div>
      )}
      {autoPhase === 'counting' && (
        <div className={styles.auto} role="status" data-print-no-print>
          <span className={styles.autoCount} aria-hidden="true">{left}</span>
          <span className={styles.autoText}>
            <strong>Printing{printer.printerName ? ` on ${printer.printerName}` : ''}</strong>
            <span>in {left} {left === 1 ? 'second' : 'seconds'}</span>
          </span>
          <Button size="small" variant="secondary" onClick={() => setAutoPhase('off')}>
            Cancel
          </Button>
        </div>
      )}

      {emptiesAtCounter && counterQuestions}

      <div
        className={styles.receipt}
        data-print-root
        style={{ ['--receipt-width' as string]: `${width}mm` }}
      >
        <PrintPreview lines={printedLines} layout={printer.layout} />
      </div>

      {shareNote && (
        <p className={styles.shareNote} role="status">
          {shareNote}
        </p>
      )}

      {!emptiesAtCounter && counterQuestions}

      {/*
        TAKING IT BACK.

        `revoke_share_link` has existed since 0019 and nothing has ever called it. A shop that sent
        a receipt to the wrong number — one digit out, the commonest mistake there is — could not
        withdraw it, and that page shows what was bought, what was paid, what is still owed and the
        shop's own bank account.

        Only after a link has been made on this screen, because there is nothing to withdraw before
        that and a button that does nothing is a button somebody presses to find out what it does.
      */}
      {sharedToken && (
        <button
          type="button"
          className={styles.revoke}
          data-print-no-print
          disabled={revoking}
          onClick={async () => {
            setRevoking(true);
            setShareNote(null);
            try {
              const { error: err } = await getSupabase().rpc('revoke_share_link', {
                p_token: sharedToken,
              });
              if (err) throw err;
              setSharedToken(null);
              setShareNote('That link no longer opens. Share again to send a new one.');
            } catch (e: unknown) {
              setShareNote(messageOf(e, 'Could not take that link back'));
            } finally {
              setRevoking(false);
            }
          }}
        >
          {revoking ? 'Taking it back…' : 'Sent to the wrong person? Take the link back'}
        </button>
      )}

      {/*
        ─── CANCELLED, AND THE WAY BACK ──────────────────────────────────────────

        Said at the top of the actions rather than buried: a cancelled receipt looks almost
        identical to a live one, and somebody about to hand it to a customer needs to know.

        The reason is asked before anything happens, not after. "Why is this back" is a question
        somebody who was not there asks weeks later, and a reopen with no reason is
        indistinguishable from quietly undoing a decision you were overruled on.
      */}
      {/*
        AND ON SCREEN, WITH THE REASON.

        The reason is free text a person typed and can run to a sentence, which is why it is not on
        the roll — a receipt is 32 characters across at this size. Here there is room for it, and
        this is where somebody goes when they are trying to work out what happened to a sale.
      */}
      {corrected && sale.status !== 'voided' && (
        <div className={styles.corrected} data-print-no-print>
          <p className={styles.correctedHead}>
            <strong>This receipt was corrected</strong>
            {` on ${formatDateTime(corrected.replaced_at)}`}
            {corrected.reason ? ` — ${corrected.reason}` : ''}
          </p>
          <p className={styles.correctedWas}>
            It was {formatMoney(corrected.was_total)} before
            {sale.revision ? `, and this is version ${sale.revision}` : ''}.
          </p>
        </div>
      )}

      {sale.status === 'voided' && (
        <div className={styles.cancelled} data-print-no-print>
          <p className={styles.cancelledHead}>
            <strong>This receipt was cancelled</strong>
            {sale.cancelled_reason ? ` — ${sale.cancelled_reason}` : ''}
          </p>
          {canAmend && !askReopen && (
            <Button variant="secondary" fullWidth onClick={() => setAskReopen(true)}>
              Open it again
            </Button>
          )}
          {canAmend && askReopen && (
            <>
              <Field
                label="Why is it being reopened?"
                value={reopenWhy}
                onChange={(e) => setReopenWhy(e.target.value)}
                placeholder="Cancelled by mistake, the lorry did go"
                hint="The stock goes back out, the containers are owed again, and the bill returns to their account."
              />
              <Button
                fullWidth
                busy={reopening}
                busyLabel="Opening"
                disabled={reopenWhy.trim() === ''}
                onClick={async () => {
                  setReopening(true);
                  setShareNote(null);
                  try {
                    await reopenSale(sale.id, reopenWhy.trim());
                    setAskReopen(false);
                    setReopenWhy('');
                    // Re-read rather than patch: a reopen moves four ledgers and the screen should
                    // show what the shop now holds, not what this device believes it sent.
                    await res.reload();
                  } catch (e: unknown) {
                    setShareNote(messageOf(e, 'Could not reopen this receipt'));
                  } finally {
                    setReopening(false);
                  }
                }}
              >
                Open this receipt again
              </Button>
            </>
          )}
        </div>
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
              setSharedToken(token as string);

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
              setSharedToken(token as string);

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
            const blob = await renderReceiptImage(receiptPayload(), width, printer.layout);
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

        {/*
          PRINT — ONE TAP, AND THE ROUTE IS THE DEVICE'S PROBLEM, NOT THE SELLER'S.

          A shop told us it could not print at all: an 80mm roll paired over Bluetooth, printing
          fine from the printer's own app, and this button giving "No AirPrint printers found".
          AirPrint only reaches printers on a network. And there is volume here — a receipt per
          sale, all day — so three taps through a share sheet is not an answer either.

          So the button does whatever this device can actually do, and says which:

            Android / desktop Chrome  →  straight to the paired printer over Bluetooth
            iPhone, iPad              →  handed to the printer's own app by URL scheme
            anything else             →  the browser's own print

          Each falls back to the one below it rather than failing: a printer out of range, or the
          printer app not installed, ends at the share sheet, which always works. See
          src/lib/printing.ts, escpos.ts and print-handoff.ts.
        */}
        <Button
          variant="secondary"
          fullWidth
          busy={printing}
          busyLabel="Printing"
          onClick={() => void printNow()}
        >
          Print
        </Button>
        {route === 'direct' && (
          <p className={styles.shareNote}>
            Printing straight to {printer.printerName}
            {printer.kind === 'usb' ? ' over the cable' : ''}.
          </p>
        )}

        {/*
          A PRINTER THAT IS SET UP BUT NOT THERE, said as a fact rather than as an error.

          A cable unplugged or a roll switched off is the ordinary morning state, not a fault. The
          button below still prints — through the browser — so the sentence explains why it will look
          different rather than blocking anything.
        */}
        {(printer.kind === 'usb' || printer.kind === 'bluetooth') && !printer.ready && (
          <p className={styles.shareNote}>
            {printer.reconnecting
              ? `Looking for ${printer.printerName ?? 'your printer'}…`
              : `${printer.printerName ?? 'Your printer'} is not answering. Printing the ordinary way instead — or set it up again in Settings.`}
          </p>
        )}

        {route === 'app' && (
          <p className={styles.shareNote}>
            Goes to your printer’s own app. A Bluetooth printer never appears under Print —
            that list is network printers only.
          </p>
        )}
        {/*
          MOBILE PRINT UTIL PRINTS ONCE. Reported 8 Oct 2026: the first print from the app works, the
          next is refused with "an issue with your device connection" until the printer app is closed.
          The app keeps its Bluetooth link after a job and its URL scheme has no way to release it, so
          nothing this page sends can — the way through is said where it is needed.
        */}
        {route === 'app' && (
          <p className={styles.shareNote}>
            Printed once, and the second time the printer app says “there is an issue with your device connection”? Close that app (swipe it away) and print again — it keeps hold of the printer after a print until it is closed.
          </p>
        )}

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
              const canvas = await renderReceiptCanvas(receiptPayload(), width, printer.layout);
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

      {after}
    </>
  );
}
