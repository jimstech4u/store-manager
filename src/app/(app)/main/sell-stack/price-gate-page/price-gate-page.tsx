'use client';

import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import { useDraftOrders } from '@/lib/stacks/draft-orders';
import { useSellingUnits } from '@/lib/stacks/selling-units';
import { lineShape, useUnpricedOnSale } from '@/lib/stacks/price-gate';
import { catalogChanged } from '@/lib/stacks/catalog-stack';
import { getSupabase } from '@/lib/supabase/client';
import { formatMoney, messageOf } from '@/lib/format';
import styles from './price-gate-page.module.css';

/**
 * Pricing an item before it can be sold — the count gate's twin.
 *
 * "Some product do not have price so we should block that as we did for count, which also push a
 * mid sale price list for items as count did."
 *
 * A GATE, NOT A SUGGESTION. An item with no price went onto a receipt at whatever the seller typed,
 * or at nothing, and the next seller met the same blank. The till says so on the line, the note and
 * the button, and pushes this page; Take payment will not settle until nothing is left here; and
 * the server refuses a line at N0 (0221) for a till running older code.
 *
 * THE SHOP'S PRICE, NOT THE LINE'S. One box per shape — "Pepsi PET · per pack" — prefilled with
 * whatever was typed on the line, so a seller who already agreed a figure with the customer saves
 * it in one tap. Saving sets the shape's price for every till, and fills any line on this sale that
 * was waiting for it.
 *
 * Setting a price is `products.manage`. A seller without it sees what is missing and who to ask —
 * the page never pretends they can fix it.
 */
export default function PriceGatePage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const { can } = usePermission();

  const { activeOrder, updateLine } = useDraftOrders(store?.id ?? null);
  const { byProduct } = useSellingUnits(store?.id ?? null);
  const { unpriced, checked, error, reload } = useUnpricedOnSale(
    store?.id ?? null,
    activeOrder?.lines,
  );
  // Another till may have priced it while this sale sat open.
  useLiveRefresh(nav, reload);

  const why = (location?.params?.why as string | undefined) ?? null;
  const mayPrice = can('products.manage');

  const [typed, setTyped] = useState<Record<string, string>>({});
  const [state, setState] = useState<AsyncState>('idle');
  const [failure, setFailure] = useState<string | null>(null);

  if (!store) return null;

  /* What is in each box: what was typed here, else what was typed on the line, else nothing. */
  const valueOf = (id: string, fallback: string | null) => typed[id] ?? fallback ?? '';
  const ready = unpriced.filter((u) => {
    const n = Number(valueOf(u.productUnitId, u.typed));
    return Number.isFinite(n) && n > 0;
  });

  const save = async () => {
    setState('busy');
    setFailure(null);
    try {
      const set = new Map<string, number>();
      for (const u of ready) {
        const price = Number(valueOf(u.productUnitId, u.typed));
        const { error: err } = await getSupabase().rpc('set_shape_price', {
          p_product_unit_id: u.productUnitId,
          p_price: price,
        });
        if (err) throw err;
        set.set(u.productUnitId, price);
      }

      /*
       * THE LINES WAITING FOR IT. A line with nothing on it takes the new price; a line the seller
       * already priced keeps theirs — it is what was agreed with the customer standing there.
       */
      if (activeOrder) {
        for (const l of activeOrder.lines) {
          const shape = lineShape(l, byProduct.get(l.productId) ?? []);
          const price = shape ? set.get(shape.productUnitId) : undefined;
          if (price === undefined || Number(l.unitPrice) > 0) continue;
          updateLine(activeOrder.clientUuid, l.key, {
            unitPrice: String(price),
            priceReason: 'list',
          });
        }
      }

      // Every till's shapes re-read, this one's gate included.
      catalogChanged();
      setState('idle');
      setTyped({});
      if (set.size === unpriced.length) void nav.pop();
    } catch (e) {
      setState('failed');
      setFailure(messageOf(e, 'That price could not be saved.'));
    }
  };

  const status: PageStatus = !checked
    ? error
      ? { state: 'error', what: 'what these items sell for', error, onRetry: reload }
      : { state: 'loading', what: 'what these items sell for' }
    : { state: 'ready' };

  const lead =
    why === 'share'
      ? 'The order can be shared once everything on it has a price.'
      : why === 'pay'
        ? 'Payment can be taken once everything on it has a price.'
        : `The sale cannot be settled until ${unpriced.length === 1 ? 'it has' : 'they have'} one.`;

  return (
    <PageScaffold onBack={goBack} title="Price before selling" subtitle="What each one sells for">
      <PageState status={status}>
        {() =>
          unpriced.length === 0 ? (
            <InfoPanel tone="success" title="Everything on this sale has a price">
              Go back and carry on with the sale.
            </InfoPanel>
          ) : (
            <>
              <p className={styles.lead}>
                {unpriced.length === 1 ? 'This item has' : 'These items have'} no price yet, so{' '}
                {unpriced.length === 1 ? 'it' : 'they'} cannot be sold. {lead} The price you set
                here is the shop&rsquo;s, for every till.
              </p>

              {!mayPrice ? (
                <InfoPanel tone="warning" title="Ask someone who sets prices">
                  {unpriced
                    .map((u) => `${u.productName} (per ${u.shapeName.toLowerCase()})`)
                    .join(', ')}{' '}
                  {unpriced.length === 1 ? 'needs' : 'need'} a price, and setting one is the
                  owner&rsquo;s or a manager&rsquo;s job. Once it is set, this sale can be settled.
                </InfoPanel>
              ) : (
                <ul className={styles.list}>
                  {unpriced.map((u) => {
                    const v = valueOf(u.productUnitId, u.typed);
                    const n = Number(v);
                    const below = u.cost > 0 && n > 0 && n < u.cost;
                    return (
                      <li key={u.productUnitId} className={styles.row}>
                        <Field
                          label={`${u.productName} · per ${u.shapeName.toLowerCase()}`}
                          numeric
                          value={v}
                          onChange={(e) =>
                            setTyped((prev) => ({ ...prev, [u.productUnitId]: e.target.value }))
                          }
                          placeholder="0"
                          hint={
                            u.cost > 0 ? `One costs ${formatMoney(u.cost)}` : 'Cost not recorded yet'
                          }
                        />
                        {below && (
                          <p className={styles.warn}>
                            That is below what one costs ({formatMoney(u.cost)}).
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* The action ENDS the page rather than being pinned to its foot — see CLAUDE.md. */}
              <div className={styles.pageActions}>
                <Button
                  variant="secondary"
                  onClick={() => void nav.pop()}
                  disabled={state === 'busy'}
                >
                  Not now
                </Button>
                {mayPrice && (
                  <AsyncAction state={state} problem={failure} label="Saving the price">
                    <Button disabled={ready.length === 0} onClick={() => void save()}>
                      {ready.length === 0
                        ? 'Nothing priced yet'
                        : `Save ${ready.length} ${ready.length === 1 ? 'price' : 'prices'}`}
                    </Button>
                  </AsyncAction>
                )}
              </div>

              {mayPrice && ready.length > 0 && ready.length < unpriced.length && (
                <InfoPanel tone="warning" title={`${unpriced.length - ready.length} still to price`}>
                  You can save what you have priced now, but the sale will not settle until every
                  item on it has a price.
                </InfoPanel>
              )}
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
