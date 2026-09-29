'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { InfoPanel } from '@/components/ui/Explain';
import { SaleLineRow } from '@/components/sell/SaleLineRow';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { fetchProduct } from '@/lib/stacks/catalog-stack';
import { lineTotal, useDraftOrders, type DraftLine } from '@/lib/stacks/draft-orders';
import { useTillShapes } from '@/lib/stacks/till-shapes';
import { useSellingUnits } from '@/lib/stacks/selling-units';
import { useUncountedToday } from '@/lib/stacks/count-gate';
import { lineShape, unpricedOnSale } from '@/lib/stacks/price-gate';
import { lineRules, resolveLinePrice, startLine } from '@/lib/stacks/sale-line-ops';
import { formatMoney, messageOf } from '@/lib/format';
import styles from './sale-line-page.module.css';

/**
 * ONE LINE OF AN OPEN SALE, on its own page — pushed from Take payment.
 *
 * "Each line in 'what they are buying' to be clickable to push a sales line page so we can edit
 * that line … reusing the sales line component … and when we pick a product in take payment it
 * pushes the sales line with the product."
 *
 * The row is the till's own `SaleLineRow` — the shape chips, the stepper, the parts, the tap-the-
 * total — and the line logic is the till's (`sale-line-ops`), so a crate costs the same here as on
 * the sell screen. Nothing on the payment page is lost by coming here: it is pushed, not popped.
 *
 * TWO INTENTS, by what travels in the push (never a record — ids only):
 *
 *   { id, line }     a line already on the sale. Edited in place; the payment page's total
 *                    follows as it is typed.
 *   { id, product }  an item being added. Composed here and put on the sale only on "Add to
 *                    sale" — Cancel leaves the sale exactly as it was. An item already on the
 *                    sale in the same shape opens that line instead, the till's rule against two
 *                    "Coca-Cola PET" lines on one receipt.
 */
