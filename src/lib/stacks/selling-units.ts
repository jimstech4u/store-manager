'use client';

import { useCallback, useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { getSupabase } from '@/lib/supabase/client';
import { useInvalidation } from '@/lib/stacks/invalidation';
import { DERIVED_SCOPE } from '@/lib/stacks/catalog-stack';

/**
 * What a product is worth and how much of it there is — in the unit the shop sells in.
 *
 * "1,596 pieces" is a true statement about something bought and sold in packs, and it is useless:
 * nobody counts pieces, orders pieces or prices pieces. They have three hundred packs. Base units
 * remain the arithmetic — two deliveries cannot be added together without a common unit — but they
 * stop being what anybody reads.
 *
 * A PRODUCT MAY HAVE SEVERAL, AND THEY ARE NOT SEPARATE STOCK. Cooking oil sold in litres and in
 * kilogrammes has ONE pool behind it; each row is that pool divided by the size of its unit. Three
 * hundred litres and twelve and a half kilogrammes are the same oil, said twice — so a screen shows
 * one of them as the figure and the rest as ways of saying it, never as lines to be added up.
 *
 * `isDefault` is the one to lead with.
 */

export interface SellingUnit {
  productId: string;
  productUnitId: string;
  name: string;
  plural: string;
  baseQty: number;
  isDefault: boolean;
  onHand: number;
  /** The DEAREST stock still held, in this unit — the figure a price is warned against. */
  cost: number;
  /** The blended figure margin and reports use, so a screen never disagrees with the books. */
  avgCost: number;
  price: number | null;
  isReturnable: boolean;
  /**
   * The shop's whole position for this product, in base units, undivided.
   *
   * `onHand` is this divided by `baseQty`, which is where "99.6667 crates" comes from. The raw
   * figure is what lets the shape tree decompose it into a sentence somebody can check.
   */
  onHandBase: number;
  isCounted: boolean;
  isDeposit: boolean;
  /**
   * Whether a customer can buy in this shape.
   *
   * The reader hands back every shape the shop has a ROLE for, not only sellable ones — a shop that
   * sells Malta by the pack of 24 still needs the can to say what is on the shelf. A screen that
   * offers something for sale must filter on this.
   */
  isSold: boolean;
  isBought: boolean;
  wholeDigit: boolean;
  allowQuarter: boolean;
  allowHalf: boolean;
  allowThreeQuarter: boolean;
}

interface Row {
  product_id: string;
  product_unit_id: string;
  unit_name: string;
  unit_plural: string;
  base_qty: string;
  is_default: boolean;
  on_hand_units: string;
  cost_per_unit: string;
  avg_cost_per_unit: string;
  price_per_unit: string | null;
  is_returnable: boolean;
  on_hand_base?: string | number;
  is_counted?: boolean;
  is_deposit?: boolean;
  is_sold?: boolean;
  is_bought?: boolean;
  whole_digit: boolean;
  allow_quarter: boolean;
  allow_half: boolean;
  allow_three_quarter: boolean;
}

const toUnit = (r: Row): SellingUnit => ({
  productId: r.product_id,
  productUnitId: r.product_unit_id,
  name: r.unit_name,
  plural: r.unit_plural,
  baseQty: Number(r.base_qty),
  isDefault: r.is_default,
  onHand: Number(r.on_hand_units),
  cost: Number(r.cost_per_unit),
  avgCost: Number(r.avg_cost_per_unit),
  price: r.price_per_unit === null ? null : Number(r.price_per_unit),
  isReturnable: r.is_returnable,
  onHandBase: Number(r.on_hand_base ?? 0),
  isCounted: Boolean(r.is_counted),
  isDeposit: Boolean(r.is_deposit),
  isSold: r.is_sold !== false,
  isBought: Boolean(r.is_bought),
  wholeDigit: r.whole_digit,
  allowQuarter: r.allow_quarter,
  allowHalf: r.allow_half,
  allowThreeQuarter: r.allow_three_quarter,
});

/**
 * Every product's selling units, for a screen that lists the catalogue.
 *
 * Persisted for the same reason every other fetched list here is: a shop opening the stock screen
 * should see it, not a spinner, and the shop's answer replaces what was cached a moment later.
 */
export function useSellingUnits(storeId: string | null) {
  const [units, demandUnits] = useDemandState<SellingUnit[]>([], {
    key: `selling-units:${storeId ?? 'none'}`,
    scope: DERIVED_SCOPE,
    persist: true,
    deps: [storeId ?? ''],
    revalidateOnMount: false,
  });

  const load = useCallback(() => {
    if (!storeId) return;
    void demandUnits(async ({ set }) => {
      const { data } = await getSupabase().rpc('product_selling_units', { p_store_id: storeId });
      set(((data ?? []) as Row[]).map(toUnit), { override: true });
    });
  }, [storeId, demandUnits]);

  useEffect(load, [load]);
  // A page pushed under another never remounts, so a catalogue write while it sits there
  // would otherwise leave it showing figures from before the change.
  useInvalidation(DERIVED_SCOPE, load);

  /** Grouped by product, largest-selling unit first — the order a shop thinks in. */
  const byProduct = new Map<string, SellingUnit[]>();
  for (const u of units) {
    const list = byProduct.get(u.productId);
    if (list) list.push(u);
    else byProduct.set(u.productId, [u]);
  }

  return { units, byProduct, reload: load };
}

/**
 * The same stock said in another unit.
 *
 * Phrased for a screen, because the honest sentence is the whole point: "the same as 12.5 Kgs", not
 * a second figure sitting under the first where it reads as more stock.
 */
export function alsoReadsAs(units: SellingUnit[] | undefined, lead: SellingUnit | null): string {
  if (!units || !lead) return '';
  const others = units.filter((u) => u.productUnitId !== lead.productUnitId);
  if (others.length === 0) return '';

  return `the same as ${others
    .map((u) => {
      // Trimmed rather than rounded: a shop holding 12.5 kg should read 12.5, and 12.4999 is noise
      // from the division, not a fact about the drum.
      const qty = Number(u.onHand.toFixed(2));
      return `${qty} ${qty === 1 ? u.name : u.plural}`;
    })
    .join(', ')}`;
}

/** The unit to lead with for one product, and the rest behind it. */
export function leadUnit(units: SellingUnit[] | undefined): SellingUnit | null {
  if (!units || units.length === 0) return null;
  return units.find((u) => u.isDefault) ?? units[0];
}

/**
 * The shape a price should be read from.
 *
 * `leadUnit` answers "what does the shop count in", which since 0084 can be a shape it never sells
 * — a wholesaler counting cartons it only ever breaks open. Asking that one for a price gets null,
 * and a product that plainly has prices looks as though it has none.
 */
export function pricedUnit(units: SellingUnit[] | undefined): SellingUnit | null {
  if (!units) return null;
  const sold = units.filter((u) => u.isSold);
  if (sold.length === 0) return null;
  return sold.find((u) => u.isDefault) ?? sold.find((u) => u.price != null) ?? sold[0];
}

/**
 * Products bought in a unit that reaches nothing they are sold in.
 *
 * Cooking oil received in kilogrammes, sold only in litres, with nobody having said what a
 * kilogramme is: those kilogrammes can arrive and can never leave. The catalogue refuses to save
 * one now, but a shop may already be carrying some from before the rule, and finding them by
 * opening every product one at a time is not finding them at all.
 */
export function useUnitGaps(storeId: string | null) {
  const [gaps, demandGaps] = useDemandState<UnitGap[]>([], {
    key: `unit-gaps:${storeId ?? 'none'}`,
    scope: DERIVED_SCOPE,
    persist: true,
    deps: [storeId ?? ''],
    revalidateOnMount: false,
  });

  const load = useCallback(() => {
    if (!storeId) return;
    void demandGaps(async ({ set }) => {
      const { data } = await getSupabase().rpc('products_with_unit_gaps', { p_store_id: storeId });
      set(
        ((data ?? []) as { product_id: string; product_name: string; gap_units: string[] }[]).map(
          (r) => ({ productId: r.product_id, productName: r.product_name, units: r.gap_units }),
        ),
        { override: true },
      );
    });
  }, [storeId, demandGaps]);

  useEffect(load, [load]);
  // A page pushed under another never remounts, so a catalogue write while it sits there
  // would otherwise leave it showing figures from before the change.
  useInvalidation(DERIVED_SCOPE, load);

  return { gaps, reload: load };
}

export interface UnitGap {
  productId: string;
  productName: string;
  /** The units nothing can be sold in, by name — what the warning has to say out loud. */
  units: string[];
}

/**
 * The units a shop takes DELIVERY in.
 *
 * The mirror of `useSellingUnits`, and a separate list on purpose: a shop buys cooking oil in bags
 * and sells it by the litre, so "what can arrive" and "what a customer can buy" are two questions
 * with two answers. `baseQty` is what the delivery screen sends back as `base_factor`, so what the
 * shop said a bag holds is exactly what the costing divides by.
 */
export function useBuyingUnits(storeId: string | null) {
  const [units, demandUnits] = useDemandState<BuyingUnit[]>([], {
    key: `buying-units:${storeId ?? 'none'}`,
    scope: DERIVED_SCOPE,
    persist: true,
    deps: [storeId ?? ''],
    revalidateOnMount: false,
  });

  const load = useCallback(() => {
    if (!storeId) return;
    void demandUnits(async ({ set }) => {
      const { data } = await getSupabase().rpc('product_buying_units', { p_store_id: storeId });
      set(
        ((data ?? []) as BuyingUnitRow[]).map((r) => ({
          productId: r.product_id,
          productUnitId: r.product_unit_id,
          name: r.unit_name,
          plural: r.unit_plural,
          baseQty: Number(r.base_qty),
          isDefault: r.is_default,
        })),
        { override: true },
      );
    });
  }, [storeId, demandUnits]);

  useEffect(load, [load]);
  // A page pushed under another never remounts, so a catalogue write while it sits there
  // would otherwise leave it showing figures from before the change.
  useInvalidation(DERIVED_SCOPE, load);

  const byProduct = new Map<string, BuyingUnit[]>();
  for (const u of units) {
    const list = byProduct.get(u.productId);
    if (list) list.push(u);
    else byProduct.set(u.productId, [u]);
  }

  return { units, byProduct, reload: load };
}

export interface BuyingUnit {
  productId: string;
  productUnitId: string;
  name: string;
  plural: string;
  baseQty: number;
  isDefault: boolean;
}

interface BuyingUnitRow {
  product_id: string;
  product_unit_id: string;
  unit_name: string;
  unit_plural: string;
  base_qty: string;
  is_default: boolean;
}


/**
 * What the whole shelf is worth — asked of the shop, not added up from what is on screen.
 *
 * The stock screen summed the rows it happened to be holding and labelled it "Loaded so far,
 * worth". Honest about being partial, and useless as a figure: a shop with eight hundred lines
 * would have to scroll its entire catalogue into memory to learn what its stock is worth.
 *
 * The server is also the only party that CAN answer it — the value of the shelf is quantity times
 * what that quantity cost, and cost lives in FIFO layers a browser never sees.
 */
export function useStockWorth(storeId: string | null) {
  const [worth, demandWorth] = useDemandState<StockWorth>(
    { total: 0, estimated: 0, items: 0, itemsInStock: 0 },
    {
      key: `stock-worth:${storeId ?? 'none'}`,
      scope: DERIVED_SCOPE,
      persist: true,
      deps: [storeId ?? ''],
      revalidateOnMount: false,
    },
  );

  const load = useCallback(() => {
    if (!storeId) return;
    void demandWorth(async ({ set }) => {
      const { data } = await getSupabase().rpc('stock_worth', { p_store_id: storeId });
      const row = (data ?? [])[0] as
        | { total_value: string; estimated_value: string; items: number; items_in_stock: number }
        | undefined;
      if (!row) return;
      set(
        {
          total: Number(row.total_value),
          estimated: Number(row.estimated_value),
          items: Number(row.items),
          itemsInStock: Number(row.items_in_stock),
        },
        { override: true },
      );
    });
  }, [storeId, demandWorth]);

  useEffect(load, [load]);
  // A delivery, a sale or a count all move it, and all invalidate the derived scope.
  useInvalidation(DERIVED_SCOPE, load);

  return worth;
}

export interface StockWorth {
  total: number;
  /** The part still carried at a setup figure rather than one from a real delivery. */
  estimated: number;
  items: number;
  itemsInStock: number;
}

/*
 * The stock sentence lives in `shape-quantities.ts` — pure, importable without React, and testable
 * on its own. Re-exported here so every screen keeps one place to import from.
 */
export { stockInShapes } from '@/lib/shape-quantities';
export type { ShapeQuantity } from '@/lib/shape-quantities';
