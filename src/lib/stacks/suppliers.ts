'use client';

import { useCallback, useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { useInvalidation, invalidate } from '@/lib/stacks/invalidation';
import { getSupabase } from '@/lib/supabase/client';

/**
 * Who a shop buys from.
 *
 * A row rather than the free text `purchases.supplier_name` has carried since 0004, because
 * containers now go BACK to somebody and "who took them" written as text cannot be totalled. A shop
 * asking how many NBL crates it has sent back would be matching strings, and every spelling is a
 * different answer.
 */

/** Its own scope: naming a supplier must not make the stock list re-read itself. */
export const SUPPLIERS_SCOPE = 'suppliers';

export function suppliersChanged() {
  invalidate(SUPPLIERS_SCOPE);
}

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  note: string | null;
  status: string;
  /** How many deliveries have come from them — so the picker can lead with the ones in use. */
  deliveries: number;
  lastAt: string | null;
}

export function useSuppliers(storeId: string | null) {
  const [suppliers, demand, setSuppliers] = useDemandState<Supplier[]>([], {
    key: `suppliers:${storeId ?? 'none'}`,
    scope: SUPPLIERS_SCOPE,
    persist: true,
    deps: [storeId ?? ''],
    revalidateOnMount: false,
  });

  const load = useCallback(() => {
    if (!storeId) return;
    void demand(async ({ set }) => {
      const { data, error } = await getSupabase().rpc('store_suppliers', {
        p_store_id: storeId,
        p_include_archived: false,
      });
      if (error) throw error;
      set(
        ((data ?? []) as Record<string, unknown>[]).map((r) => ({
          id: String(r.id),
          name: String(r.name ?? ''),
          phone: (r.phone as string | null) ?? null,
          note: (r.note as string | null) ?? null,
          status: String(r.status ?? 'active'),
          deliveries: Number(r.deliveries) || 0,
          lastAt: (r.last_at as string | null) ?? null,
        })),
        { override: true },
      );
    });
  }, [storeId, demand]);

  useEffect(load, [load]);
  useInvalidation(SUPPLIERS_SCOPE, load);

  /*
   * THE WRITER KNOWS THE ROW.
   *
   * A supplier named mid-delivery lands here directly rather than through a refetch — the delivery
   * screen never unmounts while the form sits over it, so without this the picker comes back
   * without the supplier somebody just created.
   */
  const add = useCallback(
    (supplier: Supplier) => {
      if (suppliers.some((s) => s.id === supplier.id)) return;
      setSuppliers([...suppliers, supplier].sort((a, b) => a.name.localeCompare(b.name)));
    },
    [suppliers, setSuppliers],
  );

  return { suppliers, add, reload: load };
}

/** Name one, or correct one. Returns the existing id when the name is already taken. */
export async function upsertSupplier(args: {
  storeId: string;
  name: string;
  phone?: string;
  note?: string;
  id?: string;
}): Promise<string> {
  const { data, error } = await getSupabase().rpc('upsert_supplier', {
    p_store_id: args.storeId,
    p_name: args.name.trim(),
    p_phone: args.phone?.trim() || null,
    p_note: args.note?.trim() || null,
    p_id: args.id ?? null,
  });
  if (error) throw error;
  suppliersChanged();
  return data as string;
}

export async function archiveSupplier(id: string, restore = false) {
  const { error } = await getSupabase().rpc('archive_supplier', {
    p_supplier_id: id,
    p_restore: restore,
  });
  if (error) throw error;
  suppliersChanged();
}

export interface SupplierEmptiesRow {
  productId: string;
  productName: string;
  productUnitId: string;
  unitName: string;
  unitPlural: string;
  /** `we_hold` = their crates in our yard. `they_hold` = ours, gone out with a load. */
  side: 'they_hold' | 'we_hold';
  /** Still outstanding on that side. */
  outstanding: number;
  /** How many have already gone back or been written off. */
  moved: number;
  lastAt: string | null;
}

/** What has gone back to one supplier, shape by shape — the ledger free text could not carry. */
export async function supplierEmptiesSent(supplierId: string): Promise<SupplierEmptiesRow[]> {
  const { data, error } = await getSupabase().rpc('supplier_empties_sent', {
    p_supplier_id: supplierId,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    productId: String(r.product_id),
    productName: String(r.product_name ?? ''),
    productUnitId: String(r.product_unit_id),
    unitName: String(r.unit_name ?? ''),
    unitPlural: String(r.unit_plural ?? ''),
    side: (r.side as 'they_hold' | 'we_hold') ?? 'we_hold',
    outstanding: Number(r.outstanding) || 0,
    moved: Number(r.moved) || 0,
    lastAt: (r.last_at as string | null) ?? null,
  }));
}

/**
 * Containers moving between the shop and a supplier.
 *
 * `side` says whose they are — `we_hold` for their crates standing in the yard, `they_hold` for
 * ours gone out with a load. `direction` says what happened to them: `out` opens the obligation,
 * `returned` closes it by the thing arriving, `damaged` by both sides agreeing it is gone.
 *
 * Partial throughout, and every movement its own row, for the reason every ledger here is a ledger:
 * a shop hands back what fits on the lorry and the rest waits for the next one.
 */
export async function recordSupplierEmpties(args: {
  storeId: string;
  supplierId?: string | null;
  supplierName?: string | null;
  productUnitId: string;
  qty: number;
  side?: 'they_hold' | 'we_hold';
  direction?: 'out' | 'returned' | 'damaged';
  purchaseId?: string | null;
  note?: string;
}) {
  const { error } = await getSupabase().rpc('record_supplier_empties', {
    p_store_id: args.storeId,
    p_product_unit_id: args.productUnitId,
    p_qty: args.qty,
    p_purchase_id: args.purchaseId ?? null,
    p_supplier: args.supplierName ?? null,
    p_note: args.note?.trim() || null,
    p_supplier_id: args.supplierId ?? null,
    p_side: args.side ?? 'we_hold',
    p_direction: args.direction ?? 'returned',
  });
  if (error) throw error;
  suppliersChanged();
}
