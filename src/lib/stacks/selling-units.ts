'use client';

import { useCallback, useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { getSupabase } from '@/lib/supabase/client';

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
    scope: 'catalog_flow',
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
    scope: 'catalog_flow',
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

  return { gaps, reload: load };
}

export interface UnitGap {
  productId: string;
  productName: string;
  /** The units nothing can be sold in, by name — what the warning has to say out loud. */
  units: string[];
}
