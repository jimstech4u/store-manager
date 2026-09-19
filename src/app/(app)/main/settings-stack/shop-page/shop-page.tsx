'use client';

import { useEffect, useRef, useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { useLoadArea } from '@/components/ui/LoadArea';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { AsyncAction, useAsyncAction } from '@/components/ui/AsyncAction';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { messageOf, setMoneyDecimals } from '@/lib/format';
import styles from './shop-page.module.css';

/**
 * The shop's own row — the one thing it could not correct.
 *
 * A shop can rename its units, its pools, its groups, its products and its customers, and remove a
 * member. Its own name was fixed at signup for ever, and a shop created by a mistyped name could
 * never be got rid of: it stayed in the switcher, and because a store with no `onboarded_at` routes
 * straight to `/setup/opening`, it could take the whole session and answer with a setup wizard.
 *
 * WHERE IT IS matters for a different reason. The storefront has always been public and
 * `public_stores_near` sorts by distance — so a shop could switch its storefront on and be searched
 * for by people nearby, while the columns saying where it is were written by nothing at all.
 */
export default function ShopPage() {
  const goBack = useStackBack();
  const { store, stores, refreshStores, selectStore } = useAuth();
  const problem = useProblem();
  const showProblem = problem.show;

  const rename = useAsyncAction();
  const place = useAsyncAction();
  const clock = useAsyncAction();
  const money = useAsyncAction();

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [zone, setZone] = useState('');
  const [decimals, setDecimals] = useState('0');
  const [closing, setClosing] = useState(false);
  const [sales, setSales] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Read, then copied once into the form, which owns it from there.
   *
   * Not re-seeded on every change of `store`, or typing a new name would be overwritten the moment
   * the rename lands and the provider re-reads.
   *
   * THE FORM WAITS FOR IT. It used to be drawn at once with empty boxes — a shop with no name, no
   * address and the default clock — and if the read failed it STAYED that way, a Save away from
   * writing those blanks over the real ones. The clock list's error was not even looked at.
   */
  const shopId = store?.id ?? null;
  const shopArea = useLoadArea(
    async () => {
      const supabase = getSupabase();
      const [{ data, error }, { data: choices, error: choicesError }] = await Promise.all([
        supabase
          .from('stores')
          .select('name, address, latitude, longitude, timezone, money_decimals')
          .eq('id', shopId as string)
          .maybeSingle(),
        // The shortlist the server offers, with each one's offset RIGHT NOW — "Africa/Lagos
        // (+01:00)" is checkable against a wall clock in a way a bare name is not.
        supabase.rpc('store_clock_choices'),
      ]);
      if (error) throw error;
      if (choicesError) throw choicesError;
      return {
        row: data as {
          name: string;
          address: string | null;
          latitude: number | null;
          longitude: number | null;
          timezone: string | null;
          money_decimals: number | null;
        } | null,
        zones: (choices ?? []) as { name: string; offset_now: string }[],
      };
    },
    [shopId],
    { key: `shop-settings:${shopId ?? 'none'}`, whenNot: !shopId },
  );
  const zones = shopArea.data?.zones ?? [];

  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !shopArea.data) return;
    seeded.current = true;
    const row = shopArea.data.row;
    setName(row?.name ?? '');
    setAddress(row?.address ?? '');
    setLat(row?.latitude == null ? '' : String(row.latitude));
    setLng(row?.longitude == null ? '' : String(row.longitude));
    setZone(row?.timezone ?? 'Africa/Lagos');
    setDecimals(String(row?.money_decimals ?? 0));
  }, [shopArea.data]);

  const closeDialog = useConfirm();

  if (!store) return null;

  const elsewhere = stores.filter((s) => s.id !== store.id);

  const askToClose = async () => {
    // Read before asking, so the question can say what is at stake rather than "are you sure?".
    const { count, error } = await getSupabase()
      .from('sales')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', store.id);
    // Not knowing is not "nothing sold": that would ask the lighter question about a trading shop.
    if (error) {
      showProblem(messageOf(error, 'Could not check this shop’s sales. Try again.'));
      return;
    }
    setSales(count ?? 0);
    setClosing(true);
  };

  const doClose = async (force: boolean) => {
    setBusy(true);
    try {
      const { error } = await getSupabase().rpc('close_store', {
        p_store_id: store.id,
        p_restore: false,
        p_force: force,
      });
      if (error) throw error;
      setClosing(false);
      /*
       * Move somewhere else BEFORE the list is re-read.
       *
       * The provider now filters closed shops out, so refreshing while standing in this one leaves
       * the session pointing at a store that is no longer in the list.
       */
      if (elsewhere[0]) selectStore(elsewhere[0].id);
      await refreshStores();
    } catch (e) {
      setClosing(false);
      showProblem(messageOf(e, 'That shop could not be closed.'));
    } finally {
      setBusy(false);
    }
  };

  const status: PageStatus = shopArea.data
    ? { state: 'ready' }
    : shopArea.error
      ? { state: 'error', what: 'this shop', error: shopArea.error, onRetry: shopArea.reload }
      : { state: 'loading', what: 'this shop' };

  return (
    <PageScaffold onBack={goBack} title="This shop" subtitle={store.name}>
      <ProblemDialog problem={problem} title="Could not change this shop" />

      <PageState status={status}>
        {() => (
          <>

      <h2 className={styles.section}>What it is called</h2>
      <p className={styles.note}>
        This is the name on every receipt a customer keeps, and the one your staff see when they
        sign in.
      </p>

      <Field
        label="Shop name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="ASHABI GLOBAL RESOURCES"
      />

      <div className={styles.actions}>
        <AsyncAction state={rename.state} problem={rename.problem} label="Saving the name">
          <Button
            fullWidth
            disabled={name.trim() === '' || name.trim() === store.name}
            onClick={() =>
              rename.run(async () => {
                const { error } = await getSupabase().rpc('rename_store', {
                  p_store_id: store.id,
                  p_name: name.trim(),
                });
                if (error) throw error;
                await refreshStores();
              })
            }
          >
            Save the name
          </Button>
        </AsyncAction>
      </div>

      <h2 className={styles.section}>Where it is</h2>
      <p className={styles.note}>
        Only used if your storefront is switched on — that is how people nearby find you. Leave it
        blank and you simply will not come up in a search by distance.
      </p>

      <Field
        label="Address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="12 Ojuelegba Road, Surulere, Lagos"
        optional
      />

      <div className={styles.pair}>
        <Field
          label="Latitude"
          numeric
          value={lat}
          onChange={(e) => setLat(e.target.value)}
          placeholder="6.5244"
          optional
          hint="Between −90 and 90"
        />
        <Field
          label="Longitude"
          numeric
          value={lng}
          onChange={(e) => setLng(e.target.value)}
          placeholder="3.3792"
          optional
          hint="Between −180 and 180"
        />
      </div>

      <div className={styles.actions}>
        <AsyncAction state={place.state} problem={place.problem} label="Saving where you are">
          <Button
            fullWidth
            onClick={() =>
              place.run(async () => {
                const { error } = await getSupabase().rpc('set_store_place', {
                  p_store_id: store.id,
                  p_address: address.trim() || null,
                  // Blank is "not said", which is different from nought — nought is a real place
                  // in the Atlantic and the server would store it.
                  p_latitude: lat.trim() === '' ? null : Number(lat),
                  p_longitude: lng.trim() === '' ? null : Number(lng),
                });
                if (error) throw error;
              })
            }
          >
            Save where you are
          </Button>
        </AsyncAction>
      </div>

      <h2 className={styles.section}>Your day</h2>
      <p className={styles.note}>
        Which clock a day is counted by. It decides when yesterday becomes today for your counts and
        your periods — on the wrong one, an evening&rsquo;s trade lands on the following day.
      </p>

      <label className={styles.label} htmlFor="shop-clock">
        Time zone
      </label>
      <select
        id="shop-clock"
        className={styles.select}
        value={zone}
        onChange={(e) => setZone(e.target.value)}
      >
        {/*
          The shop's own value first, even if it is not on the shortlist — a select whose value is
          absent shows its first option instead, which would silently offer to move a Nairobi shop
          to Lagos the moment anything else on the page was saved.
        */}
        {!zones.some((z) => z.name === zone) && zone !== '' && <option value={zone}>{zone}</option>}
        {zones.map((z) => (
          <option key={z.name} value={z.name}>
            {z.name} ({z.offset_now})
          </option>
        ))}
      </select>

      <div className={styles.actions}>
        <AsyncAction state={clock.state} problem={clock.problem} label="Saving the clock">
          <Button
            fullWidth
            onClick={() =>
              clock.run(async () => {
                const { error } = await getSupabase().rpc('set_store_clock', {
                  p_store_id: store.id,
                  p_timezone: zone,
                });
                if (error) throw error;
              })
            }
          >
            Save the clock
          </Button>
        </AsyncAction>
      </div>

      <h2 className={styles.section}>Kobo</h2>
      <p className={styles.note}>
        Nigerian trade is in whole naira, so that is the default. Turn it up only if you really deal
        in fractions — nothing already recorded changes, because amounts have always been stored to
        two places; this only decides what is shown and what you can type.
      </p>

      <div className={styles.choices}>
        {[
          { value: '0', said: 'Whole naira', eg: '₦3,700' },
          { value: '1', said: 'One place', eg: '₦3,700.5' },
          { value: '2', said: 'Kobo', eg: '₦3,700.50' },
        ].map((c) => (
          <button
            key={c.value}
            type="button"
            className={`${styles.choice} ${decimals === c.value ? styles.choiceOn : ''}`}
            aria-pressed={decimals === c.value}
            onClick={() => setDecimals(c.value)}
          >
            <span className={styles.choiceSaid}>{c.said}</span>
            <span className={styles.choiceEg}>{c.eg}</span>
          </button>
        ))}
      </div>

      <div className={styles.actions}>
        <AsyncAction state={money.state} problem={money.problem} label="Saving">
          <Button
            fullWidth
            onClick={() =>
              money.run(async () => {
                const { error } = await getSupabase().rpc('set_store_money_decimals', {
                  p_store_id: store.id,
                  p_decimals: Number(decimals),
                });
                if (error) throw error;
                // Applied to this session at once. Re-reading the provider would get there too, but
                // a setting whose effect waits for a reload reads as one that did not save.
                setMoneyDecimals(Number(decimals));
                await refreshStores();
              })
            }
          >
            Save how money is shown
          </Button>
        </AsyncAction>
      </div>

      <h2 className={styles.section}>Closing this shop</h2>
      {elsewhere.length === 0 ? (
        <InfoPanel tone="info" title="This is your only shop">
          Closing it would leave you with nowhere to sign in to. Make another one first if you are
          moving.
        </InfoPanel>
      ) : (
        <>
          <p className={styles.note}>
            It stops being offered when you sign in, and everybody in it loses it from their
            switcher. Nothing is deleted — receipts your customers are holding still open, and the
            books stay readable.
          </p>
          <div className={styles.actions}>
            <Button variant="danger" fullWidth onClick={() => void askToClose()}>
              Close this shop
            </Button>
          </div>
        </>
      )}

      {/*
        A QUESTION THAT MUST BE ANSWERED BEFORE ANYTHING ELSE — so a sheet, not a panel, and never
        `window.confirm`. It says what is at stake rather than "are you sure?": a shop with a
        hundred sales on it is a different decision from one made this morning by accident.
      */}
      {/*
        A CONFIRMATION IS A DIALOG (DialogViewer), not a bottom sheet — and mounted only while it is
        being asked, because `ConfirmDialog` opens itself on mount.
      */}
      {closing && (
        <ConfirmDialog
          controller={closeDialog}
          title={sales && sales > 0 ? 'This shop has been trading' : `Close ${store.name}?`}
          message={
            sales && sales > 0
              ? `There are ${sales} sales recorded against ${store.name}. Closing it keeps every ` +
                'one of them — nothing is deleted and the receipts still open — but nobody will be ' +
                'able to reach the shop from the app again without you reopening it.'
              : `Nothing has ever been sold from ${store.name}, so there is nothing to lose.` +
                (elsewhere[0] ? ` You will land in ${elsewhere[0].name} instead.` : '')
          }
          confirmText={sales && sales > 0 ? 'Close it anyway' : 'Close it'}
          cancelText="Keep it"
          tone="danger"
          onDismiss={() => setClosing(false)}
          onConfirm={() => void doClose((sales ?? 0) > 0)}
        />
      )}
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
