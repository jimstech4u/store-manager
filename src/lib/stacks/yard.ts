'use client';

import { useCallback, useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { useInvalidation, invalidate } from '@/lib/stacks/invalidation';
import { getSupabase } from '@/lib/supabase/client';

/**
 * The shop's OWN containers — the stack of empty crates standing in the yard.
 *
 * Not what a customer is holding (that is an obligation, and it belongs to that customer) and not
 * what is with a supplier. This is the physical pile, and until 0128 it could not be read: the
 * counts were written against the retired pool and `yard_empties` reached for them through a bridge
 * that no longer had rows, so every shape reported nothing counted and the yard was a bare movement
 * sum. Goldberg crates read minus four and a half thousand.
 *
 * TWO GRAINS, because a yard is stacked in two ways. A shop that keeps Goldberg crates apart from
 * Gulder crates counts by SHAPE. A distributor with one stack of NBL crates counts by GROUP — they
 * are the same physical crate whatever was in them last, and asking for the split is asking for a
 * number nobody can give.
 */

/** Its own scope: counting the yard must not make the product list re-read itself. */
export const YARD_SCOPE = 'yard';

export function yardChanged() {
  invalidate(YARD_SCOPE);
}

/** One shape the shop says comes back — what there is to count. */
export interface CountableShape {
  productUnitId: string;
  productId: string;
  productName: string;
  storeUnitId: string;
  unitName: string;
  unitPlural: string;
  groupId: string | null;
  groupName: string | null;
}

/**
 * A yard position.
 *
 * `counted` and `inYard` are NULLABLE and the null is the point. A shape nobody has counted has no
 * position — the movements alone are the difference between one, not one. Reporting them as a
 * figure is what told a shop it was four thousand crates short.
 */
export interface YardRow {
  productId: string;
  productName: string;
  productUnitId: string;
  unitName: string;
  unitPlural: string;
  counted: number | null;
  countedAt: string | null;
  /** `shape`, `group`, or null when nobody has counted. */
  countedGrain: 'shape' | 'group' | null;
  groupId: string | null;
  groupName: string | null;
  inFromCustomers: number;
  outToCustomers: number;
  inFromSuppliers: number;
  outToSuppliers: number;
  inYard: number | null;
}

export interface YardGroupRow {
  groupId: string;
  groupName: string;
  storeUnitId: string;
  unitName: string;
  unitPlural: string;
  counted: number | null;
  countedAt: string | null;
  countedGrain: 'shape' | 'group' | null;
  shapes: number;
  inFromCustomers: number;
  outToCustomers: number;
  inFromSuppliers: number;
  outToSuppliers: number;
  inYard: number | null;
}

const num = (v: unknown) => Number(v) || 0;
const nullableNum = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toYardRow(r: Record<string, unknown>): YardRow {
  return {
    productId: String(r.product_id),
    productName: String(r.product_name ?? ''),
    productUnitId: String(r.product_unit_id),
    unitName: String(r.unit_name ?? ''),
    unitPlural: String(r.unit_plural ?? ''),
    counted: nullableNum(r.counted),
    countedAt: (r.counted_at as string | null) ?? null,
    countedGrain: (r.counted_grain as 'shape' | 'group' | null) ?? null,
    groupId: (r.group_id as string | null) ?? null,
    groupName: (r.group_name as string | null) ?? null,
    inFromCustomers: num(r.in_from_customers),
    outToCustomers: num(r.out_to_customers),
    inFromSuppliers: num(r.in_from_suppliers),
    outToSuppliers: num(r.out_to_suppliers),
    inYard: nullableNum(r.in_yard),
  };
}

function toGroupRow(r: Record<string, unknown>): YardGroupRow {
  return {
    groupId: String(r.group_id),
    groupName: String(r.group_name ?? ''),
    storeUnitId: String(r.store_unit_id),
    unitName: String(r.unit_name ?? ''),
    unitPlural: String(r.unit_plural ?? ''),
    counted: nullableNum(r.counted),
    countedAt: (r.counted_at as string | null) ?? null,
    countedGrain: (r.counted_grain as 'shape' | 'group' | null) ?? null,
    shapes: num(r.shapes),
    inFromCustomers: num(r.in_from_customers),
    outToCustomers: num(r.out_to_customers),
    inFromSuppliers: num(r.in_from_suppliers),
    outToSuppliers: num(r.out_to_suppliers),
    inYard: nullableNum(r.in_yard),
  };
}

/** The yard at both grains, in one hook — the page shows whichever the shop counts in. */
export function useYard(storeId: string | null) {
  const [yard, demand, setYard] = useDemandState<{ shapes: YardRow[]; groups: YardGroupRow[] }>(
    { shapes: [], groups: [] },
    {
      key: `yard:${storeId ?? 'none'}`,
      scope: YARD_SCOPE,
      persist: true,
      deps: [storeId ?? ''],
      revalidateOnMount: false,
    },
  );

  const load = useCallback(() => {
    if (!storeId) return;
    void demand(async ({ set }) => {
      const supabase = getSupabase();
      const [{ data: s, error: se }, { data: g, error: ge }] = await Promise.all([
        supabase.rpc('yard_empties', { p_store_id: storeId }),
        supabase.rpc('yard_empties_by_group', { p_store_id: storeId }),
      ]);
      if (se) throw se;
      if (ge) throw ge;
      set({
        shapes: ((s ?? []) as Record<string, unknown>[]).map(toYardRow),
        groups: ((g ?? []) as Record<string, unknown>[]).map(toGroupRow),
      });
    });
  }, [storeId, demand]);

  useEffect(() => {
    load();
  }, [load]);

  useInvalidation(storeId ? YARD_SCOPE : null, load);

  return { shapes: yard.shapes, groups: yard.groups, reload: load, setYard };
}

/** Everything the shop says comes back, for the count screen to offer. */
export async function countableEmpties(storeId: string): Promise<CountableShape[]> {
  const { data, error } = await getSupabase().rpc('countable_empties', { p_store_id: storeId });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    productUnitId: String(r.product_unit_id),
    productId: String(r.product_id),
    productName: String(r.product_name ?? ''),
    storeUnitId: String(r.store_unit_id),
    unitName: String(r.unit_name ?? ''),
    unitPlural: String(r.unit_plural ?? ''),
    groupId: (r.group_id as string | null) ?? null,
    groupName: (r.group_name as string | null) ?? null,
  }));
}

/**
 * One part of a count: a shape, or a group and the unit it is counted in.
 *
 * Never both, and the server refuses both — one grain per row is what lets a group total stay
 * honest about not knowing its own split.
 */
export type CountPart =
  | { productUnitId: string; qty: number }
  | { categoryId: string; storeUnitId: string; qty: number };

/**
 * A whole walk of the yard, in ONE call.
 *
 * A yard is counted in one pass. A per-shape round trip would stamp a different `counted_at` on
 * each stack, so a movement landing halfway through the walk would be counted against some shapes
 * and not others.
 */
export async function countYard(args: {
  storeId: string;
  parts: CountPart[];
  note?: string;
}): Promise<number> {
  const { data, error } = await getSupabase().rpc('count_empties', {
    p_store_id: args.storeId,
    p_parts: args.parts.map((p) =>
      'productUnitId' in p
        ? { product_unit_id: p.productUnitId, qty: p.qty }
        : { category_id: p.categoryId, store_unit_id: p.storeUnitId, qty: p.qty },
    ),
    p_note: args.note ?? null,
  });
  if (error) throw error;
  yardChanged();
  return Number(data) || 0;
}
