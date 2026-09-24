'use client';

import { useCallback } from 'react';
import { useDemandState } from '@academix-admin/state-stack';

/**
 * THINGS A SHOPPER WANTS TO FIND AGAIN.
 *
 * On the device, with no account, for the same reason the basket is: somebody comparing prices
 * across three shops should not be asked to register before they can keep track of what they liked.
 *
 * Ids only. A saved product is a POINTER, not a copy — a price kept here would be a price from
 * whenever it was saved, and showing somebody last month's figure as though it were today's is worse
 * than showing nothing.
 */

export const FAVOURITES_SCOPE = 'favourites';

export function useFavourites() {
  const [ids, , setIds] = useDemandState<string[]>([], {
    key: 'saved-products',
    scope: FAVOURITES_SCOPE,
    persist: true,
    deps: [],
    revalidateOnMount: false,
  });

  const list = ids ?? [];

  const isFavourite = useCallback((id: string) => list.includes(id), [list]);

  const toggle = useCallback(
    (id: string) => {
      setIds((prev) => {
        const current = prev ?? [];
        return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      });
    },
    [setIds],
  );

  return { ids: list, isFavourite, toggle };
}
