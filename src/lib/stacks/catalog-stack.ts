'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { StateStack } from '@academix-admin/state-stack';
import { CATALOG_SCOPE } from '@/lib/stacks/customer-account';
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
  /** Only populated by `fetchProduct` — the list RPCs do not return it. */
  barcode?: string | null;
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
  barcode?: string | null;
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
    barcode: r.barcode ?? null,
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

/**
 * One relevance-ordered search, as a plain call.
 *
 * The hook form below is for a page that owns a search box. This is for the search VIEWER, which
 * owns its own query state and just wants results — and it keeps the row-to-Product mapping in
 * this module rather than leaking `ProductRow` into every screen that searches.
 */
export async function searchProducts(storeId: string, query: string): Promise<Product[]> {
  const { data, error } = await getSupabase().rpc('search_products', {
    p_store_id: storeId,
    p_query: query.trim() || null,
    p_limit: 50,
  });
  if (error) throw error;
  return ((data ?? []) as ProductRow[]).map(toProduct);
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
    /*
     * Search results, in their own scope, UNDER A KEY THAT INCLUDES THE TERM.
     *
     * Kept apart from the browse list because they answer a different question and have a
     * different lifetime: a browse list is worth restoring when someone comes back, a set of
     * results for a term they have since cleared is not.
     *
     * The term used to be left out of the key, so every query shared one entry and whichever
     * response landed last won. Opening the picker searches for '' (everything) and typing
     * searches for 'co'; when the first response arrived second, it overwrote the filtered rows
     * and the picker sat there showing the whole catalogue for a term that excluded most of it.
     * `deps` alone cannot prevent that — it re-runs the fetch, it does not stop an older fetch
     * writing to the same place.
     *
     * One key per question, which is the same rule the rest of the app follows for shapes.
     */
    key: `product-search:${query ?? ''}`,
    scope: 'search_flow',
    // Still not persisted. These are answers to a question somebody has probably stopped asking.
    persist: false,
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
    key: 'products',
    scope: 'catalog_flow',
    deps: [storeId],
    enabled: Boolean(storeId),
  });

  return { products: list.items, ...list };
}

/**
 * One product, for a detail screen.
 *
 * Goes back to the server rather than reusing the row the list already has in memory. The list
 * row is a snapshot from whenever that page loaded, and by the time someone opens a product,
 * takes a photograph and comes back, the stock figure on it may be minutes old and wrong — which
 * on the screen that shows what is on the shelf is the one number that must not be stale.
 */
export async function fetchProduct(productId: string): Promise<Product | null> {
  const { data, error } = await getSupabase().rpc('get_product', { p_product_id: productId });
  if (error) throw error;
  const rows = (data ?? []) as ProductRow[];
  return rows.length > 0 ? toProduct(rows[0]) : null;
}


/* =====================================================================================
   Sale units — the shapes a product is actually sold in.

   A 12-piece pack is sold as a pack, a half pack, a quarter, and sometimes loose. Each carries
   its own price, which is not the pack price divided down: half a pack is rarely exactly half
   the money, and deriving it would silently overwrite a deliberate pricing decision every time
   the pack price changed.
   ===================================================================================== */

/**
 * One product, cached under `product:<id>` — THE reader of that key.
 *
 * Both the product page and the stock-count page want the same product, and both briefly opened
 * their own `useDemandState` on this key with slightly different shapes. A key does not care which
 * of its writers ran last: the count page wrote a value with no `settled`, the product page read
 * `settled` back as undefined, and its "Loading" never cleared. The identical mistake made the
 * bank page throw. One key, one hook, one shape.
 *
 * Cached in the catalogue scope rather than a per-screen one: a product's name, unit and average
 * cost belong to the shop, not to whichever screen happened to ask for them first.
 */
export function useProduct(productId: string | null) {
  const [state, demand] = useDemandState<{
    product: Product | null;
    error: string | null;
    settled: boolean;
  }>(
    { product: null, error: null, settled: false },
    {
      key: `product:${productId ?? 'none'}`,
      scope: CATALOG_SCOPE,
      persist: true,
      deps: [productId ?? ''],
      revalidateOnMount: false,
    },
  );

  const stateRef = useRef(state);
  stateRef.current = state;

  const reload = useCallback(async () => {
    if (!productId) return;
    await demand(async ({ set }) => {
      try {
        set({ product: await fetchProduct(productId), error: null, settled: true }, {
          override: true,
        });
      } catch (e) {
        /*
         * Keep the last good product and say the refresh failed.
         *
         * Never a HALF product though — cost, price and stock on hand only mean anything as a set
         * from one read, so the previous set is kept intact rather than merged with a partial one.
         */
        set(
          {
            ...stateRef.current,
            error: e instanceof Error ? e.message : 'Could not load this product.',
            settled: true,
          },
          { override: true },
        );
      }
    });
  }, [productId, demand]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}

/**
 * Say the catalogue moved.
 *
 * Called after adding, editing or removing a product. Every screen holding a cached product or
 * product list re-reads on its next look, without any of them polling and without the writer
 * needing to know which screens exist — the same shape as `accountsChanged()` for money.
 */
export function catalogChanged() {
  void StateStack.core.clearScope(CATALOG_SCOPE);
}

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
