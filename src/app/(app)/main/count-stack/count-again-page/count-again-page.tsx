'use client';

import { useMemo, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { CountedToday } from '@/components/stock/CountedToday';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import { useProduct } from '@/lib/stacks/catalog-stack';
import { stockInShapes, useSellingUnits, type SellingUnit } from '@/lib/stacks/selling-units';
import { recountToday, useTodaysCounts } from '@/lib/stacks/count-gate';
import { messageOf } from '@/lib/format';
import styles from './count-again-page.module.css';

/**
 * Counting the shelf again, later the same day.
 *
 * A shop counts more than once a day and both walks are real: a delivery lands at two, somebody
 * walks the shelf again at six. What 0145 called a "correction" was that, misnamed — so there is one
 * act now, counting again, and it keeps everything the correction kept.
 *
 *   · Only an owner or manager may do it. Replacing a figure somebody else recorded is not a
 *     seller's decision, and the server refuses it whatever this screen shows.
 *   · A reason is required, and offered as one tap — "a delivery came in" is the commonest and
 *     should not need typing.
 *   · The figure being replaced is written to the trail BEFORE anything moves, so what the shelf
 *     was said to hold at nine is still answerable at six.
 *
 * The till never reaches here: counting mid-sale is once a day, for everybody.
 */

/** The reasons a shelf gets counted twice, in the order they actually happen. */
const WHY = [
  { code: 'delivery', label: 'A delivery came in', hint: 'Stock arrived since the last count' },
  { code: 'sold', label: 'A lot has been sold since', hint: 'The shelf has moved during the day' },
  { code: 'wrong', label: 'The first count was wrong', hint: 'A stack was missed or double counted' },
  { code: 'closing', label: 'Closing the day', hint: 'The end-of-day walk of the shelf' },
  { code: 'other', label: 'Something else', hint: 'Say what it is below' },
] as const;

export default function CountAgainPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const { can } = usePermission();

  const productId = (location?.params?.id as string | undefined) ?? null;
  const { product } = useProduct(productId);
  const { byProduct } = useSellingUnits(store?.id ?? null);

  const ids = useMemo(() => (productId ? [productId] : []), [productId]);
  const { byProduct: counts, reload } = useTodaysCounts(store?.id ?? null, ids);
  // Somebody else may count it while this is open; the figure being replaced must be today's.
  useLiveRefresh(nav, reload);

  const today = productId ? counts.get(productId) ?? null : null;

  const shapes = useMemo(
    () =>
      [...(byProduct.get(productId ?? '') ?? [])].sort(
        (a: SellingUnit, b: SellingUnit) => b.baseQty - a.baseQty,
      ),
    [byProduct, productId],
  );

  const [byShape, setByShape] = useState<Record<string, string>>({});
  const [why, setWhy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = useProblem();

  const anySaid =
    shapes.length > 0
      ? shapes.some((u) => (byShape[u.productUnitId] ?? '').trim() !== '')
      : (byShape.base ?? '').trim() !== '';

  const newBase = useMemo(
    () =>
      shapes.length > 0
        ? shapes.reduce((sum, u) => {
            const n = Number(byShape[u.productUnitId]);
            return sum + (Number.isFinite(n) ? n * u.baseQty : 0);
          }, 0)
        : Number(byShape.base) || 0,
    [byShape, shapes],
  );

  const say = (base: number) =>
    shapes.length > 0
      ? stockInShapes(shapes.map((u) => ({ ...u, onHandBase: base })))
      : String(base);

  if (!store || !productId) return null;

  if (!can('counts.correct')) {
    return (
      <PageScaffold onBack={goBack} title="Count it again" subtitle={product?.name}>
        <InfoPanel tone="info" title="A manager counts the shelf again">
          Today&rsquo;s count stands until an owner or manager walks the shelf again. That way a figure
          somebody recorded cannot be quietly replaced — every fresh count is kept with the one
          before it, and the name of whoever entered each.
        </InfoPanel>
      </PageScaffold>
    );
  }

  if (!today) {
    return (
      <PageScaffold onBack={goBack} title="Count it again" subtitle={product?.name}>
        <InfoPanel tone="info" title="Nothing counted yet today">
          {product?.name ?? 'This item'} has not been counted today, so there is nothing to replace.
          Count it on the item&rsquo;s own screen.
        </InfoPanel>
      </PageScaffold>
    );
  }

  const chosen = WHY.find((w) => w.code === why) ?? null;
  const reason = chosen
    ? chosen.code === 'other'
      ? note.trim()
      : note.trim()
        ? `${chosen.label} — ${note.trim()}`
        : chosen.label
    : '';
  const same = anySaid && Math.abs(newBase - today.countedBase) < 0.0001;
  const canSave = anySaid && reason.length > 0 && newBase >= 0 && !busy;

  const save = async () => {
    setBusy(true);
    try {
      await recountToday(productId, newBase, reason);
      void nav.pop();
    } catch (e) {
      problem.show(messageOf(e, 'That count could not be saved'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageScaffold onBack={goBack} title="Count it again" subtitle={product?.name}>
      <ProblemDialog problem={problem} title="Could not save this count" />

      {/* WHAT STANDS NOW, with the whole day's trail under it — replaced, never deleted. */}
      <CountedToday storeId={store.id} count={today} shapes={shapes} baseUnit={product?.baseUnit} />

      <h2 className={styles.ask}>What is on the shelf now?</h2>
      <div className={styles.shapeBoxes}>
        {shapes.length > 0 ? (
          shapes.map((u) => (
            <Field
              key={u.productUnitId}
              label={u.plural}
              numeric
              value={byShape[u.productUnitId] ?? ''}
              onChange={(e) =>
                setByShape((prev) => ({ ...prev, [u.productUnitId]: e.target.value }))
              }
              placeholder="0"
              hint={u.baseQty > 1 ? `one is ${u.baseQty}` : undefined}
            />
          ))
        ) : (
          <Field
            label="How many"
            numeric
            value={byShape.base ?? ''}
            onChange={(e) => setByShape({ base: e.target.value })}
            placeholder="0"
          />
        )}
      </div>

      {anySaid && (
        <p className={styles.said}>
          {same
            ? `Same as the count that stands — ${say(newBase)}. Saving it keeps the trail, with your name on this walk.`
            : `${say(today.countedBase)} → ${say(newBase)}`}
        </p>
      )}

      {/* ONE TAP, because the reason is nearly always the same four things. */}
      <h2 className={styles.ask}>Why are you counting again?</h2>
      <div className={styles.whyList}>
        {WHY.map((w) => (
          <button
            key={w.code}
            type="button"
            className={`${styles.why} ${why === w.code ? styles.whyOn : ''}`}
            aria-pressed={why === w.code}
            onClick={() => setWhy(w.code)}
          >
            <span className={styles.whyName}>{w.label}</span>
            <span className={styles.whyHint}>{w.hint}</span>
          </button>
        ))}
      </div>

      <Field
        label={chosen?.code === 'other' ? 'What happened?' : 'Anything to add'}
        optional={chosen?.code !== 'other'}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Kept with the count, for whoever reads it back"
      />

      <div className={styles.action}>
        <Button
          size="large"
          fullWidth
          busy={busy}
          busyLabel="Saving"
          disabled={!canSave}
          onClick={() => void save()}
        >
          Save this count
        </Button>
        <p className={styles.trace}>
          The figure it replaces, your name and this reason are kept together. Nothing is deleted.
        </p>
      </div>
    </PageScaffold>
  );
}
