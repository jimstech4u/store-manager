'use client';

import { useCallback } from 'react';
import { getSupabase } from '@/lib/supabase/client';
import { usePaginatedList } from '@/hooks/usePaginatedList';

/**
 * Products — searchable and paginated.
 *
 * Two shapes, because they are genuinely two questions:
 *
 *  · **Search** (`useProductSearch`) is relevance-ordered and capped. You refine a search rather
 *    than page through it, and relevance cannot be expressed as a keyset cursor. It matches name,
 *    SKU and CATEGORY, so "water" finds Eva 75cl even though the word is nowhere in its name.
 *  · **Browse** (`useProductList`) is name-ordered and paginated with a cursor, for a catalogue
 *    of 300 lines.
 */

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  baseUnit: string;
  categoryId: string | null;
  categoryName: string | null;
  avgUnitCost: string;
  costIsEstimated: boolean;
  onHand: string;
  packId: string | null;
  packName: string | null;
  packQty: string | null;
  listPrice: string | null;
}

interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  base_unit: string;
  category_id: string | null;
  category_name: string | null;
  avg_unit_cost: string;
  cost_is_estimated: boolean;
  on_hand: string;
  pack_id: string | null;
  pack_name: string | null;
  pack_qty: string | null;
  list_price: string | null;
}

function toProduct(r: ProductRow): Product {
  return {
    id: r.id,
    name: r.name,
    sku: r.sku,
    baseUnit: r.base_unit,
    categoryId: r.category_id,
    categoryName: r.category_name,
    avgUnitCost: r.avg_unit_cost,
    costIsEstimated: r.cost_is_estimated,
    onHand: r.on_hand,
    packId: r.pack_id,
    packName: r.pack_name,
    packQty: r.pack_qty,
    listPrice: r.list_price,
  };
}

/** Relevance-ordered search. Pass null to disable (e.g. while the picker is closed). */
export function useProductSearch(storeId: string | null, query: string | null) {
  const fetchPage = useCallback(async () => {
    if (!storeId) return { rows: [] as Product[], cursor: null };
    const { data, error } = await getSupabase().rpc('search_products', {
      p_store_id: storeId,
      p_query: query || null,
      p_limit: 50,
    });
    if (error) throw error;
    return { rows: ((data ?? []) as ProductRow[]).map(toProduct), cursor: null };
  }, [storeId, query]);

  const list = usePaginatedList<Product>({
    fetchPage,
    getId: (p) => p.id,
    // 50 in one page and no cursor: a short page would otherwise be read as "the end", which is
    // correct here — search does not paginate.
    pageSize: 50,
    deps: [storeId, query],
    enabled: Boolean(storeId) && query !== null,
  });

  return {
    products: list.items,
    status: list.loading ? ('loading' as const) : list.error ? ('error' as const) : ('ready' as const),
    error: list.error,
    reload: list.reload,
  };
}

/** Name-ordered browse, cursor-paginated. */
export function useProductList(storeId: string | null) {
  const fetchPage = useCallback(
    async (cursor: unknown | null, limit: number) => {
      if (!storeId) return { rows: [] as Product[], cursor: null };
      const c = cursor as { name: string; id: string } | null;

      const { data, error } = await getSupabase().rpc('list_products', {
        p_store_id: storeId,
        p_after_name: c?.name ?? null,
        p_after_id: c?.id ?? null,
        p_limit: limit,
      });
      if (error) throw error;

      const rows = ((data ?? []) as ProductRow[]).map(toProduct);
      const last = rows[rows.length - 1];
      return { rows, cursor: last ? { name: last.name, id: last.id } : null };
    },
    [storeId],
  );

  const list = usePaginatedList<Product>({
    fetchPage,
    getId: (p) => p.id,
    deps: [storeId],
    enabled: Boolean(storeId),
  });

  return { products: list.items, ...list };
}


/* =====================================================================================
   Sale units — the shapes a product is actually sold in.

   A 12-piece pack is sold as a pack, a half pack, a quarter, and sometimes loose. Each carries
   its own price, which is not the pack price divided down: half a pack is rarely exactly half
   the money, and deriving it would silently overwrite a deliberate pricing decision every time
   the pack price changed.
   ===================================================================================== */

export interface SaleUnit {
  id: string;
  name: string;
  baseQty: string;
  price: string | null;
}

interface SaleUnitRow {
  id: string;
  name: string;
  base_qty: string;
  price: string | null;
}

/** Fetch the configured sale units for a product. Empty means "sell in base units". */
export async function fetchSaleUnits(productId: string): Promise<SaleUnit[]> {
  const { data, error } = await getSupabase().rpc('product_sale_units_for', {
    p_product_id: productId,
  });
  if (error) throw error;
  return ((data ?? []) as SaleUnitRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    baseQty: r.base_qty,
    price: r.price,
  }));
}

export interface ReturnableDue {
  categoryId: string;
  categoryName: string;
  kind: 'content' | 'container';
  qtyUnits: string;
  depositPerUnit: string;
  depositTotal: string;
}

interface ReturnableRow {
  empties_category_id: string;
  category_name: string;
  kind: 'content' | 'container';
  qty_units: string;
  deposit_per_unit: string;
  deposit_total: string;
}

/**
 * What a line owes back, asked BEFORE settling.
 *
 * So the app can tell the seller that this sale needs a customer or a cash deposit while they
 * can still do something about it — rather than surfacing it as a failed save after the money
 * has already changed hands.
 */
export async function fetchReturnablesDue(
  productId: string,
  baseQty: number,
  containers: number,
): Promise<ReturnableDue[]> {
  const { data, error } = await getSupabase().rpc('returnables_for_sale', {
    p_product_id: productId,
    p_base_qty: baseQty,
    p_containers: containers,
  });
  if (error) throw error;
  return ((data ?? []) as ReturnableRow[]).map((r) => ({
    categoryId: r.empties_category_id,
    categoryName: r.category_name,
    kind: r.kind,
    qtyUnits: r.qty_units,
    depositPerUnit: r.deposit_per_unit,
    depositTotal: r.deposit_total,
  }));
}