export default function SaleLinePage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const wantedId = (location?.params?.id as string | undefined) ?? null;
  const lineKey = (location?.params?.line as string | undefined) ?? null;
  const productParam = (location?.params?.product as string | undefined) ?? null;

  const { orders, activeOrder: current, updateLine, addLine, removeLine, syncing } =
    useDraftOrders(store?.id ?? null);
  const order = wantedId ? (orders.find((o) => o.id === wantedId) ?? null) : current;

  /* ── Adding: the product read back, and the line composed from it ─────────────────── */
  const [draft, setDraft] = useState<DraftLine | null>(null);
  /** An add that found the item already on the sale edits that line instead. */
  const [mergedKey, setMergedKey] = useState<string | null>(null);
  const [addProblem, setAddProblem] = useState<string | null>(null);

  const productId =
    productParam ?? order?.lines.find((l) => l.key === lineKey)?.productId ?? null;
  const productIds = useMemo(() => (productId ? [productId] : []), [productId]);
  const { shapes, ensure } = useTillShapes(store?.id ?? null, productIds);
  const { byProduct: sellingUnits } = useSellingUnits(store?.id ?? null);

  const started = useRef(false);
  useEffect(() => {
    if (!productParam || !order || started.current) return;
    started.current = true;
    void (async () => {
      try {
        const [product, units] = await Promise.all([fetchProduct(productParam), ensure(productParam)]);
        if (!product) throw new Error('That item could not be found.');
        const fresh = startLine(product, units);
        const existing = order.lines.find(
          (l) => l.productId === product.id && l.saleUnitId === fresh.saleUnitId,
        );
        if (existing) setMergedKey(existing.key);
        else setDraft(fresh);
      } catch (e) {
        setAddProblem(messageOf(e, 'That item could not be added.'));
      }
    })();
  }, [productParam, order, ensure]);

  const editingKey = lineKey ?? mergedKey;
  const onSale = editingKey ? (order?.lines.find((l) => l.key === editingKey) ?? null) : null;
  const line = onSale ?? draft;
  const adding = !onSale && !!draft;

  /* ── The till's gates, said on the line ───────────────────────────────────────────── */
  const { uncounted } = useUncountedToday(store?.id ?? null, productIds);
  const needsPrice = useMemo(
    () => (line ? unpricedOnSale([line], sellingUnits).length > 0 : false),
    [line, sellingUnits],
  );

  if (!store) return null;

  const lineShapes = line ? (shapes[line.productId] ?? []) : [];

  /** One patch, to wherever this line lives: the sale, or the line being composed. */
  const patch = (p: Partial<DraftLine>) => {
    if (!line) return;
    if (onSale && order) updateLine(order.clientUuid, onSale.key, p);
    else setDraft((prev) => (prev ? { ...prev, ...p } : prev));
  };

  const reprice = async (qty: string, saleUnitId: string | null) => {
    if (!line) return;
    const r = await resolveLinePrice(line, qty, saleUnitId, order?.customerId ?? null);
    if (r) patch(r);
  };

  /** Priced under what the stock cost. A warning, never a block — the seller may mean it. */
  const belowCost = (() => {
    if (!line || !line.unitPrice) return false;
    const shape = lineShape(line, sellingUnits.get(line.productId) ?? []);
    return !!shape && shape.avgCost > 0 && Number(line.unitPrice) < shape.avgCost;
  })();

  const status: PageStatus = addProblem
    ? { state: 'empty', title: 'That item could not be added', body: addProblem }
    : !order
      ? syncing || (wantedId && orders.length === 0)
        ? { state: 'loading', what: 'this sale' }
        : {
            state: 'empty',
            title: 'This sale is no longer open',
            body: 'It was settled or closed. Start a new one from the Sell screen.',
          }
      : !line
        ? lineKey
          ? {
              state: 'empty',
              title: 'That line is no longer on the sale',
              body: 'It was taken off, here or on another till.',
            }
          : { state: 'loading', what: 'the item' }
        : { state: 'ready' };

  return (
    <PageScaffold
      onBack={goBack}
      title={adding ? 'Add to the sale' : 'Change this line'}
      subtitle={order?.customerName || 'This sale'}
    >
      <PageState status={status}>
        {() =>
          line &&
          order && (
            <>
              {mergedKey && (
                <InfoPanel tone="info" title="Already on this sale">
                  {line.productName} is on the sale in this shape, so this is that line — change how
                  many here rather than adding it twice.
                </InfoPanel>
              )}

              <div className={styles.row}>
                <SaleLineRow
                  line={line}
                  shapes={lineShapes}
                  rules={lineRules(line, lineShapes)}
                  total={lineTotal(line)}
                  belowCost={belowCost}
                  needsCount={uncounted.includes(line.productId)}
                  needsPrice={needsPrice}
                  onPatch={(p) => patch(p as Partial<DraftLine>)}
                  onRemove={() => {
                    if (onSale) removeLine(order.clientUuid, onSale.key);
                    void nav.pop();
                  }}
                  onStep={(direction) => {
                    const now = Number(line.qty);
                    const next = (Number.isFinite(now) ? now : 0) + direction;
                    if (next < 0) return;
                    patch({ qty: String(next) });
                    void reprice(String(next), line.saleUnitId);
                  }}
                  onReprice={(qty, saleUnitId) => reprice(qty, saleUnitId)}
                  onCountNow={() => void nav.push('count_gate_page', { focus: line.productId })}
                  onPriceNow={() => void nav.push('price_gate_page')}
                />
              </div>

              <p className={styles.total}>
                <span>This line</span>
                <strong>{formatMoney(lineTotal(line))}</strong>
              </p>

              {/* The action ENDS the page rather than being pinned to its foot — see CLAUDE.md. */}
              <div className={styles.actions}>
                {adding ? (
                  <>
                    <Button variant="secondary" onClick={() => void nav.pop()}>
                      Cancel
                    </Button>
                    <Button
                      disabled={!(Number(line.qty) > 0)}
                      onClick={() => {
                        addLine(order.clientUuid, line);
                        void nav.pop();
                      }}
                    >
                      Add to sale
                    </Button>
                  </>
                ) : (
                  <Button fullWidth disabled={!(Number(line.qty) > 0)} onClick={() => void nav.pop()}>
                    {Number(line.qty) > 0 ? 'Done' : 'Say how many first'}
                  </Button>
                )}
              </div>
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
