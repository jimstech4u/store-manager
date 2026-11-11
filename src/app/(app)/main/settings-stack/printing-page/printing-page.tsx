'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { ConfirmDialog, useConfirm } from '@/components/ui/Dialog';
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
import { paperLogo } from '@/lib/paper-logo';
import { Field } from '@/components/ui/Field';
import { getSupabase } from '@/lib/supabase/client';
import { LogoRejected, normaliseReceiptLogo } from '@/lib/image-pipeline';
import { useBankAccounts } from '@/lib/stacks/bank-accounts';
import { usePermission } from '@/hooks/usePermission';
import { autoPrintOn, useAutoPrint } from '@/lib/auto-print';
import { printRouteOf } from '@/lib/print-document';
import styles from './printing-page.module.css';

/**
 * A line of the receipt's words, saved when the person leaves the box — not on every key, which
 * wrote the row and re-read it per letter and could put back a letter typed while it was saving.
 */
function SavedText({
  label,
  value,
  placeholder,
  disabled,
  onSave,
}: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  onSave: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  return (
    <Field
      label={label}
      optional
      value={editing ? draft : value}
      placeholder={placeholder}
      disabled={disabled}
      onFocus={() => {
        setDraft(value);
        setEditing(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const next = draft.trim();
        if (next !== value.trim()) onSave(next === '' ? null : next);
      }}
    />
  );
}

/**
 * PRINTING — everything about it, on one page.
 *
 * "It seems too complex." It read as one long column of nine headings, the receipt's preview at the
 * very bottom, two rulers and nine sliders in the middle that only a printer engineer needs once.
 * Now: three cards that answer what a shop asks — which printer, what the receipt says, what
 * happens after a sale — with the receipt as it will print BESIDE them (under them on a phone),
 * logo and all. The ruler and the size of each part are folded under "Fine-tune": they still
 * matter, once, when a new printer arrives.
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
  const settings = useReceiptPaper(store?.id ?? null);

  const paperMm = Number(settings.data?.printer_width_mm) || 80;
  const printer = useThisPrinter(store?.id ?? null, paperMm);
  // Printing a sale by itself after a countdown — this device's choice (lib/auto-print).
  const { setting: auto, change: changeAuto } = useAutoPrint();
  const autoOn = autoPrintOn(auto, printRouteOf(printer));
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
  /*
   * REMOVING THE LOGO ASKS FIRST (11 Nov): it sat one tap from Change, and a shop's logo was gone from
   * every receipt with nothing to say it had happened. Mounted means asked.
   */
  const removeDialog = useConfirm();
  const [askRemove, setAskRemove] = useState(false);
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
      // The logo as every receipt now carries it — the preview is the paper, so it shows here too.
      logo: paperLogo(settings.data?.receipt_logo_path, settings.data?.receipt_logo_width_pct),
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

  const logoUrl = paperLogo(settings.data?.receipt_logo_path, 100)?.url ?? null;
  const preset = PRESET_WIDTHS.includes(Number(settings.data?.printer_width_mm));
  const kindName = (kind: PrinterKind) =>
    kind === 'usb' ? 'USB cable' : kind === 'bluetooth' ? 'Bluetooth' : kind === 'ios_app' ? 'Printer app' : "This device's dialog";

  return (
    <PageScaffold layout="record" onBack={goBack} title="Printing" subtitle="Your printer and your receipt">
      <PageState status={status}>
        {() => (
          <div className={styles.layout}>
            <div className={styles.settings}>
              {/* ── 1. The printer ─────────────────────────────────────────── */}
              <section className={styles.card} aria-labelledby="printer-head">
                <h2 id="printer-head" className={styles.cardTitle}>Printer on this device</h2>
                <p className={styles.status}>
                  {printer.printerName ? (
                    <>
                      <strong>{printer.printerName}</strong>
                      {' · '}
                      {printer.reconnecting ? 'looking for it…' : printer.ready ? 'connected' : 'not answering'}
                    </>
                  ) : (
                    <>Prints with <strong>{kindName(printer.kind)}</strong></>
                  )}
                </p>
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
                        <span className={styles.optionName}>{connecting === kind ? 'Connecting…' : kindName(kind)}</span>
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
                {escpos && (
                  <Button
                    variant="secondary"
                    fullWidth
                    busy={busy}
                    busyLabel="Sending"
                    onClick={() => void send(textTicket(store.name), testTicket(store.name))}
                  >
                    Print a short test
                  </Button>
                )}
                {printer.kind === 'ios_app' && (
                  <Explain label="Nothing comes out?">
                    <p>Try these in order. The first one that fails says where the problem is.</p>
                    <div className={styles.stack}>
                      <Button variant="secondary" fullWidth onClick={() => void openPrinterAppWith(VENDOR_SAMPLE)}>
                        1. Print their sample image
                      </Button>
                      <Button variant="secondary" fullWidth onClick={() => void openPrinterAppWith(textTicket(store.name))}>
                        2. Print plain text
                      </Button>
                    </div>
                    <p>The printer app is sent text, so the logo does not print this way.</p>
                  </Explain>
                )}
                {note && (
                  <p className={styles.note} role="status">
                    {note}
                  </p>
                )}
              </section>

              {/* ── 2. The receipt ─────────────────────────────────────────── */}
              {settings.data && (
                <section className={styles.card} aria-labelledby="receipt-head">
                  <h2 id="receipt-head" className={styles.cardTitle}>Your receipt</h2>
                  {!editable && <p className={styles.note}>Only the owner or a manager can change these.</p>}

                  <p className={styles.label}>Paper width</p>
                  <div className={styles.presets} role="group" aria-label="Paper width">
                    {PRESET_WIDTHS.map((w: number) => (
                      <button
                        key={w}
                        type="button"
                        className={`${styles.preset} ${Number(settings.data!.printer_width_mm) === w ? styles.presetActive : ''}`}
                        onClick={() => editable && void settings.patch({ printer_width_mm: String(w) })}
                        disabled={!editable}
                        aria-pressed={Number(settings.data!.printer_width_mm) === w}
                      >
                        {w}mm
                      </button>
                    ))}
                  </div>
                  {!preset && (
                    <Field
                      label="Other width"
                      numeric
                      suffix="mm"
                      value={settings.data.printer_width_mm}
                      onChange={(e) => void settings.patch({ printer_width_mm: e.target.value })}
                      disabled={!editable}
                      hint="Between 30 and 250."
                    />
                  )}

                  {/* The logo: what is on file, shown, with its size beside it. */}
                  <p className={styles.label}>Logo</p>
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
                        // Prepared at the head's own dots (8 per mm, less a margin): black and white, no resampling later.
                        const dots = Math.round(Number(settings.data!.printer_width_mm) * 8 * 0.9);
                        const { blob } = await normaliseReceiptLogo(file, { widthPx: dots });
                        const path = `${store.id}/store/receipt-logo-${Date.now().toString(36)}.png`;
                        const up = await getSupabase()
                          .storage.from('media')
                          .upload(path, blob, { contentType: 'image/png', upsert: true });
                        if (up.error) throw new Error(up.error.message);
                        void settings.patch({ receipt_logo_path: path });
                      } catch (err: unknown) {
                        setLogoError(err instanceof LogoRejected ? err.message : messageOf(err, 'That logo could not be used.'));
                      } finally {
                        setLogoBusy(false);
                      }
                    }}
                  />
                  <div className={styles.logoRow}>
                    <div className={styles.logoThumb}>
                      {logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- the shop's own uploaded picture
                        <img src={logoUrl} alt="Your logo" />
                      ) : (
                        <span>No logo</span>
                      )}
                    </div>
                    <div className={styles.logoActions}>
                      <Button variant="secondary" size="small" busy={logoBusy} disabled={!editable} onClick={() => logoInput.current?.click()}>
                        {logoUrl ? 'Change' : 'Add a logo'}
                      </Button>
                      {logoUrl && (
                        <Button variant="ghost" size="small" disabled={!editable} onClick={() => setAskRemove(true)}>
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                  {logoUrl && (
                    <label className={styles.measure}>
                      <span className={styles.measureName}>How wide on the paper</span>
                      <span className={styles.measureRow}>
                        <input
                          type="range"
                          min={20}
                          max={100}
                          step={5}
                          defaultValue={settings.data.receipt_logo_width_pct}
                          disabled={!editable}
                          // Saved where the thumb is let go, not on every step of the drag.
                          onPointerUp={(e) => void settings.patch({ receipt_logo_width_pct: Number(e.currentTarget.value) })}
                          onKeyUp={(e) => void settings.patch({ receipt_logo_width_pct: Number(e.currentTarget.value) })}
                          className={styles.slider}
                        />
                        <output className={styles.measureValue}>{settings.data.receipt_logo_width_pct}%</output>
                      </span>
                    </label>
                  )}
                  {!logoUrl && (
                    <p className={styles.sectionNote}>
                      A simple, wide mark prints best: it comes out in plain black and white.
                    </p>
                  )}
                  {logoError && (
                    <InfoPanel tone="warning" title="That picture will not print well">
                      {logoError}
                    </InfoPanel>
                  )}

                  <SavedText
                    label="Line under the name"
                    value={settings.data.receipt_header ?? ''}
                    placeholder="Address and phone number"
                    disabled={!editable}
                    onSave={(v) => void settings.patch({ receipt_header: v })}
                  />
                  <SavedText
                    label="Last line"
                    value={settings.data.receipt_footer ?? ''}
                    placeholder="Thank you for your patronage"
                    disabled={!editable}
                    onSave={(v) => void settings.patch({ receipt_footer: v })}
                  />

                  <label className={styles.toggle}>
                    <input
                      type="checkbox"
                      checked={settings.data.show_transfer_details}
                      onChange={(e) => void settings.patch({ show_transfer_details: e.target.checked })}
                      disabled={!editable}
                    />
                    <span>Bank details, for customers paying later</span>
                  </label>
                  {settings.data.show_transfer_details &&
                    (accounts.length === 0 ? (
                      <InfoPanel tone="warning" title="No accounts yet">
                        <p>Receipts can only show an account you have added.</p>
                        {canOpen('bank_form_page') && (
                          <Button onClick={() => void nav.push('bank_form_page')}>
                            <PlusIcon /> Add a bank account
                          </Button>
                        )}
                      </InfoPanel>
                    ) : (
                      <>
                        {/* Chosen from the shop's accounts, never typed again (0083). */}
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
                          <button type="button" className={styles.accountAdd} onClick={() => void nav.push('bank_form_page')}>
                            <PlusIcon /> Add another account
                          </button>
                        )}
                        <p className={styles.sectionNote}>Receipts already given keep the account they were printed with.</p>
                      </>
                    ))}
                </section>
              )}

              {/* ── 3. After a sale ────────────────────────────────────────── */}
              <section className={styles.card} aria-labelledby="after-head">
                <h2 id="after-head" className={styles.cardTitle}>After a sale is saved</h2>
                <p className={styles.note}>This device only: a counter by its printer can print every sale, a phone in a pocket none.</p>
                <div className={styles.grid} role="group" aria-label="Print the receipt by itself">
                  {[true, false].map((on) => (
                    <button
                      key={String(on)}
                      type="button"
                      className={`${styles.option} ${autoOn === on ? styles.optionOn : ''}`}
                      aria-pressed={autoOn === on}
                      onClick={() => changeAuto({ on })}
                    >
                      <span className={styles.optionName}>{on ? 'Print it by itself' : 'Only when I tap Print'}</span>
                      <span className={styles.optionWhat}>
                        {on ? 'After a short wait you can cancel.' : 'The receipt waits on the screen.'}
                      </span>
                    </button>
                  ))}
                </div>
                {autoOn && (
                  <>
                    <p className={styles.label}>Wait before printing</p>
                    <div className={styles.waits} role="group" aria-label="Wait before printing">
                      {([0, 3, 5, 10] as const).map((w) => (
                        <button
                          key={w}
                          type="button"
                          className={`${styles.option} ${auto.wait === w ? styles.optionOn : ''}`}
                          aria-pressed={auto.wait === w}
                          onClick={() => changeAuto({ wait: w })}
                        >
                          <span className={styles.optionName}>{w === 0 ? 'None' : `${w} s`}</span>
                        </button>
                      ))}
                    </div>
                    <div className={styles.grid} role="group" aria-label="After it prints">
                      {[false, true].map((till) => (
                        <button
                          key={String(till)}
                          type="button"
                          className={`${styles.option} ${auto.thenTill === till ? styles.optionOn : ''}`}
                          aria-pressed={auto.thenTill === till}
                          onClick={() => changeAuto({ thenTill: till })}
                        >
                          <span className={styles.optionName}>{till ? 'Back to the till' : 'Stay on the receipt'}</span>
                          <span className={styles.optionWhat}>{till ? 'Ready for the next customer.' : 'To share it or send it too.'}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {!autoOn && printRouteOf(printer) === 'browser' && auto.on === undefined && (
                  <p className={styles.note}>
                    Off for now: this device prints through its own print window, which would open after every sale.
                  </p>
                )}
              </section>

              {/* ── Fine-tuning, folded: needed once, when a new printer arrives ── */}
              {escpos && (
                <details className={styles.fine}>
                  <summary className={styles.fineSummary}>Fine-tune how it prints</summary>
                  <div className={styles.fineBody}>
                    <h3 className={styles.fineTitle}>Measure your printer</h3>
                    <p className={styles.note}>
                      Amounts line up on the right only when the app knows how many letters fit a line, and no printer can be
                      asked. Print the ruler, read the last number before the line wraps, and set it here.
                    </p>
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

                    <h3 className={styles.fineTitle}>How big each part prints</h3>
                    <div className={styles.parts}>
                      {PARTS.map((part) => {
                        const at = SIZES.findIndex((sz) => sz.size === live[part.key]);
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
                              onChange={(e) => void keep({ ...live, [part.key]: SIZES[Number(e.target.value)].size })}
                              className={styles.slider}
                            />
                          </label>
                        );
                      })}
                    </div>
                    <Button variant="secondary" fullWidth onClick={() => void keep(defaultLayout(dotsFor(paperMm)))}>
                      Put the sizes back to normal
                    </Button>
                  </div>
                </details>
              )}

              {(printers.data ?? []).filter((d) => d.deviceId !== deviceId()).length > 0 && (
                <section className={styles.card} aria-labelledby="devices-head">
                  <h2 id="devices-head" className={styles.cardTitle}>Your other devices</h2>
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
                </section>
              )}
            </div>

            {askRemove && (
              <ConfirmDialog
                controller={removeDialog}
                title="Take the logo off your receipts?"
                message="Every receipt, picture and PDF prints without it from now on. You can add it again any time."
                confirmText="Yes, take it off"
                onDismiss={() => setAskRemove(false)}
                onConfirm={() => {
                  setAskRemove(false);
                  void settings.patch({ receipt_logo_path: null });
                }}
              />
            )}

            {/* ── The receipt as it will print: beside the settings, under them on a phone ── */}
            <aside className={styles.previewCol} aria-labelledby="preview-head">
              <h2 id="preview-head" className={styles.cardTitle}>How a receipt comes out</h2>
              <PrintPreview lines={lines} layout={live} />
              <p className={styles.note}>
                ₦ prints as <strong>N</strong> and ½ as <strong>1/2</strong>: a thermal printer&apos;s own letters have neither.
              </p>
              {escpos && (
                <Button
                  fullWidth
                  busy={busy}
                  busyLabel="Sending"
                  onClick={() => void send(asInstruction(lines), new TextEncoder().encode(''))}
                >
                  Print this sample
                </Button>
              )}
            </aside>
          </div>
        )}
      </PageState>
    </PageScaffold>
  );
}
