import type { PublicTier } from '@/lib/stacks/storefront';

/**
 * WHAT ONE COSTS WHEN YOU BUY THIS MANY.
 *
 * Shops here sell cheaper by the crate-load — American Cola is ₦3,700, or ₦3,600 from six up — and
 * the till has honoured those bands since the beginning. The marketplace did not, which meant the
 * marketplace was quoting a price the receipt would not match. That is worse than having no bulk
 * pricing at all: a shopper who has been told ₦3,700 each and then charged ₦3,600 has been treated
 * well by accident, and one told the cheaper price and charged the dearer has been lied to.
 *
 * THE SAME RULE THE TILL USES (`resolve_price`): the band whose range contains this quantity, and
 * where two could, the one with the highest `min_qty`. Bands are per shape, and the server only
 * hands out the bands for the shape whose price is on the page.
 *
 * This is for SHOWING. Nothing here is trusted when an order is placed — `place_online_order`
 * re-prices every line, bands included, from the shop's own table. A price on a screen is a claim
 * about what a shop will charge, and only the shop's own data can make that claim.
 */
export function unitPriceFor(
  base: string | null,
  tiers: readonly PublicTier[] | null | undefined,
  qty: number,
): number | null {
  if (base === null || base === undefined) return null;
  let price = Number(base);
  if (!tiers?.length) return price;

  let bestMin = -1;
  for (const t of tiers) {
    const min = Number(t.min_qty);
    const max = t.max_qty === null ? Infinity : Number(t.max_qty);
    if (qty >= min && qty <= max && min > bestMin) {
      bestMin = min;
      price = Number(t.price);
    }
  }
  return price;
}

/**
 * The next band up, and how many more it takes to reach it — `null` when they are already on the
 * best one or there is nothing cheaper.
 *
 * Worth saying out loud on the page. "Buy 1 more for ₦3,600 each" is the shop's own offer, and a
 * shopper who would happily take it cannot act on a discount nobody mentioned.
 */
export function nextBand(
  base: string | null,
  tiers: readonly PublicTier[] | null | undefined,
  qty: number,
): { atQty: number; price: number; more: number } | null {
  if (base === null || !tiers?.length) return null;
  const now = unitPriceFor(base, tiers, qty);
  if (now === null) return null;

  let best: { atQty: number; price: number; more: number } | null = null;
  for (const t of tiers) {
    const min = Number(t.min_qty);
    const price = Number(t.price);
    if (min <= qty) continue;          // already past it
    if (price >= now) continue;        // not actually cheaper
    if (!best || min < best.atQty) best = { atQty: min, price, more: min - qty };
  }
  return best;
}
