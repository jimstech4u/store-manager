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
  /**
   * The first few items, as "6 × American Cola PET 60cl, 2 × 7Up PET 50cl".
   *
   * Enough to tell one order from another at a glance — two orders for ₦30,000 are otherwise
   * identical rows — and deliberately not enough to answer one on. That happens on the order's own
   * screen, with the quantities, the prices and the stock in front of you.
   */
  preview: string | null;
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
  /** The SALE's state. An accepted order stays `open` until it is settled at the till. */
  status: 'open' | 'settled' | 'cancelled';
  /** What the shop SAID. `null` means it is still waiting on an answer — see the 0166 migration. */
  answer: 'accepted' | 'declined' | null;
  answered_at: string | null;
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

/** What the shop said, or `waiting` if it has not said anything yet. */
export type OrderAnswer = 'waiting' | 'accepted' | 'declined';

export interface OnlineOrderRow {
  id: string;
  code: string;
  customer_name: string | null;
  answer: 'accepted' | 'declined' | null;
  answered_at: string | null;
  status: 'open' | 'settled' | 'cancelled';
  lines: number;
  total: string;
  created_at: string;
  preview: string | null;
}

export interface OrdersFilter {
  answer: OrderAnswer | 'all';
  /** 'today' | 'month' | 'all' — bounded by when the order was PLACED, not when it was answered. */
  when: 'today' | 'month' | 'all';
  query: string;
}

function sinceFor(when: OrdersFilter['when']): string | null {
  if (when === 'all') return null;
  const d = new Date();
  if (when === 'today') d.setHours(0, 0, 0, 0);
  else d.setDate(1), d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * EVERY ORDER, not just the ones still waiting.
 *
 * The queue answered "what needs me now", which is the right first question and the only one it
 * could answer. A shop also needs "did I accept that one?", "what came in today?" and "where is the
 * order for Ade" — and none of those are the queue.
 *
 * Keyed by the filter, so switching tabs does not throw away what the last tab read: coming back to
 * it is instant and the list is already right.
 */
export function useOnlineOrderList(storeId: string | null, filter: OrdersFilter) {
  const since = sinceFor(filter.when);
  const query = filter.query.trim();

  return useResource<OnlineOrderRow[]>({
    key: `online-orders-list:${storeId ?? 'none'}:${filter.answer}:${filter.when}:${query}`,
    scope: ONLINE_ORDERS_SCOPE,
    enabled: Boolean(storeId),
    deps: [storeId ?? '', filter.answer, filter.when, query],
    read: async () => {
      const { data, error } = await getSupabase().rpc('online_orders', {
        p_store_id: storeId,
        p_answer: filter.answer === 'all' ? null : filter.answer,
        p_since: since,
        p_query: query || null,
        p_limit: 60,
      });
      if (error) throw error;
      return (data ?? []) as OnlineOrderRow[];
    },
  });
}

/**
 * ONE PAGE OF ORDERS, WITHOUT A HOOK — for the search viewer, which owns its own results.
 *
 * `useOnlineOrderList` keeps a list for the screen: persisted, scoped, restored. A search surface
 * wants none of that, so the request is lifted out here and both go through it rather than two
 * copies of the same call drifting apart.
 */
export async function fetchOnlineOrders(
  storeId: string,
  opts: { answer?: OrderAnswer | 'all'; when?: OrdersFilter['when']; query?: string; limit?: number } = {},
): Promise<OnlineOrderRow[]> {
  const { data, error } = await getSupabase().rpc('online_orders', {
    p_store_id: storeId,
    p_answer: !opts.answer || opts.answer === 'all' ? null : opts.answer,
    p_since: sinceFor(opts.when ?? 'all'),
    p_query: opts.query?.trim() || null,
    p_limit: opts.limit ?? 40,
  });
  if (error) throw error;
  return (data ?? []) as OnlineOrderRow[];
}

export interface OrderEvent {
  action: 'placed' | 'accepted' | 'declined' | 'reopened';
  actor_name: string;
  reason: string | null;
  at: string;
}

/**
 * WHAT HAS HAPPENED TO THIS ORDER, in order.
 *
 * Append-only on the server. It exists because an answer can be taken back: "accepted, reopened,
 * declined" is a real sequence and a shop that cannot see it cannot review it.
 */
export function useOrderHistory(draftId: string | null) {
  return useResource<OrderEvent[]>({
    key: `online-order-history:${draftId ?? 'none'}`,
    scope: ONLINE_ORDERS_SCOPE,
    enabled: Boolean(draftId),
    deps: [draftId ?? ''],
    read: async () => {
      const { data, error } = await getSupabase().rpc('online_order_history', { p_draft_id: draftId });
      if (error) throw error;
      return (data ?? []) as OrderEvent[];
    },
  });
}

/**
 * Put an answered order back in the queue.
 *
 * Not an undo: the answer that was given still happened and the history keeps it. Needs
 * `sales.amend` and a reason, for the same reason amending a sale does — a correction nobody
 * explained is a correction nobody can review.
 */
export async function reopenOnlineOrder(draftId: string, reason: string): Promise<void> {
  const { error } = await getSupabase().rpc('reopen_online_order', {
    p_draft_id: draftId,
    p_reason: reason,
  });
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
export async function declineOrder(draftId: string, reason?: string): Promise<void> {
  /*
   * `decline_online_order`, not `cancel_draft_order` directly. Cancelling closes the draft, which
   * is right — nothing was sold and no stock moved — but says nothing about who decided that or
   * when. This records the ANSWER and the history entry in the same breath as the cancellation.
   */
  const { error } = await getSupabase().rpc('decline_online_order', {
    p_draft_id: draftId,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  onlineOrdersChanged();
}
