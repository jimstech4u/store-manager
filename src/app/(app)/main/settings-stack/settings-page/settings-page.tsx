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

          <h2 className={styles.section}>Counting</h2>
          <Button variant="secondary" fullWidth onClick={() => void nav.push('count_gate_settings_page')}>
            Count gate
          </Button>
          <p className={styles.sectionNote}>
            Count every day before anything sells (Aggressive), or only on the days you pick
            (Relaxed).
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
          {/*
            AND THESE ARE NOT MONEY.

            "This shop" and "Words you measure in" sat under the Money heading with the bank
            accounts, because that is where they were added rather than where they belong — so a
            shop looking for its own name or its unit words was reading a list headed Money and
            giving up. Their own heading, which is all this is.
          */}
          {(canOpen('shop_page') || canOpen('words_page')) && (
            <h2 className={styles.section}>Your shop</h2>
          )}

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

          {canOpen('groups_page') && (
            <button
              type="button"
              className={styles.linkRow}
              onClick={() => nav.push('groups_page')}
            >
              <span className={styles.linkMain}>
                <span className={styles.linkName}>Groups you file under</span>
                <span className={styles.sectionNote}>
                  NBL, soft drinks, water — the headings on your printed price list
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
        THE PUBLIC STOREFRONT MOVED TO THE SHOP'S OWN PAGE.

        It was a toggle, a text box and a code panel sitting loose here, which is this screen's own
        rule broken — Settings lists what a shop can go and do, and is not where it does it. It
        also read oddly: "Where it is", on the shop page, explains itself as "only used if your
        storefront is switched on", so the switch and the reason for filling in an address were two
        screens apart. They are together now.
      */}

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
        THERE IS ONE PRINTING CARD, AND IT IS "YOUR RECEIPT" AT THE TOP.

        A second one lived here, under "This device", pointing at the very same `printing_page`.
        Two cards, same destination, one screen — reported as "double printing cards in settings
        page at the top and bottom". The argument for this one was that the printer is a property
        of the device; true, and the page it opens covers the shop's receipt AND this device's
        printer together, so the shop still had to be told which of the two identical doors to use.
      */}

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
        THE APP'S OWN BUSINESS, AT THE END OF THE SHOP'S.

        These two were at the TOP: the very first things a shop was offered on opening Settings
        were how to install the app and how often to be nagged about a new version, above its
        money, its people and its stock. Reported as settings that belong at the bottom sitting in
        the middle of the page. Nothing about either changed except where they are.

        `InstallSection` still draws nothing once the app is installed, so on an installed phone
        this is the Updates card alone.
      */}
      <h2 className={styles.section}>Updates</h2>
      <Button variant="secondary" fullWidth onClick={() => void nav.push('updates_page')}>
        How often to ask again
      </Button>
      <p className={styles.sectionNote}>
        After &ldquo;Not now&rdquo;, how long before a waiting update offers itself again.
      </p>

      <InstallSection />

      {/*
        THE VERSION LIVES ON THE UPDATES PAGE, not here as well.

        Both said "This app" and both showed the build and a Check-for-an-update button, so the
        screen answered the same question twice — and the two could drift the moment one of them
        gained a detail the other did not. The Updates card is the way to it, beside the
        setting for how often an update asks.
      */}
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
