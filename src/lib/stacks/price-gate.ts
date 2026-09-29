'use client';

import { useMemo } from 'react';
import type { DraftLine } from './draft-orders';
import { useSellingUnits, type SellingUnit } from './selling-units';

/**
 * A shape on this sale that the shop has never priced.
 *
 * One per SHAPE, not per line: two lines of Pepsi by the pack are one price to set.
 */
export interface Unpriced {
  productId: string;
  productName: string;
  productUnitId: string;
  /** "Pack", "Crate" — the shape the line is being sold in. */
  shapeName: string;
  /** What the seller typed on the line, if anything — offered as the price, never assumed. */
  typed: string | null;
  /** The blended cost of one of this shape, so a price is never set below it by accident. */
  cost: number;
}

/**
 * The shape a line is being sold in, as the shop has it.
 *
 * The line names it (`saleUnitId`, a product_unit id). An older line that does not is sold in the
 * item's default shape — the same one the till would have priced it from.
 */
export function lineShape(line: DraftLine, shapes: SellingUnit[]): SellingUnit | null {
  const sold = shapes.filter((u) => u.isSold);
  return (
    sold.find((u) => u.productUnitId === line.saleUnitId) ??
    sold.find((u) => u.isDefault) ??
    [...sold].sort((a, b) => a.baseQty - b.baseQty)[0] ??
    null
  );
}

/**
 * Every shape on these lines with no price.
 *
 * The price is the SHOP's, not the line's. A figure typed on the line sells this one sale, and the
 * next seller meets the same blank — so the gate asks for the shape's price, and offers what was
 * typed as the answer.
 */
export function unpricedOnSale(
  lines: DraftLine[],
  byProduct: Map<string, SellingUnit[]>,
): Unpriced[] {
  const out = new Map<string, Unpriced>();
  for (const l of lines) {
    const shape = lineShape(l, byProduct.get(l.productId) ?? []);
    // No shape it is sold in at all is a different fault, said on the item; the server still
    // refuses a line at N0 (0221).
    if (!shape || (shape.price != null && shape.price > 0)) continue;
    if (out.has(shape.productUnitId)) continue;
    out.set(shape.productUnitId, {
      productId: l.productId,
      productName: l.productName,
      productUnitId: shape.productUnitId,
      shapeName: shape.name,
      typed: Number(l.unitPrice) > 0 ? l.unitPrice : null,
      cost: shape.avgCost,
    });
  }
  return [...out.values()];
}

/**
 * What on this sale has no price — and whether that has been worked out yet.
 *
 * `checked` is false until the shop's shapes have been read: before then nothing is priced or
 * unpriced, and a till that settles on a guess is the fault this gate exists to stop.
 */
export function useUnpricedOnSale(storeId: string | null, lines: DraftLine[] | undefined) {
  const { byProduct, loaded, error, reload } = useSellingUnits(storeId);
  const unpriced = useMemo(
    () => (loaded ? unpricedOnSale(lines ?? [], byProduct) : []),
    [lines, byProduct, loaded],
  );
  return {
    unpriced,
    checked: (lines ?? []).length === 0 || loaded,
    error,
    reload,
  };
}
