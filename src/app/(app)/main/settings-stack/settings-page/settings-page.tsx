'use client';

import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { AppVersion } from '@/components/ui/AppVersion';
import { useReload } from '@/lib/stacks/resource';
import { ReceiptPreview } from '@/components/receipt/ReceiptPreview';
import { LogoRejected, normaliseReceiptLogo } from '@/lib/image-pipeline';
import { InstallApp } from '@/components/ui/InstallApp';
import { useInstallApp } from '@/hooks/useInstallApp';
import styles from './settings-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { CheckIcon, PlusIcon, RefreshIcon } from '@/components/ui/Icon';
import { useNav } from '@academix-admin/navigation-stack';
import { useDemandState } from '@academix-admin/state-stack';
import { SETTINGS_SCOPE, useBankAccounts } from '@/lib/stacks/bank-accounts';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useStackBack } from '@/hooks/useStackBack';
import { ROLE_DESCRIPTION, ROLE_LABEL } from '@/lib/permissions';
import { getSupabase } from '@/lib/supabase/client';
import {
  availableKinds,
  deviceId,
  forgetPrinter,
  savePrinter,
  usePrinters,
  useThisPrinter,
  type PrinterKind,
} from '@/lib/stacks/printer';
import { testTicket } from '@/lib/escpos';
import { printBytes } from '@/lib/bluetooth-print';
import { printBytesOverUsb } from '@/lib/usb-print';
import { PrintPreview } from '@/components/settings/PrintPreview';
import { columnsAt, type TextSize } from '@/lib/escpos-text';
import { dotsFor } from '@/lib/escpos';
import {
  openPrinterAppWith,
  removePrinted,
  textTicket,
  uploadForPrinting,
  VENDOR_SAMPLE,
} from '@/lib/print-handoff';
import { useTheme } from '@/context/ThemeContext';
import { NOTICE_NAMES, showNotice, useHiddenNotices } from '@/lib/hidden-notices';
import { messageOf } from '@/lib/format';

/** Common thermal roll widths, offered as shortcuts beside a free field — like a print dialog. */
const PRESET_WIDTHS = [40, 58, 80, 100];

interface StoreRow {
  is_public: boolean;
  public_description: string | null;
  code: string | null;
}

interface Settings {
  printer_width_mm: string;
  receipt_header: string | null;
  receipt_footer: string | null;
  /*
   * DEAD as of 0083 — the receipt reads the shop's accounts through `receipt_bank_account_id`.
   * Still selected so an existing row round-trips unchanged; nothing writes them.
   */
  transfer_bank_name: string | null;
  transfer_account_no: string | null;
  transfer_account_name: string | null;
  /** Which of the shop's accounts prints. Null means whichever is marked default. */
  receipt_bank_account_id: string | null;
  show_transfer_details: boolean;
  receipt_logo_path: string | null;
  receipt_logo_width_pct: number;
  /** How long after "Not now" a waiting app update asks again, in minutes (0158). */
  update_reminder_minutes: number;
}

/** What the shop can choose from. Minutes, so a fifth is a number rather than a migration. */
const REMIND_AFTER: { minutes: number; label: string }[] = [
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 240, label: 'Every 4 hours' },
  { minutes: 720, label: 'Twice a day' },
];

/**
 * Store settings — role-gated, and stored in the database rather than on the device.
 *
 * A shop's configuration belongs to the shop. Staff change phones, phones get replaced, and
 * re-entering the printer width and bank details on every new device is exactly the friction
 * that makes people stop using a tool.
 *
 * The role gate is enforced in RLS as well as here: hiding a control is a courtesy to the user,
 * never a security measure. A staff member who reached this screen and submitted anyway would be
 * refused by the database.
 */
