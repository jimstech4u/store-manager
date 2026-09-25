'use client';

import { useCallback } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import type { PublicTier } from '@/lib/stacks/storefront';
import { unitPriceFor } from './pricing';

/**
 * A BASKET THAT IS ALREADY SORTED BY WHO YOU ARE BUYING FROM.
 *
 * Not the usual one list of everything. This marketplace is many shops, and a shop is a separate
 * business: it prices its own goods, issues its own receipt with its own name on it, and may be open
 * when the one next to it is closed. Two crates from Ashabi and seven things from somewhere else are
 * two orders that happen to have been chosen in one sitting — and one "checkout" button over the top
 * of them would be pretending otherwise.
 *
 * So the basket is grouped by seller from the moment something is added, and each group is checked
 * out on its own. A shopper can take the one that is ready and leave the other.
 *
 * KEPT ON THE DEVICE, and deliberately with no account. Somebody browsing at a bus stop should be
 * able to fill a basket and be asked who they are only when they actually want the goods; asking
 * first loses the basket and the shopper. state-stack persists it, so closing the tab does not.
 */

export const CART_SCOPE = 'cart';
const CART_KEY = 'basket';

export interface CartLine {
  productId: string;
  name: string;
  /** What one costs at the ordinary price, remembered as it was SHOWN. */
  price: string | null;
  unitLabel: string;
  imagePath: string | null;
  qty: number;
  /**
   * The shop's bulk bands for this product, carried with the line.
   *
   * Kept here rather than re-read when the basket opens, for two reasons. A basket must work on a
   * bad connection — it is the one thing a shopper has already invested effort in — and the line's
   * total has to change the moment the stepper crosses a band, not after a round trip. The server
   * prices the order for real when it is sent, bands included, so a stale band here can only ever
   * make the page's arithmetic differ from the shop's, which the basket already warns about.
   */
  tiers?: PublicTier[];
}

export interface CartSeller {
  storeCode: string;
  storeName: string;
  lines: CartLine[];
}

/** Sellers, each with their own lines. The shape is the feature. */
export type Cart = CartSeller[];

const EMPTY: Cart = [];

export function useCart() {
  const [cart, , setCart] = useDemandState<Cart>(EMPTY, {
    key: CART_KEY,
    scope: CART_SCOPE,
    persist: true,
    deps: [],
    // Nothing is fetched: this is the shopper's own basket, and the only source of it is this device.
    revalidateOnMount: false,
  });

  const add = useCallback(
    (
      product: {
        id: string;
        name: string;
        price: string | null;
        unit_label: string;
        image_path: string | null;
        store_code: string;
        store_name: string;
      },
      qty = 1,
      tiers?: PublicTier[],
    ) => {
      setCart((prev) => {
        const next: Cart = (prev ?? []).map((s) => ({ ...s, lines: [...s.lines] }));
        let seller = next.find((s) => s.storeCode === product.store_code);
        if (!seller) {
          seller = { storeCode: product.store_code, storeName: product.store_name, lines: [] };
          next.push(seller);
        }

        const line = seller.lines.find((l) => l.productId === product.id);
        if (line) {
          line.qty += qty;
          // Refreshed to what is being shown now: this page has just read it, the basket may not
          // have looked in days.
          line.price = product.price;
          if (tiers) line.tiers = tiers;
        } else {
          seller.lines.push({
            productId: product.id,
            name: product.name,
            price: product.price,
            unitLabel: product.unit_label,
            imagePath: product.image_path,
            qty,
            tiers,
          });
        }
        return next;
      });
    },
    [setCart],
  );

  const setQty = useCallback(
    (storeCode: string, productId: string, qty: number) => {
      setCart((prev) => {
        const next: Cart = (prev ?? [])
          .map((s) => {
            if (s.storeCode !== storeCode) return s;
            const lines = s.lines
              .map((l) => (l.productId === productId ? { ...l, qty } : l))
              .filter((l) => l.qty > 0);
            return { ...s, lines };
          })
          // A seller with nothing left is not an empty group, it is not in the basket.
          .filter((s) => s.lines.length > 0);
        return next;
      });
    },
    [setCart],
  );

  const removeSeller = useCallback(
    (storeCode: string) => {
      setCart((prev) => (prev ?? []).filter((s) => s.storeCode !== storeCode));
    },
    [setCart],
  );

  const clearSeller = removeSeller;

  const sellers = cart ?? EMPTY;
  const count = sellers.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.qty, 0), 0);

  return { sellers, count, add, setQty, removeSeller, clearSeller };
}

/** What one line comes to, at the band its quantity has earned. */
export function lineTotal(line: CartLine): number {
  const unit = unitPriceFor(line.price, line.tiers, line.qty);
  return unit === null ? 0 : unit * line.qty;
}

/** What one earns each at this quantity — the ordinary price, or the band if one applies. */
export function lineUnitPrice(line: CartLine): number | null {
  return unitPriceFor(line.price, line.tiers, line.qty);
}

/** Whether this line is cheaper per unit than it would be at one. */
export function lineIsDiscounted(line: CartLine): boolean {
  const one = unitPriceFor(line.price, line.tiers, 1);
  const now = unitPriceFor(line.price, line.tiers, line.qty);
  return one !== null && now !== null && now < one;
}

/** What one seller's part of the basket comes to, bulk bands included. */
export function sellerTotal(seller: CartSeller): number {
  return seller.lines.reduce((sum, l) => sum + lineTotal(l), 0);
}

/**
 * Whether anything in this group has no price.
 *
 * A product can be listed without one — some are sold at a price agreed on the day. The basket keeps
 * it and says so rather than inventing a zero, because a total that silently leaves something out is
 * worse than a total that admits it is incomplete.
 */
export function hasUnpriced(seller: CartSeller): boolean {
  return seller.lines.some((l) => !l.price);
}
