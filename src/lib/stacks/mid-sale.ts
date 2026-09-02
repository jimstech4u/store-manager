'use client';

import { getSupabase } from '@/lib/supabase/client';
import { catalogChanged } from '@/lib/stacks/catalog-stack';

/**
 * The two things a counter meets that used to stop a sale.
 *
 * Waiting costs money at a till, and it is exactly where the system asks the most: this item has
 * never been entered, this stock has not been counted today. Asked as blocking questions, both end
 * the same way — the seller writes the sale on paper and the ledger is wrong for the rest of the
 * day.
 *
 * So the sale goes through, what was actually done is recorded, and the asking happens afterwards.
 */

/**
 * Add something sellable without leaving the receipt: a name, a unit, a price.
 *
 * Deliberately the minimum. A seller mid-receipt has a customer waiting and should be asked three
 * things, not eleven; the rest is filled in later on the item's own screen by somebody who is not
 * standing at a counter.
 *
 * PROVISIONAL UNLESS THE SELLER MAY VOUCH. Added by a manager it is confirmed at once; added by a
 * seller it lands in the review queue, visibly unconfirmed, while the sale goes through.
 */
export async function quickAddSellable(
  storeId: string,
  name: string,
  unitName: string,
  unitPlural: string,
  price: string,
): Promise<string> {
  const { data, error } = await getSupabase().rpc('quick_add_sellable', {
    p_store_id: storeId,
    p_name: name.trim(),
    p_unit_name: unitName.trim(),
    p_unit_plural: unitPlural.trim() || unitName.trim(),
    p_price: price.trim() === '' ? null : Number(price),
  });
  if (error) throw error;

  // A new sellable thing changes what every catalogue screen can offer.
  catalogChanged();
  return data as string;
}

/**
 * Which of these have not been counted today.
 *
 * Asked for the whole receipt in one request: a seller adds several items to one order and a round
 * trip per line is a round trip per line.
 */
export async function whichNeedCount(productIds: string[]): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();

  const { data, error } = await getSupabase().rpc('which_need_count', {
    p_product_ids: productIds,
  });
  if (error) throw error;

  return new Set(((data ?? []) as { product_id: string }[]).map((r) => r.product_id));
}

/**
 * Say what is on the shelf, from the till, and open the item's day.
 *
 * In BASE units — the caller converts from whatever the shop sells in, exactly as the counting
 * screen does.
 */
export async function countFromTill(productId: string, countedBase: number): Promise<void> {
  const { error } = await getSupabase().rpc('count_from_till', {
    p_product_id: productId,
    p_counted: countedBase,
  });
  if (error) throw error;
}
