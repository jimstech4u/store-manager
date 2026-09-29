'use client';

import { useSayInShapes } from '@/lib/stacks/selling-units';
import { useEffect, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { ProductPicker } from '@/components/catalog/ProductPicker';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { formatQtySpoken, messageOf, pluralUnit } from '@/lib/format';
import {
  setItemLowStock,
  setShopLowStock,
  useLowStockRule,
  useOwnLevels,
} from '@/lib/stacks/low-stock';
import styles from './low-stock-page.module.css';

/**
 * WHEN TO BE TOLD STOCK IS RUNNING OUT — a page, not a field in Settings.
 *
 * It started as one box under the shop's other preferences, and that was wrong for a reason worth
 * writing down: the general level is only half the setting. The other half is the exceptions, and
 * they were invisible — the only place an item's own level appeared was inside that item's own form,
 * so a shop that had set five of them over three months could not find out which five. A setting
 * nobody can list is a setting nobody trusts, and an untrusted warning gets ignored, which is the
 * whole feature gone.
 *
 * So both halves live here, next to each other, and the list says what each exception means against
 * the general rule. An item's level can also be set from the item's own page, which is where
 * somebody looking at a shelf that ran out on Saturday actually is.
 *
 * BLANK IS NOT ZERO, everywhere on this page. Blank means "follow the shop" for an item and "do not
 * warn me at all" for the shop; 0 is a real level meaning "only when there are none". A shop selling
 * something rare it orders in on request wants exactly that, and folding the two together would
 * silence the general rule on every item anybody had ever opened.
 */
export default function LowStockPage() {
  const sayStore = useAuth().store;
  const say = useSayInShapes(sayStore?.id ?? null);
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const problem = useProblem();

  const rule = useLowStockRule(store?.id ?? null);
  const own = useOwnLevels(store?.id ?? null);

  /*
   * The general level as it is being typed.
   *
   * Seeded from the shop once it arrives and NOT re-seeded afterwards: this page stays mounted while
   * the picker is open, and a re-seed on every refresh would take the figure out from under somebody
   * mid-keystroke.
   */
  const [general, setGeneral] = useState('');
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !rule.loaded) return;
    setSeeded(true);
    setGeneral(rule.data?.level == null ? '' : String(rule.data.level));
  }, [rule.loaded, rule.data, seeded]);

  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!store) return null;

  const status: PageStatus =
    !rule.loaded || !own.loaded
      ? { state: 'loading', what: 'your stock warnings' }
      : rule.error || own.error
        ? {
            state: 'error',
            what: 'your stock warnings',
            error: String(rule.error ?? own.error),
            // Both, because either could be the one that failed and a retry of half of it leaves the
            // page in the same state with a different reason.
            onRetry: () => {
              void rule.reload();
              void own.reload();
            },
          }
        : { state: 'ready' };

  const typed = general.trim();
  const wanted = typed === '' ? null : Number(typed);
  const dirty = wanted !== (rule.data?.level ?? null);

  const saveGeneral = async () => {
    if (typed !== '' && !Number.isFinite(wanted)) {
      problem.show('That is not a number.');
      return;
    }
    setSaving(true);
    setNote(null);
    try {
      await setShopLowStock(store.id, wanted);
      await rule.reload();
      await own.reload();
      setNote(
        wanted === null
          ? 'Warnings are off. Nothing will be marked as running low.'
          : `Every item without its own level warns at ${wanted}.`,
      );
    } catch (e: unknown) {
      problem.show(messageOf(e, 'Could not save that level'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="Running low"
      subtitle="When to be told stock is running out"
    >
      <ProblemDialog problem={problem} title="Could not save that" />

      <PageState status={status}>
        {() => (
          <>
            <Explain label="How does this work?">
              One level covers everything you sell. Any item can be given its own instead, and that
              one wins — useful for the few lines you cannot afford to run out of, and for the slow
              ones you do not want to hear about. Counted in the smallest unit each item is kept in.
            </Explain>

            {/* ── The general rule ───────────────────────────────────────────── */}
            <h2 className={styles.section}>Everything you sell</h2>
            <Field
              label="Tell me when an item gets down to"
              numeric
              value={general}
              onChange={(e) => setGeneral(e.target.value)}
              placeholder="Leave blank for no warning"
              hint="Leave it blank and nothing is marked as running low. Zero means tell me only when there are none at all."
            />
            <Button fullWidth busy={saving} busyLabel="Saving" disabled={!dirty} onClick={() => void saveGeneral()}>
              {dirty ? 'Save this level' : 'Saved'}
            </Button>

            {note && (
              <p className={styles.note} role="status">
                {note}
              </p>
            )}

            {rule.data?.level == null && (
              <InfoPanel tone="info" title="No warnings at the moment">
                Nothing is marked as running low anywhere in the app until this has a number in it —
                or until an item is given its own level below.
              </InfoPanel>
            )}

            {/* ── The exceptions ─────────────────────────────────────────────── */}
            <h2 className={styles.section}>Items that are different</h2>
            <p className={styles.sectionNote}>
              {(own.data ?? []).length === 0
                ? 'None yet. Add one for anything that should warn sooner or later than the rest.'
                : `${(own.data ?? []).length} ${
                    (own.data ?? []).length === 1 ? 'item has' : 'items have'
                  } a level of their own.`}
            </p>

            <ul className={styles.list}>
              {(own.data ?? []).map((item) => (
                <li key={item.productId} className={styles.row}>
                  <button
                    type="button"
                    className={styles.rowMain}
                    onClick={() => void nav.push('product_page', { id: item.productId })}
                  >
                    <span className={styles.rowName}>{item.name}</span>
                    <span className={styles.rowDetail}>
                      Warns at {say(item.productId, Number(item.ownLevel), item.baseUnit)}
                      {/*
                        Said against the general rule, because "warns at 5" means nothing on its own —
                        the reason a shop set it is that everything else warns at something different.
                      */}
                      {item.shopLevel !== null && item.shopLevel !== item.ownLevel && (
                        <> · everything else at {say(item.productId, Number(item.shopLevel), item.baseUnit)}</>
                      )}
                      {' · '}
                      {say(item.productId, Number(item.onHand), item.baseUnit)} on hand
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.rowDrop}
                    aria-label={`Put ${item.name} back under the shop's level`}
                    onClick={async () => {
                      setNote(null);
                      try {
                        await setItemLowStock(item.productId, null);
                        await own.reload();
                        setNote(`${item.name} follows the shop's level again.`);
                      } catch (e: unknown) {
                        problem.show(messageOf(e, 'Could not clear that'));
                      }
                    }}
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>

            <Button variant="secondary" fullWidth onClick={() => setPicking(true)}>
              <PlusIcon /> Add an item
            </Button>
          </>
        )}
      </PageState>

      {/*
        THE ITEM IS PICKED HERE, and its level is then set on the item's own page.

        Rather than a second little form on this page: the item's page already shows what is on the
        shelf, what it cost and how it sells, which is the context somebody deciding a level actually
        needs. Two places to type the same number is two places for them to disagree.
      */}
      <ProductPicker
        open={picking}
        onClose={() => setPicking(false)}
        storeId={store.id}
        onPick={(product) => {
          setPicking(false);
          // Just the id. A `focus` hint went here in a first draft and nothing on the product page
          // ever read it — a parameter no reader honours is a promise the URL does not keep.
          void nav.push('product_page', { id: product.id });
        }}
      />
    </PageScaffold>
  );
}
