'use client';

import { useMemo, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { useSellingUnits } from '@/lib/stacks/selling-units';
import { catalogChanged } from '@/lib/stacks/catalog-stack';
import { formatMoney, messageOf } from '@/lib/format';
import styles from './shape-price-page.module.css';

/**
 * What one shape sells for.
 *
 * Reached by tapping the price on the product screen, which is where somebody is standing when they
 * decide it has to change. The alternative was the whole edit form — eleven questions to alter one
 * figure — and before that, the shapes screen, which sends the ENTIRE tree back to the server to
 * move one number.
 *
 * IT SHOWS THE COST AND DOES NOT REFUSE. A shop sells below cost on purpose: clearing short-dated
 * stock, matching the shop across the road, a favour to somebody who buys every week. A screen that
 * refuses is a screen somebody works around, and then the price lives somewhere the app cannot see.
 * So the margin is stated plainly, in the shop's own shape, and the decision stays with the person
 * making it.
 */
export default function ShapePricePage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const problem = useProblem();

  const productId = (location?.params?.id as string | undefined) ?? null;
  const shapeId = (location?.params?.shape as string | undefined) ?? null;

  const { byProduct } = useSellingUnits(store?.id ?? null);
  const shape = useMemo(
    () => (byProduct.get(productId ?? '') ?? []).find((u) => u.productUnitId === shapeId) ?? null,
    [byProduct, productId, shapeId],
  );

  const [price, setPrice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Seeded from the shape once, then owned by the form — re-seeding on every render would fight
  // whoever is typing.
  const value = price ?? (shape?.price != null ? String(shape.price) : '');

  const cost = Number(shape?.avgCost ?? 0);
  const asked = Number(value);
  const hasPrice = value.trim() !== '' && Number.isFinite(asked);
  const belowCost = hasPrice && cost > 0 && asked < cost;
  const margin = hasPrice && cost > 0 ? asked - cost : null;

  const save = async () => {
    if (!shape) return;
    setBusy(true);
    try {
      const { error } = await getSupabase().rpc('set_shape_price', {
        p_product_unit_id: shape.productUnitId,
        // Blank clears it: "no price yet" is a real state, and a shop that has not decided must be
        // able to say so rather than being made to type a number it does not mean.
        p_price: value.trim() === '' ? null : asked,
      });
      if (error) throw error;
      catalogChanged();
      await nav.pop();
    } catch (e) {
      problem.show(messageOf(e, 'That price could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  if (!shape) {
    return (
      <PageScaffold onBack={goBack} title="Price">
        <InfoPanel tone="info" title="That shape is not on this item">
          It may have been removed. Go back and open the item again.
        </InfoPanel>
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      onBack={goBack}
      title={`Price for one ${shape.name.toLowerCase()}`}
      subtitle={
        shape.baseQty > 1
          ? `One ${shape.name.toLowerCase()} is ${shape.baseQty}`
          : 'The smallest this comes in'
      }
    >
      <ProblemDialog problem={problem} title="Not saved" />

      <Field
        label={`What one ${shape.name.toLowerCase()} sells for`}
        numeric
        prefix="₦"
        value={value}
        onChange={(e) => setPrice(e.target.value)}
        placeholder="0"
        hint="Leave it blank if you have not decided — the till will ask."
        autoFocus
      />

      {/*
        THE COST, SAID PLAINLY, AND NEVER A REFUSAL.

        A shop sells below cost on purpose more often than software expects. What it needs is to
        know it is doing so — a number, not a locked button.
      */}
      <div className={styles.cost}>
        <span className={styles.costLabel}>What one costs you</span>
        <span className={styles.costValue}>
          {cost > 0 ? formatMoney(cost, 2) : 'nothing recorded yet'}
        </span>
      </div>

      {belowCost && (
        <InfoPanel tone="danger" title="This is below what it cost you">
          One {shape.name.toLowerCase()} cost {formatMoney(cost, 2)} and you would be selling at{' '}
          {formatMoney(asked)} — losing {formatMoney(cost - asked, 2)} each time. That is sometimes
          exactly right; it is here so nobody does it by accident.
        </InfoPanel>
      )}

      {!belowCost && margin !== null && margin > 0 && (
        <p className={styles.margin}>
          {formatMoney(margin, 2)} on each one, over what it cost you.
        </p>
      )}

      {/* The actions END the page rather than being pinned to its foot — see CLAUDE.md. */}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={goBack} disabled={busy}>
          Cancel
        </Button>
        <Button busy={busy} busyLabel="Saving" onClick={() => void save()}>
          Save the price
        </Button>
      </div>
    </PageScaffold>
  );
}
