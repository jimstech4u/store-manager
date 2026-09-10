'use client';

import { useCallback, useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { useInvalidation, invalidate } from '@/lib/stacks/invalidation';
import { getSupabase } from '@/lib/supabase/client';
import type { OwedRow } from '@/lib/empties-rollup';

/**
 * The two ledgers a customer has that are not money owed: what the shop is HOLDING for them, and
 * what they are holding of the shop's.
 *
 * They are separate here for the same reason they are separate tables (0108). A deposit is a round
 * sum somebody agreed and it comes back or is kept; empties are containers counted in the product's
 * own shape. The old model welded them — a deposit was a quantity of containers at a rate — and the
 * result was that "I am holding twenty thousand naira for Daniel" could not be said at all.
 */

/** Its own scope. A deposit moving must not make the People list re-read itself. */
export const LEDGERS_SCOPE = 'customer_ledgers';

export function ledgersChanged() {
  invalidate(LEDGERS_SCOPE);
}

// ─── Deposits ────────────────────────────────────────────────────────────────────────

export interface DepositCustomer {
  customerId: string;
  name: string;
  phone: string | null;
  /** What the shop is holding right now. Can be zero — a cleared account still belongs on the list. */
  held: number;
  taken: number;
  given: number;
  retained: number;
  lastAt: string | null;
}

export interface DepositMove {
  id: string;
  direction: 'taken' | 'given' | 'retained';
  amount: number;
  reason: string | null;
  occurredAt: string;
  /** What was held after this row — computed by the server so the screen cannot disagree. */
  running: number;
}

/**
 * Everybody the shop has ever held a deposit for, cleared or not.
 *
 * Not only the outstanding ones: a list of those cannot answer "did we give Daniel his money
 * back?", which is the question somebody opens this screen holding.
 */
export function useDepositCustomers(storeId: string | null) {
  const [rows, demand] = useDemandState<DepositCustomer[]>([], {
    key: `deposit-customers:${storeId ?? 'none'}`,
    scope: LEDGERS_SCOPE,
    persist: true,
    deps: [storeId ?? ''],
    revalidateOnMount: false,
  });

  const load = useCallback(() => {
    if (!storeId) return;
    void demand(async ({ set }) => {
      const { data, error } = await getSupabase().rpc('customers_with_deposits', {
        p_store_id: storeId,
      });
      if (error) throw error;
      set(
        ((data ?? []) as Record<string, unknown>[]).map((r) => ({
          customerId: String(r.store_customer_id),
          name: String(r.customer_name ?? ''),
          phone: (r.phone as string | null) ?? null,
          held: Number(r.held) || 0,
          taken: Number(r.taken_total) || 0,
          given: Number(r.given_total) || 0,
          retained: Number(r.retained_total) || 0,
          lastAt: (r.last_at as string | null) ?? null,
        })),
        { override: true },
      );
    });
  }, [storeId, demand]);

  useEffect(load, [load]);
  useInvalidation(LEDGERS_SCOPE, load);
  return { rows, reload: load };
}

export async function depositLedger(customerId: string): Promise<DepositMove[]> {
  const { data, error } = await getSupabase().rpc('customer_deposit_ledger', {
    p_store_customer_id: customerId,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    direction: r.direction as DepositMove['direction'],
    amount: Number(r.amount) || 0,
    reason: (r.reason as string | null) ?? null,
    occurredAt: String(r.occurred_at),
    running: Number(r.running) || 0,
  }));
}

export async function takeDeposit(
  storeId: string,
  customerId: string,
  amount: number,
  reason?: string,
) {
  const { error } = await getSupabase().rpc('take_customer_deposit', {
    p_store_id: storeId,
    p_customer_id: customerId,
    p_amount: amount,
    p_reason: reason?.trim() || null,
  });
  if (error) throw error;
  ledgersChanged();
}

/**
 * Give it back, or keep it — and the difference is not cosmetic.
 *
 * `keep` records income; giving it back records none. Netting the two into one signed figure is how
 * a shop ends up unable to say what it actually earned, which is why `deposit_forfeits` was a table
 * rather than a subtraction long before this.
 */
export async function settleDeposit(args: {
  storeId: string;
  customerId: string;
  amount: number;
  keep: boolean;
  reason: string;
}) {
  const { error } = await getSupabase().rpc('settle_customer_deposit', {
    p_store_id: args.storeId,
    p_customer_id: args.customerId,
    p_amount: args.amount,
    p_keep: args.keep,
    p_reason: args.reason.trim(),
  });
  if (error) throw error;
  ledgersChanged();
}

// ─── Empties ─────────────────────────────────────────────────────────────────────────

export interface EmptiesCustomer {
  customerId: string;
  name: string;
  phone: string | null;
  stillOut: number;
  shapesOut: number;
  lastAt: string | null;
}

export interface EmptiesMove {
  id: string;
  productName: string;
  unitName: string;
  unitPlural: string;
  direction: 'out' | 'returned' | 'damaged';
  qty: number;
  reason: string | null;
  occurredAt: string;
}

