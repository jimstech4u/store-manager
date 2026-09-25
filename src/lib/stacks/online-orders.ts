'use client';

import { invalidate } from '@/lib/stacks/invalidation';
import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';

/**
 * ORDERS A SHOPPER HAS ASKED FOR, WAITING ON THE SHOP.
 *
 * Somebody on the marketplace fills a basket and asks for it. It arrives here as a draft order
 * (0016) marked `online`, and the shop decides: accept, and it becomes a sale through exactly the
 * path a sale made at the counter takes — stock moves, money is taken, a receipt exists. Or decline,
 * and it is cancelled.
 *
 * It is deliberately NOT a sale until accepted. An order somebody typed on their phone at midnight
 * is a request, not a transaction: the shop may be out of it, closed, or unwilling. A ledger that
 * counted requests as sales would be a ledger that lies about what the shop is owed.
 */

export const ONLINE_ORDERS_SCOPE = 'online_orders';

/** An order arrived, or was answered: the list and the badge both re-ask. */
export function onlineOrdersChanged() {
  invalidate(ONLINE_ORDERS_SCOPE);
}

export interface OnlineOrder {
  id: string;
  code: string;
  label: string | null;
  customer_name: string | null;
  lines: number;
  total: string;
  created_at: string;
}

export function useOnlineOrders(storeId: string | null) {
  return useResource<OnlineOrder[]>({
    key: `online-orders:${storeId ?? 'none'}`,
    scope: ONLINE_ORDERS_SCOPE,
    enabled: Boolean(storeId),
    deps: [storeId ?? ''],
    read: async () => {
      const { data, error } = await getSupabase().rpc('pending_online_orders', { p_store_id: storeId });
      if (error) throw error;
      return (data ?? []) as OnlineOrder[];
    },
  });
}

/**
 * Just the number, for the badge on the till.
 *
 * Its own read, and its own key, because the till asks on every visit while the list is opened
 * rarely — counting rows of a list nobody fetched would make the busiest screen in the app pay for
 * a screen almost nobody opens.
 */
export function usePendingOrderCount(storeId: string | null) {
  return useResource<number>({
    key: `online-orders-count:${storeId ?? 'none'}`,
    scope: ONLINE_ORDERS_SCOPE,
    enabled: Boolean(storeId),
    deps: [storeId ?? ''],
    read: async () => {
      const { data, error } = await getSupabase().rpc('pending_online_orders_count', { p_store_id: storeId });
      if (error) throw error;
      return Number(data ?? 0);
    },
  });
}

export interface OnlineOrderLine {
  product_id: string;
  name: string;
  unit: string;
  qty: number;
  unit_price: string;
  line_total: string;
  /** What the shop last RECORDED having. Not a promise — see the note on the page. */
  in_stock: number;
}

export interface OnlineOrderDetail {
  id: string;
  code: string;
  customer_name: string | null;
  customer_phone: string | null;
  note: string | null;
  status: 'open' | 'settled' | 'cancelled';
  created_at: string;
  total: string;
  lines: OnlineOrderLine[];
}

/**
 * ONE ORDER, IN FULL, so the shop can see what it is answering.
 *
 * The queue shows a name and a total, and Accept under it. Nobody should commit stock on the
 * strength of a total: what matters is which products, how many, and whether the shop has them.
 */
export function useOnlineOrder(draftId: string | null) {
  return useResource<OnlineOrderDetail | null>({
    key: `online-order:${draftId ?? 'none'}`,
    scope: ONLINE_ORDERS_SCOPE,
    enabled: Boolean(draftId),
    deps: [draftId ?? ''],
    read: async () => {
      const { data, error } = await getSupabase().rpc('online_order_detail', { p_draft_id: draftId });
      if (error) throw error;
      return ((data ?? []) as OnlineOrderDetail[])[0] ?? null;
    },
  });
}

/**
 * Take it.
 *
 * One call, because accepting is two things that must not come apart: the shop's customer record
 * for this shopper is found or made, and the draft is claimed to the till. Doing the second without
 * the first is what recorded a sale against nobody.
 */
export async function acceptOnlineOrder(draftId: string): Promise<void> {
  const { error } = await getSupabase().rpc('accept_online_order', { p_draft_id: draftId });
  if (error) throw error;
  onlineOrdersChanged();
}

/**
 * Turn it down.
 *
 * `cancel_draft_order` — the same thing that drops an abandoned tab at the counter. Nothing about a
 * declined order should be special: it moved no stock and created no obligation, so there is nothing
 * to unwind.
 */
export async function declineOrder(draftId: string): Promise<void> {
  const { error } = await getSupabase().rpc('cancel_draft_order', { p_draft_id: draftId });
  if (error) throw error;
  onlineOrdersChanged();
}
