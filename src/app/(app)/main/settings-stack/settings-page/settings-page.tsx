'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useReload } from '@/lib/stacks/resource';
import { InstallApp } from '@/components/ui/InstallApp';
import { useInstallApp } from '@/hooks/useInstallApp';
import styles from './settings-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { LinkGroup, LinkRow } from '@/components/ui/LinkGroup';
import {
  BankIcon,
  BoxIcon,
  CashIcon,
  CheckCircleIcon,
  ClipboardCheckIcon,
  EditIcon,
  EyeIcon,
  PeopleIcon,
  PersonPlusIcon,
  PlusIcon,
  PrinterIcon,
  RefreshIcon,
  SettingsIcon,
  WarningIcon,
  WhatsAppIcon,
} from '@/components/ui/Icon';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useNav } from '@academix-admin/navigation-stack';
import { useDemandState } from '@academix-admin/state-stack';
import { SETTINGS_SCOPE } from '@/lib/stacks/bank-accounts';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useStackBack } from '@/hooks/useStackBack';
import { ROLE_DESCRIPTION, ROLE_LABEL } from '@/lib/permissions';
import { getSupabase } from '@/lib/supabase/client';
import { useTheme } from '@/context/ThemeContext';
import { NOTICE_NAMES, showNotice, useHiddenNotices } from '@/lib/hidden-notices';

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


  /*
   * All three of this page's reads in one state-stack entry.
   *
   * This is the settings tab's ROOT, and every row on it pushes: bank accounts, staff, the review
   * queue, the shop itself. Each part used to be its own `useState` filled by its own effect,
   * which meant every trip back rebuilt the whole screen from nothing — the printer width
   * reverted to its placeholder and the "waiting for you" count blanked. A settings screen
   * whose switches move by themselves is one nobody trusts to have saved anything.
   *
   * One entry rather than several because they are read together and shown together; separate
   * keys would just be more chances to draw a half-built page.
   */
  const [snapshot, demand] = useDemandState<{
    settings: Settings | null;
    pending: number;
    error: string | null;
  }>(
    { settings: null, pending: 0, error: null },
    {
      key: `settings:${store?.id ?? 'none'}`,
      scope: SETTINGS_SCOPE,
      persist: true,
      deps: [store?.id ?? ''],
      revalidateOnMount: false,
    },
  );

  const settings = snapshot.settings;





  const pending = snapshot.pending;
  const error = snapshot.error;

  const saveProblem = useProblem();

  /*
   * The latest snapshot, readable from the loader without becoming a dependency of it.
   *
   * The loader's failure path wants to keep what was already cached. Reading `snapshot` directly
   * would put it in the effect's deps, and since the loader writes the snapshot, that is a loop
   * that refetches the settings page forever.
   */
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const canConfirm = can('records.confirm');

  const load = useCallback(() => {
    if (!store) return;
    demand(async ({ set }) => {
      const supabase = getSupabase();
      const [own, review] = await Promise.all([
        supabase.rpc('ensure_store_settings', { p_store_id: store.id }),
        // A count on the button, not just a label. "Waiting for you" with no number gives no
        // reason to tap it; "3 waiting" does. Skipped entirely for a member who cannot approve.
        canConfirm
          ? supabase.rpc('pending_review', { p_store_id: store.id })
          : Promise.resolve({ data: null }),
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
      // A failed count is not "nothing waiting": it keeps what it last knew.
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
        WHO IS SIGNED IN, AND WHERE — first, the way a phone's own settings open on its owner.

        It was at the bottom under "You", below the shop's printer and its staff. On a phone the
        shop shares, "whose account is this, and which shop am I changing" is the question to
        answer before any row below is touched.
      */}
      <div className={styles.profile}>
        <span className={styles.avatar} aria-hidden>
          {(user?.email ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <span className={styles.profileMain}>
          <span className={styles.youName}>{user?.email}</span>
          <span className={styles.profileRole}>
            {ROLE_LABEL[role ?? 'staff']} at {store.name}
          </span>
          <span className={styles.profileNote}>{ROLE_DESCRIPTION[role ?? 'staff']}</span>
        </span>
      </div>

      {!editable && (
        <InfoPanel tone="info" title="You can look, but not change these">
          Shop settings are changed by the owner. You are signed in as{' '}
          {ROLE_LABEL[role ?? 'staff']}.
        </InfoPanel>
      )}

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
            at them — in headed groups of rows, each with a picture and a word.
          */}
          <LinkGroup title="Selling">
            <LinkRow
              icon={<PrinterIcon />}
              title="Receipt and printer"
              note="What it says, how big it prints, this device’s printer"
              onClick={() => void nav.push('printing_page')}
            />
            <LinkRow
              icon={<BankIcon />}
              title="Bank accounts"
              note="Where customers transfer to"
              onClick={() => void nav.push('bank_page')}
            />
            <LinkRow
              icon={<ClipboardCheckIcon />}
              title="Count gate"
              note="When a count must come before selling"
              onClick={() => void nav.push('count_gate_settings_page')}
            />
            <LinkRow
              icon={<WarningIcon />}
              title="Running low"
              note="When to warn that stock is running out"
              onClick={() => void nav.push('low_stock_page')}
            />
          </LinkGroup>

          {/*
            THE SHOP'S OWN ROW, ITS HEADINGS AND ITS WORDS — everything here corrects something the
            shop named. "This shop" and "Words you measure in" once sat under Money with the bank
            accounts, because that is where they were added rather than where they belong.
          */}
          {(canOpen('shop_page') || canOpen('groups_page') || canOpen('words_page')) && (
            <LinkGroup title="Your shop">
              {canOpen('shop_page') && (
                <LinkRow
                  icon={<SettingsIcon />}
                  title="This shop"
                  note="Name, address and storefront"
                  onClick={() => void nav.push('shop_page')}
                />
              )}
              {canOpen('groups_page') && (
                <LinkRow
                  icon={<BoxIcon />}
                  title="Groups you file under"
                  note="Headings on your price list"
                  onClick={() => void nav.push('groups_page')}
                />
              )}
              {canOpen('words_page') && (
                <LinkRow
                  icon={<EditIcon />}
                  title="Words you measure in"
                  note="Crate, bottle, carton — fix one everywhere"
                  onClick={() => void nav.push('words_page')}
                />
              )}
            </LinkGroup>
          )}
        </>
      )}

      {/*
        PEOPLE — customers as a section rather than a tab (the list somebody opens to look
        somebody up is a reference, not a job), the team, what staff owe, and what is waiting to be
        checked. "Who works here" and "who owes for missing stock" stay separate rows: different
        questions, one asked far less often.
      */}
      {(can('customers.manage') || can('staff.manage') || can('records.confirm')) && (
        <LinkGroup title="People">
          {can('customers.manage') && (
            <LinkRow
              icon={<PeopleIcon />}
              title="Everyone you sell to"
              note="Balances, containers held, what they bought"
              onClick={() => void nav.push('people_page')}
            />
          )}
          {can('staff.manage') && (
            <LinkRow
              icon={<PersonPlusIcon />}
              title="People who work here"
              note="Staff, and what each of them can do"
              onClick={() => void nav.push('staff_page')}
            />
          )}
          {can('staff.manage') && canOpen('staff_charges_page') && (
            <LinkRow
              icon={<CashIcon />}
              title="What staff owe"
              note="Missing stock or cash, and what is repaid"
              onClick={() => void nav.push('staff_charges_page')}
            />
          )}
          {can('records.confirm') && (
            <LinkRow
              icon={<CheckCircleIcon />}
              title="Things waiting for you"
              note="Added by staff while serving"
              badge={pending}
              onClick={() => void nav.push('review_page')}
            />
          )}
        </LinkGroup>
      )}

      {/* The shop on WhatsApp: link this member's own number to the agent (0259). */}
      <LinkGroup title="Store Manager on WhatsApp">
        <LinkRow
          icon={<WhatsAppIcon />}
          title="Ask the shop from your chats"
          note="Sell, check stock and send receipts by message"
          onClick={() => void nav.push('whatsapp_page')}
        />
      </LinkGroup>

      {/*
        THIS DEVICE — what this phone shows and how it is kept up to date. Per device, not shared
        with the staff: the till stops showing a dismissed warning, the owner's phone still does.
      */}
      <LinkGroup title="This device">
        <div className={styles.cardBlock}>
          <span className={styles.blockName}>Appearance</span>
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
          <span className={styles.blockNote}>Showing {theme} now.</span>
        </div>
        {/*
          THE VERSION LIVES ON THE UPDATES PAGE, beside how often a waiting update asks again —
          the app's own business, at the end of the shop's.
        */}
        <LinkRow
          icon={<RefreshIcon />}
          title="Updates"
          note="Version, and how often an update asks"
          onClick={() => void nav.push('updates_page')}
        />
      </LinkGroup>

      <InstallSection />

      {/*
        WHAT WAS PUT AWAY, AND THE WAY BACK. A warning that can be dismissed and never recovered is
        a warning that has been deleted.
      */}
      {hiddenNotices.length > 0 && (
        <LinkGroup title="Warnings you turned off">
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
        </LinkGroup>
      )}

      {/*
        YOUR SHOPS — an owner with a second business, somebody who is staff at one shop and owner of
        another. Switching empties the previous shop's cached data BEFORE it changes, so no figure,
        list or open till from one shop can appear under another's name. The one being worked in is
        MARKED ("You are working here"), not merely coloured.

        Only an owner is offered a new shop: staff opening a business from inside their employer's
        app is not a thing anybody asked for.
      */}
      <LinkGroup title="Your shops">
        {stores.map((s) => {
          const here = s.id === store?.id;
          return (
            <LinkRow
              key={s.id}
              title={s.name}
              current={here}
              disabled={switching !== null}
              value={
                here
                  ? 'You are working here'
                  : switching === s.id
                    ? 'Switching…'
                    : !s.onboardedAt
                      ? 'Not finished setting up'
                      : ROLE_LABEL[s.role]
              }
              onClick={() => void switchTo(s.id)}
            />
          );
        })}
        {role === 'owner' && (
          <LinkRow
            icon={<PlusIcon />}
            title="Open another shop"
            note="A separate business of its own"
            onClick={() => router.push('/setup')}
          />
        )}
        {/*
          A WAY OUT TO THE PUBLIC SIDE. Going there signed in shows "My shop" rather than "Sign in",
          so the way back is one tap.
        */}
        <LinkRow
          icon={<EyeIcon />}
          title="See the marketplace"
          note="How shoppers see your shop"
          href="/"
        />
      </LinkGroup>

      <div className={styles.signOut}>
        <Button variant="secondary" size="large" fullWidth onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
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
    <LinkGroup title="This app on your phone">
      <div className={styles.cardBlock}>
        <InstallApp
          label="Put this on my phone"
          note="It opens from your home screen like any other app — full screen, and it starts from what it last knew even on a bad line."
        />
      </div>
    </LinkGroup>
  );
}