export function useEmptiesCustomers(storeId: string | null) {
  const [rows, demand] = useDemandState<EmptiesCustomer[]>([], {
    key: `empties-customers:${storeId ?? 'none'}`,
    scope: LEDGERS_SCOPE,
    persist: true,
    deps: [storeId ?? ''],
    revalidateOnMount: false,
  });

  const load = useCallback(() => {
    if (!storeId) return;
    void demand(async ({ set }) => {
      const { data, error } = await getSupabase().rpc('customers_with_empties', {
        p_store_id: storeId,
      });
      if (error) throw error;
      set(
        ((data ?? []) as Record<string, unknown>[]).map((r) => ({
          customerId: String(r.store_customer_id),
          name: String(r.customer_name ?? ''),
          phone: (r.phone as string | null) ?? null,
          stillOut: Number(r.still_out) || 0,
          shapesOut: Number(r.shapes_out) || 0,
          lastAt: (r.last_at as string | null) ?? null,
        })),
        { override: true },
      );
    });
  }, [storeId, demand]);

  useEffect(load, [load]);
  useInvalidation(LEDGERS_SCOPE, load);
  return { rows, reload: load };
}

/** What one customer owes, shape by shape, with the group so a screen can roll it up. */
export async function emptiesOwed(customerId: string): Promise<OwedRow[]> {
  const { data, error } = await getSupabase().rpc('customer_empties_owed', {
    p_store_customer_id: customerId,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    productId: String(r.product_id),
    productName: String(r.product_name ?? ''),
    productUnitId: String(r.product_unit_id),
    unitName: String(r.unit_name ?? ''),
    unitPlural: String(r.unit_plural ?? ''),
    baseQty: Number(r.base_qty) || 1,
    groupId: (r.group_id as string | null) ?? null,
    groupName: (r.group_name as string | null) ?? null,
    side: (r.side as 'they_hold' | 'we_hold') ?? 'they_hold',
    owed: Number(r.owed) || 0,
  }));
}

export async function emptiesLedger(customerId: string): Promise<EmptiesMove[]> {
  const { data, error } = await getSupabase().rpc('customer_empties_ledger', {
    p_store_customer_id: customerId,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    productName: String(r.product_name ?? ''),
    unitName: String(r.unit_name ?? ''),
    unitPlural: String(r.unit_plural ?? ''),
    direction: r.direction as EmptiesMove['direction'],
    qty: Number(r.qty) || 0,
    reason: (r.reason as string | null) ?? null,
    occurredAt: String(r.occurred_at),
  }));
}

/**
 * Record containers moving.
 *
 * `out` when they take them, `returned` when they come back, `damaged` when both sides agree they
 * are gone. Partial returns are the ordinary case — three crates on Tuesday and two on Friday are
 * two calls — which is the whole reason this is a ledger.
 */
export async function recordEmpties(args: {
  storeId: string;
  customerId: string;
  productUnitId: string;
  direction: 'out' | 'returned' | 'damaged';
  qty: number;
  reason?: string;
  /** Defaults to ours-with-them, which is the common case and what every caller meant before. */
  side?: 'they_hold' | 'we_hold';
}) {
  const { error } = await getSupabase().rpc('record_customer_empties', {
    p_store_id: args.storeId,
    p_customer_id: args.customerId,
    p_product_unit_id: args.productUnitId,
    p_direction: args.direction,
    p_qty: args.qty,
    p_reason: args.reason?.trim() || null,
    p_side: args.side ?? 'they_hold',
  });
  if (error) throw error;
  ledgersChanged();
}

// ─── What the customer form offers to owe against ────────────────────────────────────

export interface ReturnableGroup {
  id: string;
  name: string;
  products: number;
}

export interface ReturnableProduct {
  productId: string;
  productName: string;
  groupName: string | null;
  shapes: number;
}

export interface GroupUnit {
  storeUnitId: string;
  name: string;
  plural: string;
  products: number;
}

/**
 * Makers with something that actually comes back.
 *
 * Not every group. A group of PET bottles nobody returns is not an answer to "what of yours are
 * they holding", and offering it invites an opening balance in a container that has no obligation
 * behind it.
 */
export async function groupsWithReturnables(storeId: string): Promise<ReturnableGroup[]> {
  const { data, error } = await getSupabase().rpc('groups_with_returnables', {
    p_store_id: storeId,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    products: Number(r.products) || 0,
  }));
}

export async function productsWithReturnables(storeId: string): Promise<ReturnableProduct[]> {
  const { data, error } = await getSupabase().rpc('products_with_returnables', {
    p_store_id: storeId,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    productId: String(r.product_id),
    productName: String(r.product_name ?? ''),
    groupName: (r.group_name as string | null) ?? null,
    shapes: Number(r.shapes) || 0,
  }));
}

/** The shapes a maker's containers come back in, so "24 NBL" can say 24 of what. */
export async function groupReturnUnits(categoryId: string): Promise<GroupUnit[]> {
  const { data, error } = await getSupabase().rpc('group_return_units', {
    p_category_id: categoryId,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    storeUnitId: String(r.store_unit_id),
    name: String(r.name ?? ''),
    plural: String(r.plural ?? ''),
    products: Number(r.products) || 0,
  }));
}

/**
 * Containers owed to a MAKER rather than to a product.
 *
 * The shape a book brings across: twenty-four NBL crates, with nobody able to say how many were
 * Goldberg. Recording it against a product would be inventing a fact; this records what is known.
 */
export async function recordGroupEmpties(args: {
  storeId: string;
  customerId: string;
  categoryId: string;
  storeUnitId: string;
  qty: number;
  reason?: string;
}) {
  const { error } = await getSupabase().rpc('record_customer_empties_for_group', {
    p_store_id: args.storeId,
    p_customer_id: args.customerId,
    p_category_id: args.categoryId,
    p_store_unit_id: args.storeUnitId,
    p_direction: 'out',
    p_qty: args.qty,
    p_reason: args.reason?.trim() || null,
  });
  if (error) throw error;
  ledgersChanged();
}
