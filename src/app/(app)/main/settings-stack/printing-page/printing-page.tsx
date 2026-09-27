'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { PrintPreview } from '@/components/settings/PrintPreview';
import { useNav } from '@academix-admin/navigation-stack';
import { CheckIcon, PlusIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { useReceiptPaper } from '@/lib/stacks/receipt-paper';
import {
  availableKinds,
  deviceId,
  forgetPrinter,
  savePrinter,
  usePrinters,
  useThisPrinter,
  type PrinterKind,
} from '@/lib/stacks/printer';
import {
  asInstruction,
  columnsAt,
  defaultLayout,
  receiptLines,
  rulerTicket,
  type ReceiptLayout,
  type TextSize,
} from '@/lib/escpos-text';
import { dotsFor, testTicket } from '@/lib/escpos';
import { printBytes } from '@/lib/bluetooth-print';
import { printBytesOverUsb } from '@/lib/usb-print';
import { openPrinterAppWith, textTicket, VENDOR_SAMPLE } from '@/lib/print-handoff';
import { messageOf } from '@/lib/format';
import { Field } from '@/components/ui/Field';
import { getSupabase } from '@/lib/supabase/client';
import { LogoRejected, normaliseReceiptLogo } from '@/lib/image-pipeline';
import { useBankAccounts } from '@/lib/stacks/bank-accounts';
import { usePermission } from '@/hooks/usePermission';
import styles from './printing-page.module.css';

/**
 * PRINTING — everything about it, on one page.
 *
 * It was spread across the Settings screen in three places: a paper width under the receipt, a
 * second paper width beside the preview, a size picker, a preview, and the printer connection —
 * with two previews and two width controls that could disagree with each other. Settings is a list
 * of things a shop can go and do, not the place to do them.
 *
 * ── WHY THE COLUMN COUNTS ARE MEASURED ────────────────────────────────────────────
 *
 * A receipt reads by its amounts lining up on the right, and lining them up means padding a label
 * out to the exact width of a line. Being wrong about that width does not look like a rounding
 * error: the amount wraps onto the next line, indented by the padding, and the receipt becomes a
 * ladder. That is exactly what a shop found — a preview showing tidy columns against paper that
 * did not.
 *
 * The widths were calculated from the head's dot pitch and the small font was right; the large one
 * was not. A printer cannot be asked, and these are not standard parts. So the shop prints a ruler
 * and reads the number off it, once, and from then on the preview and the paper are the same
 * document.
 */

/** The rolls a shop is likely to have. Anything between 30 and 250 can still be typed. */
const PRESET_WIDTHS = [40, 58, 80, 100];

/** The sizes offered, smallest first — a real progression rather than eight confusing tags. */
const SIZES: { size: TextSize; name: string }[] = [
  { size: 'ss', name: 'Small' },
  { size: 'sl', name: 'Medium' },
  { size: 'ssw', name: 'Wide' },
  { size: 'sshw', name: 'Wide and tall' },
];

/** Each part of a receipt that carries its own size, in the order it prints. */
const PARTS: { key: keyof ReceiptLayout; name: string; what: string }[] = [
  { key: 'shopName', name: 'Shop name', what: 'The line at the very top' },
  { key: 'header', name: 'Address and phone', what: 'Under the name' },
  { key: 'meta', name: 'Date, number, customer', what: 'Who and when' },
  { key: 'itemName', name: 'Item names', what: 'What they bought' },
  { key: 'itemDetail', name: 'Quantity and price', what: 'The line under each item' },
  { key: 'totals', name: 'Figures', what: 'Paid, owed before, balance' },
  { key: 'strongTotals', name: 'Total and headings', what: 'The ones people argue about' },
  { key: 'bank', name: 'Bank details', what: 'Where to send the money' },
  { key: 'footer', name: 'Thank-you line', what: 'The last line' },
];

export default function PrintingPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const shop = store;
  const settings = useReceiptPaper(store?.id ?? null);

  const paperMm = Number(settings.data?.printer_width_mm) || 80;
  const printer = useThisPrinter(store?.id ?? null, paperMm);
  const printers = usePrinters(store?.id ?? null);

  const [kinds, setKinds] = useState<PrinterKind[]>([]);
  useEffect(() => setKinds(availableKinds()), []);
  const [connecting, setConnecting] = useState<PrinterKind | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * The logo and the shop's bank accounts, here with the controls that use them.
   *
   * Setting up a receipt is ONE job and it was split across two screens: the paper and the printer
   * here, the words and the logo on Settings, with a preview on each that could disagree.
   */
  const logoInput = useRef<HTMLInputElement | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const accounts = useBankAccounts(store?.id ?? null);
  const { can, canOpen } = usePermission();
  const editable = can('store.settings');

  /*
   * WHICH ACCOUNT ACTUALLY PRINTS: the one chosen, or the shop's default if nothing was chosen.
   *
   * Read from the accounts list rather than from the three text columns 0083 retired — a preview
   * built on those showed a blank block on every shop that had moved on.
   */
  const receiptAccount =
    accounts.find((a) => a.id === settings.data?.receipt_bank_account_id) ??
    accounts.find((a) => a.is_default) ??
    null;



  /*
   * The layout being edited, seeded from the shop once and NOT re-seeded afterwards: every nudge of
   * a slider saves, and re-seeding on the reload that follows would fight the next nudge.
   */
  const [layout, setLayout] = useState<ReceiptLayout | null>(null);
  useEffect(() => {
    if (layout || !printer.loaded) return;
    setLayout(printer.layout);
  }, [printer.loaded, printer.layout, layout]);

  const live = layout ?? defaultLayout(dotsFor(paperMm));

  /*
   * A receipt made of the AWKWARD cases rather than the easy ones: a name long enough to wrap, a
   * half-crate, an amount wide enough to crowd its label, containers still out, bank details. A
   * preview of a tidy example tells a shop nothing about the receipt that will give them trouble.
   */
  const sample = useMemo(
    () => ({
      shopName: store?.name ?? 'Your shop',
      header: settings.data?.receipt_header ?? null,
      footer: settings.data?.receipt_footer ?? null,
      meta: [new Date().toLocaleString(), '#2D6AB81C', 'Gabriel'],
      lines: [
        { name: 'Gulder 60cl', detail: '0.5 Crate x ₦9,600', amount: '₦4,800' },
        { name: 'American Cola PET 60cl', detail: '20 Bottle x ₦3,700', amount: '₦74,000' },
      ],
      totals: [
        { label: 'Total', value: '₦78,800', strong: true },
        { label: 'Left on this sale', value: '₦78,800' },
        { label: 'Owed before', value: '₦94,200' },
        { label: 'Total owed', value: '₦173,000', strong: true },
        { label: 'Still with you', value: '', strong: true },
        { label: 'Nigerian Breweries (NBL) crates', value: '5' },
        { label: 'Goldberg 60cl crate', value: '0.5' },
      ],
      note: null,
      transferDetails: settings.data?.show_transfer_details
        ? [
            settings.data.transfer_bank_name,
            settings.data.transfer_account_no,
            settings.data.transfer_account_name,
          ]
            .filter(Boolean)
            .join(String.fromCharCode(10)) || null
        : null,
    }),
    [store?.name, settings.data],
  );

  const lines = useMemo(() => receiptLines(sample, live), [sample, live]);

  if (!store) return null;

  const status: PageStatus = !printer.loaded || !settings.loaded
    ? { state: 'loading', what: 'your printer' }
    : { state: 'ready' };

  /** Every change saves. A settings page with a Save button is a page somebody leaves unsaved. */
  const keep = async (next: ReceiptLayout) => {
    setLayout(next);
    if (!store) return;
    try {
      await savePrinter(store.id, {
        kind: printer.kind,
        deviceLabel: printer.choice?.deviceLabel ?? null,
        printerName: printer.choice?.printerName ?? null,
        widthMm: printer.widthMm,
        usbVendorId: printer.choice?.usbVendorId ?? null,
        usbProductId: printer.choice?.usbProductId ?? null,
        btDeviceId: printer.choice?.btDeviceId ?? null,
        textSize: printer.textSize,
        layout: next,
      });
      await printers.reload();
    } catch (e: unknown) {
      setNote(messageOf(e, 'Could not save that'));
    }
  };

  const chooseKind = async (kind: PrinterKind) => {
    setNote(null);
    try {
      if (kind === 'usb' || kind === 'bluetooth') {
        setConnecting(kind);
        await printer.connect(kind);
        setNote(kind === 'usb' ? 'Connected over USB.' : 'Connected over Bluetooth.');
      } else if (kind === 'browser') {
        await forgetPrinter(store.id);
        setNote("This device will use its own print dialog.");
      } else {
        await savePrinter(store.id, {
          kind,
          deviceLabel: printer.choice?.deviceLabel ?? null,
          printerName: null,
          widthMm: printer.widthMm,
          usbVendorId: null,
          usbProductId: null,
          btDeviceId: null,
          textSize: printer.textSize,
          layout: live,
        });
      }
      await printers.reload();
      await printer.reload();
    } catch (e: unknown) {
      // Closing a chooser is a decision, not a failure. Reporting it trains people to ignore
      // the messages that matter.
      const m = messageOf(e, 'Could not connect that printer');
      if (!/cancell?ed|no device selected|chooser/i.test(m)) setNote(m);
    } finally {
      setConnecting(null);
    }
  };

  /** Send raw ESC/POS whichever way this device reaches its printer. */
  const send = async (instruction: string, bytes: Uint8Array) => {
    setBusy(true);
    setNote(null);
    try {
      if (printer.kind === 'usb') await printBytesOverUsb(bytes);
      else if (printer.kind === 'bluetooth') await printBytes(bytes);
      else if (printer.kind === 'ios_app') await openPrinterAppWith(instruction);
      else setNote('This device prints through its own dialog, so there is nothing to send.');
    } catch (e: unknown) {
      setNote(messageOf(e, 'Could not reach the printer'));
    } finally {
      setBusy(false);
    }
  };

  const escpos = printer.kind === 'usb' || printer.kind === 'bluetooth' || printer.kind === 'ios_app';

  return (
    <PageScaffold onBack={goBack} title="Printing" subtitle="Your printer, and how a receipt is set out">
      <PageState status={status}>
        {() => (
          <>
            {/* ── How this device reaches the printer ──────────────────────── */}
            <h2 className={styles.section}>How this device prints</h2>
            <div className={styles.grid} role="group" aria-label="How this device prints">
              {(['usb', 'bluetooth', 'ios_app', 'browser'] as PrinterKind[])
                .filter((k) => kinds.includes(k))
                .map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={`${styles.option} ${printer.kind === kind ? styles.optionOn : ''}`}
                    aria-pressed={printer.kind === kind}
                    disabled={connecting !== null}
                    onClick={() => void chooseKind(kind)}
                  >
                    <span className={styles.optionName}>
                      {connecting === kind
                        ? 'Connecting…'
                        : kind === 'usb'
                          ? 'USB cable'
                          : kind === 'bluetooth'
                            ? 'Bluetooth'
                            : kind === 'ios_app'
                              ? 'Printer app'
                              : "This device's dialog"}
                    </span>
                    <span className={styles.optionWhat}>
                      {kind === 'usb'
                        ? 'Straight to the roll. Most reliable.'
                        : kind === 'bluetooth'
                          ? 'Straight to a paired roll.'
                          : kind === 'ios_app'
                            ? 'For iPhone and iPad.'
                            : 'The normal print window.'}
                    </span>
                  </button>
                ))}
            </div>

            {printer.printerName && (
              <p className={styles.note}>
                Printing to <strong>{printer.printerName}</strong>.{' '}
                {printer.reconnecting
                  ? 'Looking for it…'
                  : printer.ready
                    ? 'Connected — one tap prints.'
                    : 'Not answering right now.'}
              </p>
            )}

            {/* ── The ruler, which is what makes the preview true ──────────── */}
            {escpos && (
              <>
                <h2 className={styles.section}>Measure your printer</h2>
                <Explain label="Why does this matter?">
                  A receipt reads by its amounts lining up on the right, and lining them up means
                  padding each label out to the exact width of a line. Guess too wide and the amount
                  wraps onto the next line. No printer can be asked how wide its letters are, so you
                  measure it once: print the ruler, read the last number that fitted before the line
                  wrapped, and set it here.
                </Explain>

                <Button
                  variant="secondary"
                  fullWidth
                  busy={busy}
                  busyLabel="Sending"
                  onClick={() => void send(rulerTicket(), new TextEncoder().encode(''))}
                >
                  Print a ruler
                </Button>

                <div className={styles.measures}>
                  {(
                    [
                      ['charsSmall', 'Small letters', 'The top ruler'],
                      ['charsLarge', 'Medium letters', 'The second ruler'],
                    ] as const
                  ).map(([key, name, which]) => (
                    <label key={key} className={styles.measure}>
                      <span className={styles.measureName}>
                        {name} <span className={styles.measureWhat}>· {which}</span>
                      </span>
                      <span className={styles.measureRow}>
                        <input
                          type="range"
                          min={16}
                          max={80}
                          step={1}
                          value={live[key]}
                          onChange={(e) => void keep({ ...live, [key]: Number(e.target.value) })}
                          className={styles.slider}
                        />
                        <output className={styles.measureValue}>{live[key]}</output>
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {/* ── The size of each part ─────────────────────────────────────── */}
            {escpos && (
              <>
                <h2 className={styles.section}>How big each part prints</h2>
                <p className={styles.note}>
                  A receipt is read by different people looking for different things. The total is
                  read across a counter; the bank details are copied down. They do not want the same
                  size.
                </p>

                <div className={styles.parts}>
                  {PARTS.map((part) => {
                    const at = SIZES.findIndex((s) => s.size === live[part.key]);
                    const index = at < 0 ? 0 : at;
                    return (
                      <label key={String(part.key)} className={styles.part}>
                        <span className={styles.partHead}>
                          <span className={styles.partName}>{part.name}</span>
                          <span className={styles.partSize}>
                            {SIZES[index].name} · {columnsAt(live[part.key] as TextSize, live)} a line
                          </span>
                        </span>
                        <span className={styles.partWhat}>{part.what}</span>
                        <input
                          type="range"
                          min={0}
                          max={SIZES.length - 1}
                          step={1}
                          value={index}
                          onChange={(e) =>
                            void keep({ ...live, [part.key]: SIZES[Number(e.target.value)].size })
                          }
                          className={styles.slider}
                        />
                      </label>
                    );
                  })}
                </div>

                <Button
                  variant="secondary"
                  fullWidth
                  onClick={() => void keep(defaultLayout(dotsFor(paperMm)))}
                >
                  Put the sizes back to normal
                </Button>
              </>
            )}

          {settings.data && (
            <>
          <h2 className={styles.section}>What the receipt says</h2>

          <div className={styles.presets}>
            {PRESET_WIDTHS.map((w: number) => (
              <button
                key={w}
                type="button"
                className={`${styles.preset} ${
                  Number(settings.data!.printer_width_mm) === w ? styles.presetActive : ''
                }`}
                onClick={() => editable && void settings.patch({ printer_width_mm: String(w) })}
                disabled={!editable}
                aria-pressed={Number(settings.data!.printer_width_mm) === w}
              >
                {w}mm
              </button>
            ))}
          </div>

          <Field
            label="Paper width"
            numeric
            suffix="mm"
            value={settings.data!.printer_width_mm}
            onChange={(e) => void settings.patch({ printer_width_mm: e.target.value })}
            disabled={!editable}
            hint="Any width between 30 and 250. Use the buttons above for the common sizes."
            help={
              <Explain label="Which one do I have?">
                It is usually printed on the roll or its packaging. If you are not sure, 80mm is
                the most common and 58mm is the small handheld kind. Narrow rolls print each item
                stacked rather than in columns, because there is not enough width for both.
              </Explain>
            }
          />

          <Field
            label="Line above the receipt"
            optional
            value={settings.data!.receipt_header ?? ''}
            onChange={(e) => void settings.patch({ receipt_header: e.target.value })}
            disabled={!editable}
            placeholder="Shop address or phone number"
          />

          {/*
            The logo, prepared for the paper it is going on.
            A receipt printer is one bit per dot and 40mm or 80mm wide, so a colour logo has to be
            trimmed, scaled and reduced to pure black and white before it means anything. Doing
            that here, and showing the result, means the shop approves what will actually print
            rather than what looks good on a phone.
          */}
          <div className={styles.logoBlock}>
            <p className={styles.label}>Logo on the receipt</p>

            <input
              ref={logoInput}
              type="file"
              accept="image/*"
              className={styles.hiddenInput}
              tabIndex={-1}
              aria-hidden="true"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file || !store) return;
                setLogoBusy(true);
                setLogoError(null);
                try {
                  // Dots across the paper at the usual 203dpi: 8 dots per millimetre, less a
                  // little margin. Preparing at the real dot count means no resampling later.
                  const dots = Math.round(Number(settings.data!.printer_width_mm) * 8 * 0.9);
                  const { blob } = await normaliseReceiptLogo(file, { widthPx: dots });

                  const path = `${store.id}/store/receipt-logo-${Date.now().toString(36)}.png`;
                  const up = await getSupabase()
                    .storage.from('media')
                    .upload(path, blob, { contentType: 'image/png', upsert: true });
                  if (up.error) throw new Error(up.error.message);

                  void settings.patch({ receipt_logo_path: path });
                } catch (err: unknown) {
                  // A rejection carries an explanation of what is wrong with the picture and what
                  // would work instead; anything else is a genuine failure.
                  setLogoError(
                    err instanceof LogoRejected
                      ? err.message
                      : messageOf(err, 'That logo could not be used.'),
                  );
                } finally {
                  setLogoBusy(false);
                }
              }}
            />

            <div className={styles.logoActions}>
              <Button
                variant="secondary"
                busy={logoBusy}
                disabled={!editable}
                onClick={() => logoInput.current?.click()}
              >
                {settings.data!.receipt_logo_path ? 'Change logo' : 'Add a logo'}
              </Button>
              {settings.data!.receipt_logo_path && (
                <Button
                  variant="ghost"
                  disabled={!editable}
                  onClick={() => void settings.patch({ receipt_logo_path: null })}
                >
                  Remove it
                </Button>
              )}
            </div>

            <p className={styles.sectionNote}>
              A wide picture works best — roughly three times as wide as it is tall, and at least
              {' '}{Math.round(Number(settings.data!.printer_width_mm) * 8 * 0.45)} pixels across. It is
              printed in plain black and white, so a simple mark reads better than a photograph.
            </p>

            {logoError && (
              <InfoPanel tone="warning" title="That picture will not print well">
                {logoError}
              </InfoPanel>
            )}

            {settings.data!.receipt_logo_path && (
              <Field
                label="How wide on the paper"
                numeric
                suffix="%"
                value={String(settings.data!.receipt_logo_width_pct)}
                onChange={(e) =>
                  void settings.patch({ receipt_logo_width_pct: Number(e.target.value) || 60 })
                }
                disabled={!editable}
                hint="A share of the paper width, so it stays right if you change printers."
              />
            )}
          </div>

          <Field
            label="Line at the bottom"
            optional
            value={settings.data!.receipt_footer ?? ''}
            onChange={(e) => void settings.patch({ receipt_footer: e.target.value })}
            disabled={!editable}
            placeholder="Thank you for your patronage"
          />

          {/* Everything above, as it will print. Shown before the bank details so a mistake in
              the header or the logo is caught here rather than by a customer. */}
          {/*
            THE OLD BITMAP PREVIEW IS GONE.

            It drew its own picture of a receipt, beside the one further down this page that
            renders the lines the printer is actually sent. Two previews that can disagree is
            exactly what a shop reported — and the one that can disagree is the one that is not
            built from the instruction.
          */}

          <h2 className={styles.section}>Bank details on receipts</h2>
          <p className={styles.sectionNote}>
            Printed on receipts so a customer paying later knows where to send the money.
          </p>

          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={settings.data!.show_transfer_details}
              onChange={(e) => void settings.patch({ show_transfer_details: e.target.checked })}
              disabled={!editable}
            />
            <span>Show my bank details on receipts</span>
          </label>

          {settings.data!.show_transfer_details && (
            <>
              {/*
                CHOSEN FROM THE SHOP'S ACCOUNTS, not typed again.

                This was three text boxes — bank, number, name — typed once and checked against
                nothing. The shop already keeps its accounts under Money, and the payment screen
                already picks from them when somebody pays by transfer; having a second copy here
                meant a shop that closed an account had receipts still asking customers to pay into
                it, with no reason to think anything was wrong because the boxes still had text.
              */}
              {accounts.length === 0 ? (
                <InfoPanel tone="warning" title="No accounts yet">
                  <p>
                    Receipts can only show an account you have added. Add one and it will be
                    offered here.
                  </p>
                  {canOpen('bank_form_page') && (
                    <Button onClick={() => void nav.push('bank_form_page')}>
                      <PlusIcon /> Add a bank account
                    </Button>
                  )}
                </InfoPanel>
              ) : (
                <>
                  <ul className={styles.accountList}>
                    {accounts.map((a) => {
                      const chosen =
                        settings.data!.receipt_bank_account_id === a.id ||
                        (!settings.data!.receipt_bank_account_id && a.is_default);
                      return (
                        <li key={a.id}>
                          <button
                            type="button"
                            className={`${styles.accountRow} ${chosen ? styles.accountChosen : ''}`}
                            disabled={!editable}
                            onClick={() => void settings.patch({ receipt_bank_account_id: a.id })}
                            aria-pressed={chosen}
                          >
                            <span>
                              <span className={styles.accountBank}>{a.bank_name}</span>
                              <span className={styles.accountNo}>
                                {a.account_number} · {a.account_name}
                              </span>
                            </span>
                            {chosen && <CheckIcon />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {canOpen('bank_form_page') && (
                    <button
                      type="button"
                      className={styles.accountAdd}
                      onClick={() => void nav.push('bank_form_page')}
                    >
                      <PlusIcon /> Add another account
                    </button>
                  )}
                </>
              )}

              <InfoPanel tone="info" title="Old receipts keep their old details">
                Changing these does not alter receipts already issued — each one keeps the account
                it was printed with.
              </InfoPanel>
            </>
          )}
        </>
      )}

      {editable && shop && (
        <>
            </>
          )}

            {/* ── And what it will actually say ─────────────────────────────── */}
            <h2 className={styles.section}>What the roll will say</h2>
            <PrintPreview lines={lines} layout={live} />
            <p className={styles.note}>
              The naira sign prints as <strong>N</strong>, and halves as <strong>1/2</strong>: a
              thermal printer&apos;s built-in letters have neither ₦ nor ½, and printing a picture
              instead is what made it come out faint.
            </p>

            {escpos && (
              <>
                <Button
                  fullWidth
                  busy={busy}
                  busyLabel="Sending"
                  onClick={() => void send(asInstruction(lines), new TextEncoder().encode(''))}
                >
                  Print this sample
                </Button>
                <Button
                  variant="secondary"
                  fullWidth
                  busy={busy}
                  busyLabel="Sending"
                  onClick={() =>
                    void send(textTicket(store.name), testTicket(store.name))
                  }
                >
                  Print a short test
                </Button>
              </>
            )}

            {/* ── When the printer app opens and then refuses ───────────────── */}
            {printer.kind === 'ios_app' && (
              <>
                <h2 className={styles.section}>If nothing comes out</h2>
                <p className={styles.note}>
                  Try these in order. The first one that fails says where the problem is.
                </p>
                <Button variant="secondary" fullWidth onClick={() => void openPrinterAppWith(VENDOR_SAMPLE)}>
                  1. Print their sample image
                </Button>
                <Button
                  variant="secondary"
                  fullWidth
                  onClick={() => void openPrinterAppWith(textTicket(store.name))}
                >
                  2. Print plain text
                </Button>
              </>
            )}

            {note && (
              <p className={styles.note} role="status">
                {note}
              </p>
            )}

            {/* ── What every other device is set to ─────────────────────────── */}
            {(printers.data ?? []).filter((d) => d.deviceId !== deviceId()).length > 0 && (
              <>
                <h2 className={styles.section}>Your other devices</h2>
                <ul className={styles.devices}>
                  {(printers.data ?? [])
                    .filter((d) => d.deviceId !== deviceId())
                    .map((d) => (
                      <li key={d.deviceId} className={styles.device}>
                        {d.deviceLabel ?? 'A device'} —{' '}
                        {d.kind === 'usb'
                          ? `USB, ${d.printerName ?? 'a printer'}`
                          : d.kind === 'bluetooth'
                            ? `Bluetooth, ${d.printerName ?? 'a printer'}`
                            : d.kind === 'ios_app'
                              ? 'a printer app'
                              : 'its own print dialog'}
                        {' · '}
                        {d.widthMm}mm
                      </li>
                    ))}
                </ul>
              </>
            )}

            {!escpos && (
              <InfoPanel tone="info" title="This device prints through its own dialog">
                Sizes and the ruler only apply when the receipt goes to a thermal printer as text.
                A print dialog lays the page out itself.
              </InfoPanel>
            )}
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
