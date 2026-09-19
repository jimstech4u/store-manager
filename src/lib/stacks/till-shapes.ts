'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { useInvalidation } from '@/lib/stacks/invalidation';
import { DERIVED_SCOPE, fetchSaleUnits, type SaleUnit } from '@/lib/stacks/catalog-stack';

/**
 * The shapes each item on the till is sold in — kept, and filled for every line, not only new ones.
 *
 * This was `useState` on the sell page, filled only when an item was ADDED. A reload, or the stack
 * restoring the till, came back with the open sales intact and the shapes gone: every line already
 * on a receipt lost its "Selling as" choice and the half/quarter rules of its shape, and a price
 * band keyed on the shape could not be found. Nothing looked broken until somebody tried to change
 * a quantity.
 *
 * Now the map is persisted per shop, and any item on an open sale that is not in it is read. A
 * catalogue change (a new price, a shape ticked or unticked) invalidates the derived scope, and
 * every item already known is read again — so the till never sells at yesterday's price.
 */
export function useTillShapes(storeId: string | null, productIds: string[]) {
  const [shapes, , setShapes] = useDemandState<Record<string, SaleUnit[]>>(
    {},
    {
      key: `till-shapes:${storeId ?? 'none'}`,
      scope: DERIVED_SCOPE,
      persist: true,
      deps: [storeId ?? ''],
      revalidateOnMount: false,
    },
  );

  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const inFlight = useRef(new Set<string>());

  /** Read these items' shapes — only the missing ones, unless `again` asks for all of them. */
  const read = useCallback(
    (ids: string[], again = false) => {
      for (const id of ids) {
        if (inFlight.current.has(id)) continue;
        if (!again && shapesRef.current[id]) continue;
        inFlight.current.add(id);
        fetchSaleUnits(id)
          .then((units) => setShapes((prev) => ({ ...prev, [id]: units })))
          .catch(() => {
            // Kept as it was. The line still sells; its shape choice waits for the next read.
          })
          .finally(() => inFlight.current.delete(id));
      }
    },
    [setShapes],
  );

  // Every item on an open sale, including the ones that were there before a reload.
  const key = useMemo(() => [...new Set(productIds)].sort().join(','), [productIds]);
  useEffect(() => {
    if (!storeId || !key) return;
    read(key.split(','));
  }, [storeId, key, read]);

  // A price or a shape changed somewhere: every item this till knows is read again.
  useInvalidation(storeId ? DERIVED_SCOPE : null, () => read(Object.keys(shapesRef.current), true));

  /** The shapes of one item, read now if this till has not seen it — for adding a line. */
  const ensure = useCallback(
    async (productId: string): Promise<SaleUnit[]> => {
      const known = shapesRef.current[productId];
      if (known) return known;
      const units = await fetchSaleUnits(productId);
      setShapes((prev) => ({ ...prev, [productId]: units }));
      return units;
    },
    [setShapes],
  );

  return { shapes, ensure };
}
