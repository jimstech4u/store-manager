'use client';

import { getSupabase } from '@/lib/supabase/client';
import { startingQty, type QuantityRules } from '@/lib/quantity-rules';
import type { Product, SaleUnit } from './catalog-stack';
import { makeDraftLine, type DraftLine } from './draft-orders';

/**
 * WHAT A SALE LINE DOES, whichever screen it is on — the till, and the sale-line page pushed from
 * Take payment.
 *
 * These were closures inside the sell page. A second screen that edits a line would otherwise carry
 * a second copy of "which parts may this shape be sold in", "what does it cost at this quantity" and
 * "what does a new line start at" — and the first time one of them changed, the till and the
 * payment page would quote the same crate two different prices.
 */

/** The part-amount rules for whichever shape a line is being sold in. */
export function lineRules(line: Pick<DraftLine, 'saleUnitId'>, shapes: SaleUnit[]): QuantityRules {
  const unit = shapes.find((u) => u.id === line.saleUnitId);
  return {
    wholeDigit: unit?.wholeDigit ?? true,
    allowQuarter: unit?.allowQuarter ?? false,
    allowHalf: unit?.allowHalf ?? false,
    allowThreeQuarter: unit?.allowThreeQuarter ?? false,
  };
}

/**
 * What this line should cost at this quantity and shape, asked of the server.
 *
 * `resolve_price` knows the bulk ladder and any rate agreed with this customer, and takes the
 * better of the two. Null when there is nothing to suggest, or the question failed — a line must
 * never break because a suggestion did not load; the seller can always type a price.
 */
export async function resolveLinePrice(
  line: Pick<DraftLine, 'productId' | 'priceTouched'>,
  qty: string,
  saleUnitId: string | null,
  customerId: string | null,
): Promise<{ unitPrice: string; priceReason: string | null } | null> {
  // Never overwrite a figure the seller typed: a favour or a haggle is a decision, not a gap.
  if (line.priceTouched) return null;
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return null;

  const { data, error } = await getSupabase().rpc('resolve_price', {
    p_product_id: line.productId,
    p_qty: n,
    p_sale_unit_id: saleUnitId,
    p_customer_id: customerId,
  });
  if (error || !data) return null;

  const r = data as { suggested?: string | number | null; reason?: string | null };
  if (r.suggested === null || r.suggested === undefined) return null;
  return { unitPrice: String(r.suggested), priceReason: r.reason ?? null };
}

/**
 * A new line for this product — in its first shape, at that shape's price, starting at one crate
 * or at nothing.
 *
 * A thing sold only whole starts at one; a thing sold in parts or weighed starts at nothing, so the
 * seller has to say which — half a crate recorded as a whole one is a real loss.
 */
export function startLine(product: Product, shapes: SaleUnit[]): DraftLine {
  const first = shapes[0];
  return makeDraftLine({
    productId: product.id,
    productName: product.name,
    baseUnit: product.baseUnit,
    packId: product.packId,
    packName: product.packName,
    packQty: product.packQty,
    saleUnitId: first?.id ?? null,
    saleUnitName: first?.name ?? null,
    saleUnitBaseQty: first?.baseQty ?? null,
    unitPrice: first?.price ?? product.listPrice ?? '',
    qty: String(
      startingQty({
        wholeDigit: first?.wholeDigit ?? true,
        allowQuarter: first?.allowQuarter ?? false,
        allowHalf: first?.allowHalf ?? false,
        allowThreeQuarter: first?.allowThreeQuarter ?? false,
      }),
    ),
  });
}
