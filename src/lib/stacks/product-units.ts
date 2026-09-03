'use client';

import { useCallback, useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { getSupabase } from '@/lib/supabase/client';
import { catalogChanged } from '@/lib/stacks/catalog-stack';
import type { Discount } from '@/components/catalog/DiscountsEditor';

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
  /*
   * The two roles a shape had, but only by inference.
   *
   * Every screen guessed differently — the stock page took "the largest sold unit", the deposit
   * screens worked in the pool's base units — so the shop's actual answer ("we count crates, we
   * hold deposits on crates") was nowhere, and each screen was right by accident or not at all.
   */
  isCounted: boolean;
  isDeposit: boolean;
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
  is_counted?: boolean;
  is_deposit?: boolean;
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
  const [units, demandUnits, setUnits] = useDemandState<StoreUnit[]>([], {
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

  /**
   * A unit this shop has just invented, put straight into the list.
   *
   * NOT A REFETCH. The shop made this change on this device, so asking the server what it now
   * looks like is asking a question we already know the answer to — and the round trip is exactly
   * what made a newly added word missing from the picker until somebody reloaded the page. Another
   * device's change is a different matter and comes on the next read.
   */
  const add = useCallback(
    (unit: StoreUnit) => {
      if (units.some((u) => u.id === unit.id)) return;
      setUnits([...units, unit].sort((a, b) => a.name.localeCompare(b.name)));
    },
    [units, setUnits],
  );

  return { units, setUnits, add, reload: load };
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
  isCounted: r.is_counted ?? false,
  isDeposit: r.is_deposit ?? false,
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
      is_counted: u.isCounted,
      is_deposit: u.isDeposit,
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


/**
 * The cheaper prices a product carries for buying more.
 *
 * Stored as price tiers, which the till has honoured since they were built — a line's price drops
 * on its own when the quantity crosses a band. Nothing let a shop set one, so the only tiers that
 * existed got there through SQL.
 *
 * KEYED BY THE STORE UNIT ON SCREEN, resolved to the sale-unit row on the way in and out. The form
 * works in the shop's own units; the tier table points at `product_sale_units`, which is derived
 * and whose ids a form has no business knowing.
 */
export async function fetchDiscounts(productId: string): Promise<Discount[]> {
  const supabase = getSupabase();

  const [{ data: tiers }, { data: saleUnits }] = await Promise.all([
    supabase.rpc('product_price_tiers_for', { p_product_id: productId }),
    supabase.rpc('product_sale_units_for', { p_product_id: productId }),
  ]);

  const nameById = new Map(
    ((saleUnits ?? []) as { id: string; name: string }[]).map((u) => [u.id, u.name]),
  );

  const { data: storeUnits } = await supabase.rpc('product_units_for', {
    p_product_id: productId,
  });
  const idByName = new Map(
    ((storeUnits ?? []) as { store_unit_id: string; name: string }[]).map((u) => [
      u.name,
      u.store_unit_id,
    ]),
  );

  return ((tiers ?? []) as PriceTierRow[])
    .map((t) => {
      const unitName = t.sale_unit_id ? nameById.get(t.sale_unit_id) : undefined;
      const storeUnitId = unitName ? idByName.get(unitName) : undefined;
      return {
        id: t.id,
        storeUnitId: storeUnitId ?? '',
        minQty: String(Number(t.min_qty)),
        maxQty: t.max_qty === null ? '' : String(Number(t.max_qty)),
        price: String(Number(t.price)),
      };
    })
    /*
     * A band whose unit is no longer sold is dropped rather than shown against nothing.
     *
     * It is already unreachable — the till matches on the sale unit — so showing it would be
     * showing a rule that cannot fire, next to ones that can.
     */
    .filter((d) => d.storeUnitId !== '');
}

/**
 * Replace the whole set.
 *
 * As a set, because the bands are only right or wrong together: the database refuses overlapping
 * ones, so removing "5–10" and adding "5 or more" has to happen in that order. Deleting first and
 * inserting after is what makes an edit that swaps two bands possible at all.
 */
export async function saveDiscounts(productId: string, discounts: Discount[]) {
  const supabase = getSupabase();

  const { data: saleUnits } = await supabase.rpc('product_sale_units_for', {
    p_product_id: productId,
  });
  const { data: storeUnits } = await supabase.rpc('product_units_for', {
    p_product_id: productId,
  });

  const nameByStoreUnit = new Map(
    ((storeUnits ?? []) as { store_unit_id: string; name: string }[]).map((u) => [
      u.store_unit_id,
      u.name,
    ]),
  );
  const saleUnitByName = new Map(
    ((saleUnits ?? []) as { id: string; name: string }[]).map((u) => [u.name, u.id]),
  );

  const { error: delErr } = await supabase
    .from('product_price_tiers')
    .delete()
    .eq('product_id', productId);
  if (delErr) throw delErr;

  const rows = discounts
    .map((d) => {
      const saleUnitId = saleUnitByName.get(nameByStoreUnit.get(d.storeUnitId) ?? '');
      if (!saleUnitId) return null;
      return {
        product_id: productId,
        sale_unit_id: saleUnitId,
        min_qty: Number(d.minQty),
        max_qty: d.maxQty.trim() === '' ? null : Number(d.maxQty),
        price: Number(d.price),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length > 0) {
    const { error } = await supabase.from('product_price_tiers').insert(rows);
    if (error) throw error;
  }

  catalogChanged();
}

interface PriceTierRow {
  id: string;
  sale_unit_id: string | null;
  min_qty: string;
  max_qty: string | null;
  price: string;
}
