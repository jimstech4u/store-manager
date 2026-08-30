'use client';

import { useCallback, useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { getSupabase } from '@/lib/supabase/client';
import { catalogChanged } from '@/lib/stacks/catalog-stack';
import { useInvalidation } from '@/lib/stacks/invalidation';

/**
 * What a product is bought in and sold in.
 *
 * A shop buys cooking oil in bags and in kilogrammes and sells it in litres; it buys beer in
 * crates and sells crates, half crates and single bottles. One "pack size" per product was never
 * going to hold that, and the screens that tried ended up asking the seller to do the conversion
 * in their head at the counter.
 *
 * THE RELATIONSHIP TRAVELS AS THE SHOP SAID IT. `definedAgainst` names another unit and
 * `definedQty` is how many of that one this one is — "one Bag is 24 Litres". The base-unit figure
 * is worked out from that by the database, never typed here, because nobody in a shop can check a
 * base-unit figure but everybody can check whether a bag really holds 24 litres.
 */

export interface StoreUnit {
  id: string;
  name: string;
  plural: string;
}

export interface ProductUnit {
  /** Null until it has been saved once — a unit the shop has just added to this item. */
  id: string | null;
  storeUnitId: string;
  name: string;
  plural: string;
  baseQty: number;
  isBought: boolean;
  isSold: boolean;
  /** What one costs a customer. Null while a unit is only ever bought in. */
  sellPrice: string;
  isReturnable: boolean;
  wholeDigit: boolean;
  allowQuarter: boolean;
  allowHalf: boolean;
  allowThreeQuarter: boolean;
  /** The STORE unit this one was stated in terms of, or null for the one everything else measures against. */
  definedAgainst: string | null;
  definedQty: string;
}

interface StoreUnitRow {
  id: string;
  name: string;
  plural: string;
}

interface ProductUnitRow {
  id: string;
  store_unit_id: string;
  name: string;
  plural: string;
  base_qty: string;
  is_bought: boolean;
  is_sold: boolean;
  sell_price: string | null;
  is_returnable: boolean;
  whole_digit: boolean;
  allow_quarter: boolean;
  allow_half: boolean;
  allow_three_quarter: boolean;
  defined_against_id: string | null;
  defined_qty: string | null;
}

/**
 * The shop's own words for how much of something there is.
 *
 * Per-store, because "Keg", "Bundle" and "Half-bag" are real units in one trade and noise in
 * another. Persisted: a picker should open on the words the shop uses, not on a spinner.
 */
export function useStoreUnits(storeId: string | null) {
  const [units, demandUnits] = useDemandState<StoreUnit[]>([], {
    key: `store-units:${storeId ?? 'none'}`,
    scope: 'catalog_flow',
    persist: true,
    deps: [storeId ?? ''],
    revalidateOnMount: false,
  });

  const load = useCallback(() => {
    if (!storeId) return;
    void demandUnits(async ({ set }) => {
      const { data } = await getSupabase().rpc('store_units_for', { p_store_id: storeId });
      set((data ?? []) as StoreUnitRow[], { override: true });
    });
  }, [storeId, demandUnits]);

  useEffect(load, [load]);
  useInvalidation('catalog_flow', load);

  return { units, reload: load };
}

/** A word this shop had no unit for yet. Returns the id, existing or new. */
export async function createStoreUnit(storeId: string, name: string, plural: string) {
  const { data, error } = await getSupabase().rpc('create_store_unit', {
    p_store_id: storeId,
    p_name: name,
    p_plural: plural,
  });
  if (error) throw error;
  catalogChanged();
  return data as string;
}

const toUnit = (r: ProductUnitRow, byId: Map<string, string>): ProductUnit => ({
  id: r.id,
  storeUnitId: r.store_unit_id,
  name: r.name,
  plural: r.plural,
  baseQty: Number(r.base_qty),
  isBought: r.is_bought,
  isSold: r.is_sold,
  sellPrice: r.sell_price === null ? '' : String(r.sell_price),
  isReturnable: r.is_returnable,
  wholeDigit: r.whole_digit,
  allowQuarter: r.allow_quarter,
  allowHalf: r.allow_half,
  allowThreeQuarter: r.allow_three_quarter,
  /*
   * The stored relationship points at a product_unit row; the form works in STORE units, because
   * half of what it is editing has no row yet. Translated on the way in so there is one language
   * on screen.
   */
  definedAgainst: r.defined_against_id ? (byId.get(r.defined_against_id) ?? null) : null,
  definedQty: r.defined_qty === null ? '' : String(Number(r.defined_qty)),
});

/**
 * One product's units, for the screen that edits them.
 *
 * NOT persisted, unlike almost everything else here, and deliberately: this is the working copy of
 * a form. A cached half-finished edit reappearing days later — under a shop that has since changed
 * the item from another till — is a way to overwrite a good answer with a stale one.
 */
export function useProductUnits(productId: string | null) {
  const [units, demandUnits, setUnits] = useDemandState<ProductUnit[]>([], {
    key: `product-units:${productId ?? 'none'}`,
    scope: 'catalog_flow',
    deps: [productId ?? ''],
    revalidateOnMount: true,
  });

  const [loaded, demandLoaded, setLoaded] = useDemandState<boolean>(false, {
    key: `product-units-loaded:${productId ?? 'none'}`,
    scope: 'catalog_flow',
    deps: [productId ?? ''],
  });

  const load = useCallback(() => {
    if (!productId) return;
    void demandUnits(async ({ set }) => {
      const { data } = await getSupabase().rpc('product_units_for', { p_product_id: productId });
      const rows = (data ?? []) as ProductUnitRow[];
      const byId = new Map(rows.map((r) => [r.id, r.store_unit_id]));
      set(
        rows.map((r) => toUnit(r, byId)),
        { override: true },
      );
    });
    void demandLoaded(async ({ set }) => set(true, { override: true }));
  }, [productId, demandUnits, demandLoaded]);

  useEffect(load, [load]);

  return { units, setUnits, loaded, setLoaded, reload: load };
}

/**
 * Save the whole set.
 *
 * As a set, not row by row, because the answer is only right or wrong as a whole: adding a
 * kilogramme is fine, adding a kilogramme and removing the litre it was measured against is not.
 * The database checks that every unit the shop buys in reaches one it sells in, and refuses the
 * lot if it does not — so the error that comes back is a sentence worth showing.
 */
export async function saveProductUnits(productId: string, units: ProductUnit[]) {
  const { error } = await getSupabase().rpc('save_product_units', {
    p_product_id: productId,
    p_units: units.map((u, i) => ({
      id: u.id,
      store_unit_id: u.storeUnitId,
      is_bought: u.isBought,
      is_sold: u.isSold,
      sell_price: u.isSold && u.sellPrice.trim() !== '' ? Number(u.sellPrice) : null,
      is_returnable: u.isReturnable,
      whole_digit: u.wholeDigit,
      allow_quarter: u.allowQuarter,
      allow_half: u.allowHalf,
      allow_three_quarter: u.allowThreeQuarter,
      defined_against: u.definedAgainst,
      defined_qty: u.definedAgainst ? Number(u.definedQty) : null,
      base_qty: u.definedAgainst ? undefined : u.baseQty,
      sort_order: i,
    })),
  });
  if (error) throw error;
  catalogChanged();
}

/**
 * The units this product buys in that reach nothing it sells in — worked out on the screen.
 *
 * The database is the authority and refuses the save; this is the same question asked while the
 * shop is still typing, so the form can say what is missing BEFORE they press save rather than
 * after. Same rule, deliberately: a unit is answered for when it is sold, or when it was stated in
 * terms of one that is.
 */
export function unitGaps(units: ProductUnit[]): ProductUnit[] {
  const answered = new Set(units.filter((u) => u.isSold).map((u) => u.storeUnitId));

  // Walked until nothing new is added: a bag stated in litres is answered only once the litre is,
  // and the two can be in any order on screen.
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of units) {
      if (answered.has(u.storeUnitId)) continue;
      /*
       * POINTING AT A UNIT IS NOT ANSWERING FOR IT.
       *
       * "One bag is [   ] litres" names the right unit and says nothing. Counted as answered while
       * the box was empty, the warning vanished the moment the shop touched the dropdown — leaving
       * a greyed-out Save and no red panel explaining why. On the database side the two halves are
       * a constraint and can never come apart; here they can, because this is a form mid-typing.
       */
      const said = Number(u.definedQty);
      if (u.definedAgainst && answered.has(u.definedAgainst) && Number.isFinite(said) && said > 0) {
        answered.add(u.storeUnitId);
        grew = true;
      }
    }
  }

  return units.filter((u) => u.isBought && !answered.has(u.storeUnitId));
}