export default function SettingsPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store, stores, selectStore, user, signOut } = useAuth();
  const router = useRouter();
  /** Which shop is being switched to, so the row can say so and the rest cannot be tapped. */
  const [switching, setSwitching] = useState<string | null>(null);

  /*
   * Switching empties the previous shop's cached data first — that is what makes the wait real and
   * worth showing. Afterwards the till is the right place to land: it is the screen this app is
   * for, and staying on Settings under a new shop's name invites reading the previous shop's
   * settings as the new one's.
   */
  const switchTo = async (id: string) => {
    if (id === store?.id) return;
    setSwitching(id);
    try {
      await selectStore(id);
      router.push('/main');
    } finally {
      setSwitching(null);
    }
  };
  const { can, canOpen, role } = usePermission();
  const { theme, storedTheme, setTheme } = useTheme();
  const hiddenNotices = useHiddenNotices();


  const accounts = useBankAccounts(store?.id ?? null);


  // The logo picker's hidden input, and the state around preparing one.
  const logoInput = useRef<HTMLInputElement | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  /*
   * All three of this page's reads in one state-stack entry.
   *
   * This is the settings tab's ROOT, and every row on it pushes: bank accounts, staff, the review
   * queue, the storefront. Each of the three used to be its own `useState` filled by its own
   * effect, which meant every trip back rebuilt the whole screen from nothing — the printer width
   * reverted to its placeholder, the "waiting for you" count blanked, and the public-shop toggle
   * flicked off and back on. A settings screen whose switches move by themselves is one nobody
   * trusts to have saved anything.
   *
   * One entry rather than three because they are read together and shown together; three keys
   * would just be three chances to draw a half-built page.
   */
  const [snapshot, demand, setSnapshot] = useDemandState<{
    settings: Settings | null;
    shop: StoreRow | null;
    pending: number;
    error: string | null;
  }>(
    { settings: null, shop: null, pending: 0, error: null },
    {
      key: `settings:${store?.id ?? 'none'}`,
      scope: SETTINGS_SCOPE,
      persist: true,
      deps: [store?.id ?? ''],
      revalidateOnMount: false,
    },
  );

  const settings = snapshot.settings;

  /*
   * WHICH PRINTER THIS DEVICE USES, and every device the shop has set up.
   *
   * Per device and synced: the counter iPad reaches a Bluetooth roll, the back-office laptop has a
   * USB printer and a driver, a seller's phone has neither. One setting on the shop would be wrong
   * on two of those three — and a setting kept only in the browser means a replaced phone is set up
   * from scratch and nobody can see what the counter was pointing at.
   */
  const printer = useThisPrinter(store?.id ?? null, Number(settings?.printer_width_mm) || undefined);
  const printers = usePrinters(store?.id ?? null);
  const [kinds, setKinds] = useState<PrinterKind[]>([]);
  useEffect(() => setKinds(availableKinds()), []);
  const [connecting, setConnecting] = useState<PrinterKind | null>(null);
  const [printerNote, setPrinterNote] = useState<string | null>(null);
  const [testingApp, setTestingApp] = useState(false);

  /*
   * A RECEIPT TO LOOK AT, in the shape a real one takes.
   *
   * Made up, and deliberately made up of the awkward cases rather than the easy ones: a product name
   * long enough to wrap, a quantity that is not a whole number, an amount wide enough to crowd its
   * label, containers still out, and bank details. A preview built from a tidy example tells a shop
   * nothing about the receipt that will actually give them trouble.
   */
  const samplePrint = useMemo(
    () => ({
      shopName: store?.name ?? 'Your shop',
      header: settings?.receipt_header ?? null,
      footer: settings?.receipt_footer ?? null,
      meta: [
        new Date().toLocaleString(),
        '#2D6AB81C',
        'Gabriel',
      ],
      lines: [
        { name: 'Gulder 60cl', detail: '0.5 Crate x \u20a69,600', amount: '\u20a64,800' },
        {
          name: 'American Cola PET 60cl',
          detail: '20 Bottle x \u20a63,700',
          amount: '\u20a674,000',
        },
      ],
      totals: [
        { label: 'Total', value: '\u20a678,800', strong: true },
        { label: 'Left on this sale', value: '\u20a678,800' },
        { label: 'Owed before', value: '\u20a694,200' },
        { label: 'Total owed', value: '\u20a6173,000', strong: true },
        { label: 'Still with you', value: '', strong: true },
        { label: 'Nigerian Breweries (NBL) crates', value: '5' },
        { label: 'Goldberg 60cl crate', value: '\u00bd' },
      ],
      note: null,
      /*
       * The bank block as the receipt builds it — the three fields on their own lines, and only
       * when the shop has asked for them. A preview that always shows bank details would have a
       * shop laying out paper for a block that never prints.
       */
      transferDetails:
        settings?.show_transfer_details
          ? [
              settings.transfer_bank_name,
              settings.transfer_account_no,
              settings.transfer_account_name,
            ]
              .filter(Boolean)
              .join(String.fromCharCode(10)) || null
          : null,
    }),
    [
      store?.name,
      settings?.receipt_header,
      settings?.receipt_footer,
      settings?.show_transfer_details,
      settings?.transfer_bank_name,
      settings?.transfer_account_no,
      settings?.transfer_account_name,
    ],
  );

  /*
   * Which account prints — resolved the same way `settle_sale` resolves it, so the preview and the
   * receipt cannot disagree: the chosen one, or the shop's default when nothing has been chosen.
   *
   * BELOW `settings`, not beside `accounts`. Above it, this is a temporal dead zone that only fires
   * once the list is non-empty, because the reference sits inside a `.find` callback — so the page
   * worked until the shop added its first account and then white-screened.
   */
  const receiptAccount =
    accounts.find((a) => a.id === settings?.receipt_bank_account_id) ??
    accounts.find((a) => a.is_default) ??
    null;
  const shop = snapshot.shop;
  const pending = snapshot.pending;
  const error = snapshot.error;

  const setSettings = (next: Settings | null | ((prev: Settings | null) => Settings | null)) => {
    setSnapshot((prev) => ({
      ...prev,
      settings: typeof next === 'function' ? next(prev.settings) : next,
    }));
  };
  const setShop = (next: StoreRow | null) => {
    setSnapshot((prev) => ({ ...prev, shop: next }));
  };
  const saveProblem = useProblem();
  // Bound to a local const: `useProblem` returns a fresh object every render, so the hook itself is
  // never a safe dependency — `show` is.
  const showSaveProblem = saveProblem.show;

  const setError = (next: string | null) => {
    setSnapshot((prev) => ({ ...prev, error: next }));
  };

  /*
   * The latest snapshot, readable from the loader without becoming a dependency of it.
   *
   * The loader's failure path wants to keep what was already cached. Reading `snapshot` directly
   * would put it in the effect's deps, and since the loader writes the snapshot, that is a loop
   * that refetches the settings page forever.
   */
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const canConfirm = can('records.confirm');

  const load = useCallback(() => {
    if (!store) return;
    demand(async ({ set }) => {
      const supabase = getSupabase();
      const [own, review, shopRow] = await Promise.all([
        supabase.rpc('ensure_store_settings', { p_store_id: store.id }),
        // A count on the button, not just a label. "Waiting for you" with no number gives no
        // reason to tap it; "3 waiting" does. Skipped entirely for a member who cannot approve.
        canConfirm
          ? supabase.rpc('pending_review', { p_store_id: store.id })
          : Promise.resolve({ data: null }),
        // The public storefront row lives on `stores`, not `store_settings`.
        supabase
          .from('stores')
          .select('is_public, public_description, code')
          .eq('id', store.id)
          .maybeSingle(),
      ]);

      if (own.error) {
        // Keep whatever was cached and say why it did not refresh. A settings screen that
        // empties itself on a failed read looks like a shop with no settings.
        set({ ...snapshotRef.current, error: own.error.message }, { override: true });
        return;
      }

      const row = (Array.isArray(own.data) ? own.data[0] : own.data) as Settings;
      const q = review.data as
        | { products: unknown[]; customers: unknown[]; stock_entries: unknown[] }
        | null;
      // A failed count is not "nothing waiting", and a failed storefront read is not "not listed":
      // each keeps what it last knew.
      const reviewFailed = 'error' in review && Boolean(review.error);

      set(
        {
          // Defaulted here as well as in the column: a settings row written before 0046 comes back
          // with null, and a null width would render the logo at zero and look like a broken
          // upload.
          settings: {
            ...row,
            receipt_logo_width_pct: row.receipt_logo_width_pct ?? 60,
            update_reminder_minutes: row.update_reminder_minutes ?? 30,
          },
          shop: shopRow.error
            ? snapshotRef.current.shop
            : ((shopRow.data as StoreRow | null) ?? null),
          pending: reviewFailed
            ? snapshotRef.current.pending
            : q
              ? q.products.length + q.customers.length + q.stock_entries.length
              : 0,
          error: null,
        },
        { override: true },
      );
    });
  }, [store, canConfirm, demand]);

  useEffect(load, [load]);

  // Try again READS: `demand` skips a key it has already served.
  const reload = useReload(SETTINGS_SCOPE, `settings:${store?.id ?? 'none'}`, load);

  const saveShop = async (next: Partial<StoreRow>) => {
    if (!store || !shop) return;
    const merged = { ...shop, ...next };
    setShop(merged);

    // Turning the storefront on needs a code for people to find it by.
    if (merged.is_public && !merged.code) {
      const { data } = await getSupabase().rpc('ensure_store_code', { p_store_id: store.id });
      if (data) merged.code = data as string;
      setShop({ ...merged });
    }

    await getSupabase()
      .from('stores')
      .update({ is_public: merged.is_public, public_description: merged.public_description })
      .eq('id', store.id);
  };

  const patch = (next: Partial<Settings>) =>
    setSettings((prev) => (prev ? { ...prev, ...next } : prev));

  const save = async () => {
    if (!store || !settings) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const { error: err } = await getSupabase()
        .from('store_settings')
        .update({
          printer_width_mm: Number(settings.printer_width_mm) || 80,
          receipt_header: settings.receipt_header,
          receipt_footer: settings.receipt_footer,
          // The three text columns are no longer written — the receipt reads the accounts list.
          receipt_bank_account_id: settings.receipt_bank_account_id,
          show_transfer_details: settings.show_transfer_details,
          receipt_logo_path: settings.receipt_logo_path,
          receipt_logo_width_pct: settings.receipt_logo_width_pct,
          update_reminder_minutes: settings.update_reminder_minutes,
        })
        .eq('store_id', store.id);
      if (err) throw err;
      setSaved(true);
    } catch (e: unknown) {
      /*
        A FAILURE INTERRUPTS. This set the same `error` the LOAD failure uses, so a save that failed
        appeared under the heading "Could not load your settings" — near the top of a long page,
        already scrolled past by anyone who pressed Save at the bottom. Nothing changes, so Save
        gets pressed again.
      */
      showSaveProblem(messageOf(e, 'Could not save your settings'));
    } finally {
      setBusy(false);
    }
  };

  if (!store) return null;
  // One header; the body waits for the shop's settings.
  // A first read that failed used to fall through to "ready" and draw the form with nothing in it.
  const status: PageStatus = settings
    ? { state: 'ready' }
    : error
      ? { state: 'error', what: 'your settings', error, onRetry: reload }
      : { state: 'loading', what: 'your settings' };

  const editable = can('store.settings');

  return (
    <PageScaffold
      onBack={goBack}
      title="Settings"
      subtitle={store.name}
      /*
       * Saving is a header action now.
       *
       * It was a bar pinned to the foot of a long scrolling form, which meant it sat on top of
       * whatever field was being edited at the bottom of the screen. In the header it is in the
       * same place whatever the form is doing, and it can show its own busy state.
       */
      actions={
        editable
          ? [
              {
                key: 'save',
                icon: busy ? <RefreshIcon /> : <CheckIcon />,
                onClick: save,
                ariaLabel: busy ? 'Saving your settings' : 'Save settings',
              },
            ]
          : undefined
      }
    >
      <PageState status={status}>
        {() =>
          (
            <>
      <ProblemDialog problem={saveProblem} title="Not saved" />

      {/* The LOAD failure stays a panel: there is cached content behind it, and it describes the
          state the page is in rather than something that was just attempted. */}
      {error && (
        <InfoPanel tone="danger" title="Could not refresh your settings">
          {error}{' '}
          <Button variant="secondary" size="small" onClick={reload}>
            Try again
          </Button>
        </InfoPanel>
      )}
      {saved && (
        <InfoPanel tone="success" title="Saved">
          Everyone in this shop will see these settings, on any device.
        </InfoPanel>
      )}

      {/*
        ON THE PHONE ITSELF — for everybody, not just the owner.

        A seller reaching the till through a browser tab is the one thing that makes this feel like
        a website. `InstallApp` draws nothing once it is installed, so this section disappears the
        moment it has done its job.
      */}
      <InstallSection />

      {/*
        HOW OFTEN A WAITING UPDATE ASKS AGAIN.

        A new version announces itself and waits, because taking over mid-sale swaps the code under
        somebody serving a customer. "Not now" therefore has to be a real answer — and an answer
        never asked again is how a shop ends up running a version from March.
      */}
      {settings && (
        <>
          <h2 className={styles.section}>Remind me about updates</h2>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="update-reminder">
              After &ldquo;Not now&rdquo;, ask again
            </label>
            <select
              id="update-reminder"
              className={styles.select}
              value={String(settings.update_reminder_minutes)}
              disabled={!editable}
              onChange={(e) => patch({ update_reminder_minutes: Number(e.target.value) })}
            >
              {REMIND_AFTER.map((r) => (
                <option key={r.minutes} value={r.minutes}>
                  {r.label}
                </option>
              ))}
            </select>
            <p className={styles.sectionNote}>
              An update is never taken while you are in the middle of something — it waits to be let
              in, and comes with the next launch anyway.
            </p>
          </div>

          {/*
            RUNNING LOW LIVES ON ITS OWN PAGE NOW, and this is the signpost to it.

            It was a single box here, and that was only half the setting: the other half is the list
            of items that are different, and there was nowhere to see those at all. A shop that had
            set five exceptions over three months could not find out which five.

            The signpost stays because a shop looking for "tell me when I am running out" looks in
            Settings first, whatever page it ended up on. Removing the field and leaving nothing
            would have made a working feature look deleted.
          */}
          <h2 className={styles.section}>Running low</h2>
          <Button
            variant="secondary"
            fullWidth
            onClick={() => void nav.push('low_stock_page')}
          >
            When to be told stock is running out
          </Button>
          <p className={styles.sectionNote}>
            One level for everything you sell, and the items you want treated differently.
          </p>

          <h2 className={styles.section}>Money</h2>
          <button
            type="button"
            className={styles.linkRow}
            onClick={() => nav.push('bank_page')}
          >
            <span className={styles.linkMain}>
              <span className={styles.linkName}>Bank accounts</span>
              <span className={styles.sectionNote}>
                Where customers transfer money, and which one the counter offers first
              </span>
            </span>
          </button>

          {/*
            THE POOLS, AND WHAT IS HELD AGAINST THEM.

            "NBL crate" holds N1,500 in this shop and "NBL bottle" N125. Both were put there by a
            migration and nothing could change either: `save_empties_category` was written in 0082
            for a screen nobody built, and it edits only — so there was no way to make the first
            pool either. Under Money because a deposit is money the shop is holding.
          */}
          {/*
            THE SHOP'S OWN VOCABULARY.

            `create_store_unit` existed and the app called it; nothing renamed one and nothing put
            one away, so a shop that typed "Crat" had it on every product measured in it, every
            receipt they print, and every picker — the most visible text a shop owns and the only
            piece it could not fix.
          */}
          {/*
            THE SHOP'S OWN ROW.

            Everything under here corrects something the shop named — its words, its pools, its
            people. The one thing it could not correct was itself: the name was fixed at signup for
            ever, and a shop created by a mistyped name could never be closed, so it sat in the
            switcher and, having no `onboarded_at`, answered sign-in with a setup wizard.
          */}
          {canOpen('shop_page') && (
            <button
              type="button"
              className={styles.linkRow}
              onClick={() => nav.push('shop_page')}
            >
              <span className={styles.linkMain}>
                <span className={styles.linkName}>This shop</span>
                <span className={styles.sectionNote}>
                  Its name on your receipts, where it is, and closing one you did not mean to make
                </span>
              </span>
            </button>
          )}

          {canOpen('words_page') && (
            <button
              type="button"
              className={styles.linkRow}
              onClick={() => nav.push('words_page')}
            >
              <span className={styles.linkMain}>
                <span className={styles.linkName}>Words you measure in</span>
                <span className={styles.sectionNote}>
                  Crate, bottle, dirica, paint — correct one here and it changes everywhere
                </span>
              </span>
            </button>
          )}

        </>
      )}

      {/*
        CUSTOMERS, as a section rather than a tab.

        The People tab was a list somebody opens to look somebody up — a reference, not a job — and
        it was spending a sixth of the nav bar on that. Every way INTO a customer that matters is
        already elsewhere: the till attaches one, Money lists who owes, a receipt names one. So the
        list itself belongs with the other things a shop keeps rather than does.
      */}
      {can('customers.manage') && (
        <>
          <h2 className={styles.section}>Customers</h2>
          <button
            type="button"
            className={styles.linkRow}
            onClick={() => nav.push('people_page')}
          >
            <span className={styles.linkMain}>
              <span className={styles.linkName}>Everyone you sell to</span>
              <span className={styles.sectionNote}>
                Their balances, the containers they are holding, and what they have bought
              </span>
            </span>
          </button>
        </>
      )}

      {can('staff.manage') && (
        <>
          <h2 className={styles.section}>Your team</h2>
          <button
            type="button"
            className={styles.linkRow}
            onClick={() => nav.push('staff_page')}
          >
            <span className={styles.linkMain}>
              <span className={styles.linkName}>People who work here</span>
              <span className={styles.sectionNote}>
                Add staff, set what each of them can do, remove someone who has left
              </span>
            </span>
          </button>

          {/*
            WHAT STAFF OWE, which a count can write and nothing could reach.
            Its own row rather than a tab on the staff screen: "who works here" and "who owes for
            missing stock" are different questions, and one of them is asked far less often.
          */}
          {canOpen('staff_charges_page') && (
            <button
              type="button"
              className={styles.linkRow}
              onClick={() => nav.push('staff_charges_page')}
            >
              <span className={styles.linkMain}>
                <span className={styles.linkName}>What staff owe</span>
                <span className={styles.sectionNote}>
                  Stock or cash that went missing on somebody&rsquo;s watch, and what has been paid
                  back
                </span>
              </span>
            </button>
          )}
        </>
      )}

      {can('records.confirm') && (
        <>
          <h2 className={styles.section}>Checks</h2>
          <button
            type="button"
            className={styles.linkRow}
            onClick={() => nav.push('review_page')}
          >
            <span className={styles.linkMain}>
              <span className={styles.linkName}>Things waiting for you</span>
              <span className={styles.sectionNote}>
                Products, customers and stock your staff added while serving customers
              </span>
            </span>
            {pending > 0 && <span className={styles.badge}>{pending}</span>}
          </button>
        </>
      )}

      {!editable && (
        <InfoPanel tone="info" title="You can look, but not change these">
          Shop settings are changed by the owner. You are signed in as{' '}
          {ROLE_LABEL[role ?? 'staff']}.
        </InfoPanel>
      )}

      {settings && (
        <>
          <h2 className={styles.section}>Receipt printer</h2>

          <div className={styles.presets}>
            {PRESET_WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                className={`${styles.preset} ${
                  Number(settings.printer_width_mm) === w ? styles.presetActive : ''
                }`}
                onClick={() => editable && patch({ printer_width_mm: String(w) })}
                disabled={!editable}
                aria-pressed={Number(settings.printer_width_mm) === w}
              >
                {w}mm
              </button>
            ))}
          </div>

          <Field
            label="Paper width"
            numeric
            suffix="mm"
            value={settings.printer_width_mm}
            onChange={(e) => patch({ printer_width_mm: e.target.value })}
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
            value={settings.receipt_header ?? ''}
            onChange={(e) => patch({ receipt_header: e.target.value })}
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
                  const dots = Math.round(Number(settings.printer_width_mm) * 8 * 0.9);
                  const { blob } = await normaliseReceiptLogo(file, { widthPx: dots });

                  const path = `${store.id}/store/receipt-logo-${Date.now().toString(36)}.png`;
                  const up = await getSupabase()
                    .storage.from('media')
                    .upload(path, blob, { contentType: 'image/png', upsert: true });
                  if (up.error) throw new Error(up.error.message);

                  patch({ receipt_logo_path: path });
                } catch (err) {
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
                {settings.receipt_logo_path ? 'Change logo' : 'Add a logo'}
              </Button>
              {settings.receipt_logo_path && (
                <Button
                  variant="ghost"
                  disabled={!editable}
                  onClick={() => patch({ receipt_logo_path: null })}
                >
                  Remove it
                </Button>
              )}
            </div>

            <p className={styles.sectionNote}>
              A wide picture works best — roughly three times as wide as it is tall, and at least
              {' '}{Math.round(Number(settings.printer_width_mm) * 8 * 0.45)} pixels across. It is
              printed in plain black and white, so a simple mark reads better than a photograph.
            </p>

            {logoError && (
              <InfoPanel tone="warning" title="That picture will not print well">
                {logoError}
              </InfoPanel>
            )}

            {settings.receipt_logo_path && (
              <Field
                label="How wide on the paper"
                numeric
                suffix="%"
                value={String(settings.receipt_logo_width_pct)}
                onChange={(e) =>
                  patch({ receipt_logo_width_pct: Number(e.target.value) || 60 })
                }
                disabled={!editable}
                hint="A share of the paper width, so it stays right if you change printers."
              />
            )}
          </div>

          <Field
            label="Line at the bottom"
            optional
            value={settings.receipt_footer ?? ''}
            onChange={(e) => patch({ receipt_footer: e.target.value })}
            disabled={!editable}
            placeholder="Thank you for your patronage"
          />

          {/* Everything above, as it will print. Shown before the bank details so a mistake in
              the header or the logo is caught here rather than by a customer. */}
          <ReceiptPreview
            widthMm={Number(settings.printer_width_mm) || 80}
            header={settings.receipt_header}
            footer={settings.receipt_footer}
            logoPath={settings.receipt_logo_path}
            logoWidthPct={settings.receipt_logo_width_pct}
            shopName={store?.name ?? 'Your shop'}
            /*
              THE ACCOUNT THAT WILL ACTUALLY PRINT.

              This read the three text columns 0083 retired, so the preview would have shown a blank
              where the receipt shows an account — and the preview is exactly where somebody checks
              instead of printing one to find out. Same resolution the receipt uses: the chosen
              account, or failing that the one marked default.
            */
            transfer={
              settings.show_transfer_details && receiptAccount
                ? [
                    receiptAccount.bank_name,
                    receiptAccount.account_number,
                    receiptAccount.account_name,
                  ]
                    .filter(Boolean)
                    .join('\n')
                : null
            }
          />

          <h2 className={styles.section}>Bank details on receipts</h2>
          <p className={styles.sectionNote}>
            Printed on receipts so a customer paying later knows where to send the money.
          </p>

          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={settings.show_transfer_details}
              onChange={(e) => patch({ show_transfer_details: e.target.checked })}
              disabled={!editable}
            />
            <span>Show my bank details on receipts</span>
          </label>

          {settings.show_transfer_details && (
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
                        settings.receipt_bank_account_id === a.id ||
                        (!settings.receipt_bank_account_id && a.is_default);
                      return (
                        <li key={a.id}>
                          <button
                            type="button"
                            className={`${styles.accountRow} ${chosen ? styles.accountChosen : ''}`}
                            disabled={!editable}
                            onClick={() => patch({ receipt_bank_account_id: a.id })}
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
          <h2 className={styles.section}>Public storefront</h2>
          <p className={styles.sectionNote}>
            Off by default. Your prices and what you sell are your own business — turn this on
            only if you want shoppers to find you.
          </p>

          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={shop.is_public}
              onChange={(e) => void saveShop({ is_public: e.target.checked })}
            />
            <span>List my shop publicly</span>
          </label>

          {shop.is_public && (
            <>
              <Field
                label="A line about your shop"
                optional
                value={shop.public_description ?? ''}
                onChange={(e) => setShop({ ...shop, public_description: e.target.value })}
                onBlur={() => void saveShop({})}
                placeholder="Drinks and provisions, wholesale and retail"
              />
              <InfoPanel tone="info" title={`Your shop code is ${shop.code ?? '…'}`}>
                Give this to customers. They can open{' '}
                <strong>/s/{shop.code ?? 'CODE'}</strong> to see what you sell.
                <Explain label="What do shoppers see?">
                  Your shop name, what you sell, your selling prices, any bulk prices, and whether
                  something is in stock. They never see what you paid for anything, how much you
                  hold, your customers, or who owes you.
                </Explain>
              </InfoPanel>
            </>
          )}
        </>
      )}

      <h2 className={styles.section}>This device</h2>

      <div className={styles.themeRow} role="group" aria-label="Appearance">
        {(['light', 'dark', 'system'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`${styles.preset} ${storedTheme === t ? styles.presetActive : ''}`}
            onClick={() => setTheme(t)}
            aria-pressed={storedTheme === t}
          >
            {t === 'system' ? 'Follow phone' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <p className={styles.sectionNote}>
        Currently showing {theme}. This is per device, not shared with your staff.
      </p>

      {/*
        ─── HOW THIS DEVICE PRINTS ────────────────────────────────────────────────

        Under "This device" because that is what it is. The paper width above is the SHOP's, because
        it describes the roll a shop buys; which cable or radio reaches the printer describes the
        counter, and those are different facts with different right answers.

        WHAT SYNCS AND WHAT CANNOT. The choice syncs — this device prints over USB to "XP-58". The
        browser's handle on the device cannot: permission is granted to an origin for a device and
        the handle is re-acquired, never stored. Both `usb.getDevices()` and, in newer Chrome,
        `bluetooth.getDevices()` hand back already-permitted devices with no prompt, so after the
        first pairing the reconnect is invisible. That is the whole difference between a printer that
        works and one somebody sets up every morning.
      */}
      <h3 className={styles.subsection}>Printing from this device</h3>

      {printer.choice ? (
        <p className={styles.sectionNote}>
          {printer.kind === 'usb' || printer.kind === 'bluetooth' ? (
            <>
              Set to print{printer.kind === 'usb' ? ' over the cable' : ' over Bluetooth'} to{' '}
              <strong>{printer.choice.printerName ?? 'a printer'}</strong>.{' '}
              {printer.reconnecting
                ? 'Looking for it…'
                : printer.ready
                  ? 'Connected — one tap prints.'
                  : 'Not answering right now. Receipts will print the ordinary way until it is back.'}
            </>
          ) : printer.kind === 'ios_app' ? (
            <>
              Receipts go to your printer&apos;s own app. iPhones and iPads cannot reach a Bluetooth
              printer from a web page at all — this is the way round it.
            </>
          ) : (
            <>Receipts use this device&apos;s own print dialog.</>
          )}
        </p>
      ) : (
        <p className={styles.sectionNote}>
          Nothing set up yet, so receipts print whatever way this device normally would. Connect the
          printer once and a receipt is one tap from then on.
        </p>
      )}

      {/*
        A REAL SWITCH, not four pills at `flex: 1`.

        It reused the theme row first, which is three short words. Four options with labels like
        "This device's dialog" came out squashed and unreadable on a 390px phone — reported from one.
        A control whose state you cannot read is a control nobody trusts, so: a two-column grid, each
        card saying what it is and what it means.
      */}
      <div className={styles.printerChoice} role="group" aria-label="How this device prints">
        {kinds.includes('usb') && (
          <button
            type="button"
            className={`${styles.printerOption} ${printer.kind === 'usb' ? styles.printerOptionActive : ''}`}
            aria-pressed={printer.kind === 'usb'}
            disabled={connecting !== null}
            onClick={async () => {
              setConnecting('usb');
              setPrinterNote(null);
              try {
                await printer.connect('usb');
                setPrinterNote('Connected over USB. It will reconnect by itself from now on.');
                await printers.reload();
              } catch (e: unknown) {
                /*
                 * Closing the chooser is a decision, not a failure. Reporting it as an error trains
                 * people to ignore the messages that matter.
                 */
                const m = messageOf(e, 'Could not connect that printer');
                if (!/cancell?ed|no device selected|chooser/i.test(m)) setPrinterNote(m);
              } finally {
                setConnecting(null);
              }
            }}
          >
            <span className={styles.printerOptionName}>
              {connecting === 'usb' ? 'Connecting…' : 'USB cable'}
            </span>
            <span className={styles.printerOptionWhat}>Straight to the roll. Most reliable.</span>
          </button>
        )}

        {kinds.includes('bluetooth') && (
          <button
            type="button"
            className={`${styles.printerOption} ${printer.kind === 'bluetooth' ? styles.printerOptionActive : ''}`}
            aria-pressed={printer.kind === 'bluetooth'}
            disabled={connecting !== null}
            onClick={async () => {
              setConnecting('bluetooth');
              setPrinterNote(null);
              try {
                await printer.connect('bluetooth');
                setPrinterNote('Connected over Bluetooth.');
                await printers.reload();
              } catch (e: unknown) {
                const m = messageOf(e, 'Could not connect that printer');
                if (!/cancell?ed|no device selected|chooser/i.test(m)) setPrinterNote(m);
              } finally {
                setConnecting(null);
              }
            }}
          >
            <span className={styles.printerOptionName}>
              {connecting === 'bluetooth' ? 'Connecting…' : 'Bluetooth'}
            </span>
            <span className={styles.printerOptionWhat}>Straight to a paired roll.</span>
          </button>
        )}

        {kinds.includes('ios_app') && (
          <button
            type="button"
            className={`${styles.printerOption} ${printer.kind === 'ios_app' ? styles.printerOptionActive : ''}`}
            aria-pressed={printer.kind === 'ios_app'}
            onClick={async () => {
              if (!store) return;
              setPrinterNote(null);
              try {
                await savePrinter(store.id, {
                  kind: 'ios_app',
                  deviceLabel: printer.choice?.deviceLabel ?? null,
                  printerName: null,
                  widthMm: printer.widthMm,
                  usbVendorId: null,
                  usbProductId: null,
                  btDeviceId: null,
                  textSize: printer.textSize,
                });
                await printers.reload();
                await printer.reload();
              } catch (e: unknown) {
                setPrinterNote(messageOf(e, 'Could not save that'));
              }
            }}
          >
            <span className={styles.printerOptionName}>Printer app</span>
            <span className={styles.printerOptionWhat}>
              For iPhone and iPad, which cannot reach a printer themselves.
            </span>
          </button>
        )}

        <button
          type="button"
          className={`${styles.printerOption} ${printer.kind === 'browser' ? styles.printerOptionActive : ''}`}
          aria-pressed={printer.kind === 'browser'}
          onClick={async () => {
            if (!store) return;
            setPrinterNote(null);
            try {
              await forgetPrinter(store.id);
              await printers.reload();
              await printer.reload();
              setPrinterNote('This device will use its own print dialog.');
            } catch (e: unknown) {
              setPrinterNote(messageOf(e, 'Could not save that'));
            }
          }}
        >
          <span className={styles.printerOptionName}>This device&apos;s dialog</span>
          <span className={styles.printerOptionWhat}>
            The normal print window. Right where there is a driver.
          </span>
        </button>
      </div>

      {/*
        ─── WHEN THE PRINTER APP OPENS AND THEN REFUSES ──────────────────────────

        This happened on the first real phone: Print opened Mobile Print Util, which said "there is
        an issue with your device connection" — while printing a test page from inside that same app
        worked. "It opened" and "it printed" are different facts and nothing on our side can see the
        second one.

        Guessing at that over messages costs a day. These try the parts SEPARATELY, so one tap each
        says where it breaks:

          · their own sample image — if this fails, the app or the printer is at fault, not us
          · plain text             — no download for the app to do, so it isolates the fetch
          · our image              — the real path, in the same shape a receipt takes

        The order matters: whichever is the first to fail is the answer.
      */}
      {printer.kind === 'ios_app' && (
        <div className={styles.diagnostic}>
          <p className={styles.diagnosticWhy}>
            If Print opens the app but nothing comes out, try these in order. The first one that
            fails says where the problem is.
          </p>
          <Button
            variant="secondary"
            fullWidth
            onClick={() => void openPrinterAppWith(VENDOR_SAMPLE)}
          >
            1. Print their sample image
          </Button>
          <Button
            variant="secondary"
            fullWidth
            onClick={() => void openPrinterAppWith(textTicket(store?.name ?? 'This shop'))}
          >
            2. Print plain text (no download)
          </Button>
          <Button
            variant="secondary"
            fullWidth
            busy={testingApp}
            busyLabel="Preparing"
            onClick={async () => {
              if (!store) return;
              setTestingApp(true);
              setPrinterNote(null);
              try {
                const canvas = document.createElement('canvas');
                canvas.width = 384;
                canvas.height = 160;
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('Could not draw a test');
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = '#000';
                ctx.font = 'bold 28px sans-serif';
                ctx.fillText('Printer test', 20, 60);
                ctx.font = '20px sans-serif';
                ctx.fillText(store.name.slice(0, 24), 20, 100);
                ctx.fillText(new Date().toLocaleTimeString(), 20, 135);

                const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/png'));
                if (!blob) throw new Error('Could not draw a test');
                const url = await uploadForPrinting(store.id, blob);
                const went = await openPrinterAppWith(`#imageurl#${url}#/imageurl#`);
                // Given a long while: the app fetches AFTER iOS has switched to it, and removing
                // the file early would race the download and look like the app's fault.
                if (went) setTimeout(() => void removePrinted(url), 60000);
                else {
                  void removePrinted(url);
                  setPrinterNote('The app did not open. Is it installed?');
                }
              } catch (e: unknown) {
                setPrinterNote(messageOf(e, 'Could not prepare a test'));
              } finally {
                setTestingApp(false);
              }
            }}
          >
            3. Print an image from here
          </Button>
        </div>
      )}

      {/*
        ─── HOW BIG THE LETTERS PRINT, AND WHAT THAT LOOKS LIKE ──────────────────

        The receipt goes to the printer in its OWN built-in font, which is why it is sharp — the
        glyphs live in the printer's ROM at exactly the dot pitch of the head, where an image has to
        be resampled to get there. That font comes in sizes, and which one reads best is a judgement
        about this shop: how far the customer stands, how good the light is, what a roll costs.

        So it is a choice with a preview. The preview is built from the SAME instruction the printer
        receives — un-tagged and laid out at the same characters-per-line — so a preview that is
        wrong is a print that is wrong. Two layouts that resemble each other agree until the day they
        do not.
      */}
      {(printer.kind === 'ios_app' || printer.kind === 'bluetooth' || printer.kind === 'usb') && (
        <>
          {/*
            ─── THE PAPER FIRST, because everything below is measured against it ───

            Found on a real shop: the roll setting said 48mm while the printer in the shop was an
            80mm one — 576 dots, 72mm of printing, as its own manual states. Every layout decision
            downstream is made against that number, so a receipt was being set out for two thirds of
            the paper it was printed on.

            It is also configurable further up this page, under the receipt, and it should be: that
            is where a shop sets up its receipt. It is repeated HERE because this is the only place
            the consequence is visible — the preview under it redraws, and the character count on
            every size button changes with it.
          */}
          <h3 className={styles.subsection}>Your paper</h3>
          <div className={styles.printerChoice} role="group" aria-label="Paper width">
            {settings && ([80, 58, 48] as const).map((mm) => (
              <button
                key={mm}
                type="button"
                className={`${styles.printerOption} ${
                  Number(settings.printer_width_mm) === mm ? styles.printerOptionActive : ''
                }`}
                aria-pressed={Number(settings.printer_width_mm) === mm}
                disabled={!editable}
                onClick={() => patch({ printer_width_mm: String(mm) })}
              >
                <span className={styles.printerOptionName}>{mm}mm roll</span>
                <span className={styles.printerOptionWhat}>
                  {dotsFor(mm)} dots across
                  {mm === 80 ? ' · the common till roll' : ''}
                </span>
              </button>
            ))}
          </div>

          <h3 className={styles.subsection}>How big it prints</h3>
          <div className={styles.printerChoice} role="group" aria-label="Printed letter size">
            {(
              [
                ['ss', 'Small', 'Most on a roll'],
                ['ssw', 'Wide', 'Easy to read, same paper'],
                ['sshw', 'Wide and tall', 'Clearest. Twice the paper'],
                ['sl', 'Large', 'Between the two'],
              ] as [TextSize, string, string][]
            ).map(([size, name, what]) => (
              <button
                key={size}
                type="button"
                className={`${styles.printerOption} ${printer.textSize === size ? styles.printerOptionActive : ''}`}
                aria-pressed={printer.textSize === size}
                onClick={async () => {
                  if (!store) return;
                  setPrinterNote(null);
                  try {
                    await savePrinter(store.id, {
                      kind: printer.kind,
                      deviceLabel: printer.choice?.deviceLabel ?? null,
                      printerName: printer.choice?.printerName ?? null,
                      widthMm: printer.widthMm,
                      usbVendorId: printer.choice?.usbVendorId ?? null,
                      usbProductId: printer.choice?.usbProductId ?? null,
                      btDeviceId: printer.choice?.btDeviceId ?? null,
                      textSize: size,
                    });
                    await printers.reload();
                    await printer.reload();
                  } catch (e: unknown) {
                    setPrinterNote(messageOf(e, 'Could not save that size'));
                  }
                }}
              >
                <span className={styles.printerOptionName}>{name}</span>
                <span className={styles.printerOptionWhat}>
                  {what} · {columnsAt(size, dotsFor(printer.widthMm))} characters a line
                </span>
              </button>
            ))}
          </div>

          <PrintPreview
            payload={samplePrint}
            paperMm={printer.widthMm}
            bodySize={printer.textSize}
          />
          <p className={styles.diagnosticWhy}>
            {/*
              SAID HERE rather than discovered on paper. A shop that sees N where it expects ₦ will
              assume something is broken unless it was told, and it is not broken — there is no code
              page on this class of printer that carries the naira sign.
            */}
            This is what the roll will say. The naira sign prints as <strong>N</strong>: a thermal
            printer&apos;s built-in letters do not include ₦, and printing a picture instead is what
            made it come out faint.
          </p>
        </>
      )}

      {/*
        PROVING IT, without needing a sale.

        A printer that is "connected" and prints nothing is the commonest complaint, and the only way
        to tell the difference before a customer is standing there is to print something.
      */}
      {printer.ready && (printer.kind === 'usb' || printer.kind === 'bluetooth') && (
        <Button
          variant="secondary"
          fullWidth
          onClick={async () => {
            setPrinterNote(null);
            try {
              const bytes = testTicket(store?.name ?? 'This shop');
              if (printer.kind === 'usb') await printBytesOverUsb(bytes);
              else await printBytes(bytes);
              setPrinterNote('Sent. If nothing came out, the roll or the paper is the next thing to check.');
            } catch (e: unknown) {
              setPrinterNote(messageOf(e, 'Could not reach the printer'));
            }
          }}
        >
          Print a test
        </Button>
      )}

      {printerNote && (
        <p className={styles.sectionNote} role="status">
          {printerNote}
        </p>
      )}

      {/*
        AND WHAT EVERY OTHER DEVICE IS SET TO.

        "Why does the counter print and my phone not" is answered by seeing both, rather than by
        walking to each one. A shop replacing a phone also needs to see what the old one pointed at.
      */}
      {(printers.data ?? []).filter((d) => d.deviceId !== deviceId()).length > 0 && (
        <>
          <h3 className={styles.subsection}>Your other devices</h3>
          <ul className={styles.noticeList}>
            {(printers.data ?? [])
              .filter((d) => d.deviceId !== deviceId())
              .map((d) => (
                <li key={d.deviceId} className={styles.noticeRow}>
                  <span>
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
                  </span>
                </li>
              ))}
          </ul>
        </>
      )}

      {/*
        WHAT WAS PUT AWAY, AND THE WAY BACK.

        A warning that can be dismissed and never recovered is a warning that has been deleted.
        This sits under "This device" because that is what a dismissal is — the till stops
        showing it, the owner's phone still does.
      */}
      {hiddenNotices.length > 0 && (
        <>
          <h3 className={styles.subsection}>Warnings you turned off</h3>
          <ul className={styles.noticeList}>
            {hiddenNotices.map((noticeId) => (
              <li key={noticeId} className={styles.noticeRow}>
                <span>{NOTICE_NAMES[noticeId] ?? noticeId}</span>
                <button
                  type="button"
                  className={styles.noticeShow}
                  onClick={() => showNotice(noticeId)}
                >
                  Show again
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className={styles.section}>You</h2>
      <div className={styles.you}>
        <p className={styles.youName}>{user?.email}</p>
        <p className={styles.sectionNote}>
          {ROLE_LABEL[role ?? 'staff']} — {ROLE_DESCRIPTION[role ?? 'staff']}
        </p>
      </div>

      {/*
        YOUR SHOPS — and the two things you could not do with them.
        
        A person can work in more than one: an owner with a second business, somebody who is staff
        at one shop and owner of another. The database has supported that from the start —
        `store_members` is many-to-many and `selectStore` exists — and there was no way to reach
        either. No switcher anywhere in the app, and `/setup` reachable only by having no shop at
        all, so an owner could not open their second one.
        
        Switching empties the previous shop's cached data BEFORE it changes, so no figure, list or
        open till from one shop can appear under another's name.
      */}
      <div className={styles.group}>
        <h2 className={styles.section}>Your shops</h2>

        {stores.map((s) => {
          const here = s.id === store?.id;
          return (
            <button
              key={s.id}
              type="button"
              className={here ? styles.shopHere : styles.shopRow}
              disabled={here || switching !== null}
              onClick={() => void switchTo(s.id)}
            >
              <span className={styles.shopName}>{s.name}</span>
              <span className={styles.shopMeta}>
                {here
                  ? 'You are working here'
                  : switching === s.id
                    ? 'Switching…'
                    : !s.onboardedAt
                      ? 'Not finished setting up'
                      : ROLE_LABEL[s.role]}
              </span>
            </button>
          );
        })}

        {/*
          Only an owner is offered a new shop. Staff at somebody else's shop opening a business from
          inside their employer's app is not a thing anybody asked for, and the button would be a
          question they have to think about on a screen they came to for something else.
        */}
        {role === 'owner' && (
          <button
            type="button"
            className={styles.shopAdd}
            onClick={() => router.push('/setup')}
          >
            Open another shop
            <span className={styles.sectionNote}>
              A separate business with its own stock, prices, customers and money
            </span>
          </button>
        )}
      </div>

      {/*
        A WAY OUT TO THE PUBLIC SIDE, and back again.
        
        The marketplace is the same site — a shop's own products are listed there — but from inside
        the app there was no route to it at all, so the only way to see how your shop looks to a
        shopper was to type the address. Going there signed in shows "My shop" rather than "Sign in",
        so the way back is one tap.
      */}
      <a className={styles.marketLink} href="/" target="_blank" rel="noopener noreferrer">
        See the marketplace
        <span className={styles.marketNote}>How shoppers find you, and what your shop looks like to them</span>
      </a>

      {/*
        WHICH BUILD THIS IS, and a way to take the next one now.
        
        An installed app updates itself and the reload prompt offers it on the shop's own schedule,
        which is right and entirely invisible — so when something is wrong there is no way to say
        which version it is wrong in, and no way to answer "have you got the latest?" except by
        waiting for the prompt.
      */}
      <div className={styles.group}>
        <h2 className={styles.section}>This app</h2>
        <AppVersion />
      </div>

      <Button variant="secondary" size="large" fullWidth onClick={() => void signOut()}>
        Sign out
      </Button>
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}

/**
 * The heading goes with the offer.
 *
 * `InstallApp` decides whether there is anything to say; without this the section title sat on the
 * screen of a shop that had already installed it, over nothing.
 */
function InstallSection() {
  const { way } = useInstallApp();
  if (way === 'installed' || way === 'not-offered') return null;
  return (
    <>
      <h2 className={styles.section}>This app on your phone</h2>
      <InstallApp
        label="Put this on my phone"
        note="It opens from your home screen like any other app — full screen, and it starts from what it last knew even on a bad line."
      />
    </>
  );
}
