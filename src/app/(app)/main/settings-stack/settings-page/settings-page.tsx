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
        NO SAVE ACTION IN THE HEADER, because this screen no longer edits anything.

        It was a checkmark that governed the whole page: a select at the top, a paper width, a
        logo, a bank account. Every one of those is on its own page now and saves as it is
        changed. A Save on a list of links would be a control that does nothing, which is a
        control somebody presses to find out what it does.
      */
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
          {/*
            ─── A SETTINGS SCREEN IS A LIST OF THINGS TO GO AND DO ──────────────

            It had grown into a form: a select here, a paper width there, a logo upload, a bank
            chooser, two previews — and one Save in the header governing all of it. Three problems
            with that, and a shop hit each one. A change made at the top is not saved until
            somebody finds a checkmark they were not looking for. Two screens editing overlapping
            parts of the same row overwrite each other. And a page that long is a page where
            nobody finds what they came for.

            So each setting lives on its own page, saves as it is changed, and this screen points
            at them.
          */}
          <h2 className={styles.section}>Your receipt</h2>
          <Button variant="secondary" fullWidth onClick={() => void nav.push('printing_page')}>
            The receipt, your printer and your paper
          </Button>
          <p className={styles.sectionNote}>
            What it says, how big it prints, which printer this device uses — and a preview of
            what the roll will say.
          </p>

          <h2 className={styles.section}>Updates</h2>
          <Button variant="secondary" fullWidth onClick={() => void nav.push('updates_page')}>
            How often to ask again
          </Button>
          <p className={styles.sectionNote}>
            After &ldquo;Not now&rdquo;, how long before a waiting update offers itself again.
          </p>

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

      {/*
        GUARDED ON THE SHOP, not on its settings.

        This sat inside a `{settings && ...}` that happened to narrow `shop` as well, and the block
        above it moved to its own page — taking the narrowing with it. What this section actually
        reads is the SHOP: its code, whether it is listed, its description. Guarding on the thing
        it uses is also the honest version: the storefront does not wait on a receipt setting.
      */}
      {shop && (
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
        PRINTING IS ITS OWN PAGE NOW.

        This screen had grown a paper width, a size picker, a preview, a connection switch and a
        diagnostic — beside a "Receipt printer" section that ALREADY had a paper width and a
        preview. Two of each, able to disagree. And the connection switch could not be switched
        back, because each option saved a different shape of setting.

        A card, because that is what a settings screen is for: a list of things a shop can go and
        do, not the place to do them.
      */}
      <h3 className={styles.subsection}>Printing</h3>
      <Button variant="secondary" fullWidth onClick={() => void nav.push('printing_page')}>
        Your printer, and how a receipt is set out
      </Button>
      <p className={styles.sectionNote}>
        Which printer this device uses, and the size of every part of the receipt — with a preview
        of what the roll will say.
      </p>

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
