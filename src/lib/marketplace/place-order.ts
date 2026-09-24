'use client';

import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';
import type { CartSeller } from './cart';

/**
 * ASKING ONE SHOP FOR ONE PART OF THE BASKET.
 *
 * One call per seller, because the basket is grouped by seller and each group is a separate order
 * to a separate business. There is deliberately no "check out everything": that is one action that
 * can half-succeed, leaving a shopper who cannot tell which shops heard them.
 *
 * WHAT IS SENT IS NOT WHAT IS CHARGED. The lines carry the price the basket was SHOWN, and the
 * server ignores it for pricing — every line is re-priced from the shop's own current price. The
 * shown price is sent anyway, for one purpose: the server counts how many disagree and says so, and
 * the shopper is told a price moved rather than finding out from a receipt.
 */

export interface PlacedOrder {
  /** What the shopper reads out to the shop, and what the shop finds it by. */
  code: string;
  total: string;
  /** How many lines the shop now prices differently from what the basket showed. */
  repriced: number;
}

export async function placeOnlineOrder(seller: CartSeller, note?: string): Promise<PlacedOrder> {
  const { data, error } = await getSupabase().rpc('place_online_order', {
    p_store_code: seller.storeCode,
    p_lines: seller.lines.map((l) => ({
      product_id: l.productId,
      qty: l.qty,
      shown_price: l.price,
    })),
    p_note: note ?? null,
  });
  if (error) throw error;

  const row = ((data ?? []) as PlacedOrder[])[0];
  if (!row) throw new Error('The shop did not answer. Nothing was sent — try again.');
  return row;
}

export const MY_ORDERS_SCOPE = 'my_online_orders';

export interface MyOnlineOrder {
  id: string;
  code: string;
  store_name: string;
  store_code: string;
  status: 'open' | 'settled' | 'cancelled';
  lines: number;
  total: string;
  created_at: string;
}

/**
 * What this shopper has asked for, and what came of it.
 *
 * Only their own, and only the request — never the shop's ledger. A shopper's business with an
 * order is what they asked for and whether it was taken.
 */
export function useMyOnlineOrders(signedIn: boolean) {
  return useResource<MyOnlineOrder[]>({
    key: 'my-online-orders',
    scope: MY_ORDERS_SCOPE,
    enabled: signedIn,
    deps: [signedIn],
    read: async () => {
      const { data, error } = await getSupabase().rpc('my_online_orders');
      if (error) throw error;
      return (data ?? []) as MyOnlineOrder[];
    },
  });
}
