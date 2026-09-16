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
import { correctTodaysCount, useTodaysCounts } from '@/lib/stacks/count-gate';
import { messageOf } from '@/lib/format';
import styles from './count-correct-page.module.css';

/**
 * Changing a count that has already been entered today.
 *
 * A day's count is said once, by whoever gets to the shelf first — at the till or on the count
 * screen. When it was wrong, an owner or manager corrects it HERE, never by counting again: the new
 * figure, and a reason, are added to the day's trail beside the original, which keeps its counter
 * and its time. Anybody opening the item afterwards sees both.
 *
 * Pushed with `{ id }` — the product. The count itself is always read from the server, because
 * the whole point is that the figure on this screen is the one that stands.
 */
export default function CountCorrectPage() {
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
  // Another manager may correct it while this is open; the trail on screen must be today's.
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
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = useProblem();

  const anySaid = shapes.length > 0
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
      <PageScaffold onBack={goBack} title="Correct the count" subtitle={product?.name}>
        <InfoPanel tone="info" title="Only an owner or manager can change a count">
          Once a count is entered it stands for the day. If it is wrong, ask an owner or manager to
          correct it — the change is kept beside the original, with their name and the reason.
        </InfoPanel>
      </PageScaffold>
    );
  }

  if (!today) {
    return (
      <PageScaffold onBack={goBack} title="Correct the count" subtitle={product?.name}>
        <InfoPanel tone="info" title="Nothing to correct yet">
          {product?.name ?? 'This item'} has no count today. Count the shelf first — a correction
          changes a count that has already been entered.
        </InfoPanel>
      </PageScaffold>
    );
  }

  const same = anySaid && Math.abs(newBase - today.countedBase) < 0.0001;
  const canSave = anySaid && !same && reason.trim().length > 0 && newBase >= 0;

  const save = async () => {
    setBusy(true);
    try {
      await correctTodaysCount(productId, newBase, reason);
      void nav.pop();
    } catch (e) {
      problem.show(messageOf(e, 'The correction could not be saved'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageScaffold onBack={goBack} title="Correct the count" subtitle={product?.name}>
      <ProblemDialog problem={problem} title="Could not correct the count" />

      <CountedToday
        storeId={store.id}
        count={today}
        shapes={shapes}
        baseUnit={product?.baseUnit}
      />

      <h2 className={styles.ask}>What is really on the shelf?</h2>
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
            ? 'That is the figure already recorded.'
            : `From ${say(today.countedBase)} to ${say(newBase)}`}
        </p>
      )}

      <Field
        label="Why is it being changed?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. a stack behind the door was missed"
        hint="Kept with the count, beside who counted it first."
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
          Save the correction
        </Button>
      </div>
    </PageScaffold>
  );
}
