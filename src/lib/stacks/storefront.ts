'use client';

import { useCallback } from 'react';
import { getSupabase } from '@/lib/supabase/client';
import { usePaginatedList } from '@/hooks/usePaginatedList';

/**
 * The public marketplace.
 *
 * Everything here is readable without signing in, and deliberately narrow: shop names, product
 * names, categories, SELLING prices and whether something is in stock. No costs, no margins, no
 * exact stock counts, no customers. A shopfront shows what a shelf edge shows.
 */

export interface PublicStore {
  id: string;
  name: string;
  code: string;
  description: string | null;
  product_count: number;
  address?: string | null;
  distance_km?: string | null;
  cover_path?: string | null;
}

export interface PublicProduct {
  id: string;
  name: string;
  category: string | null;
  store_id: string;
  store_name: string;
  store_code: string;
  unit_label: string;
  price: string | null;
  has_bulk: boolean;
  in_stock: boolean;
  image_path: string | null;
  media_count: number;
}

export interface MediaItem {
  kind: 'image' | 'video';
  path: string;
  alt: string | null;
}

/**
 * Turn a storage path into a URL.
 *
 * Paths are stored, never URLs: the project host can change, and a table full of absolute URLs
 * would all break at once if it did. The bucket is public-read, so this needs no signing and a
 * grid of thumbnails costs no extra round trips.
 */
export function mediaUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  return `${base}/storage/v1/object/public/media/${path}`;
}

export async function fetchProductMedia(productId: string): Promise<MediaItem[]> {
  const { data, error } = await getSupabase().rpc('public_product_media', {
    p_product_id: productId,
  });
  if (error) throw error;
  return (data ?? []) as MediaItem[];
}

export async function fetchStoreMedia(storeId: string): Promise<MediaItem[]> {
  const { data, error } = await getSupabase().rpc('public_store_media', {
    p_store_id: storeId,
  });
  if (error) throw error;
  return (data ?? []) as MediaItem[];
}

export interface PublicCategory {
  name: string;
  product_count: number;
}

/**
 * Public shops, nearest first when a position is known.
 *
 * Deliberately NOT cursor-paginated. Ordering by distance cannot be expressed as a keyset — the
 * sort key is computed per request from the viewer's position — so this returns one capped page
 * and the cursor is always null, which the list hook reads as "that is all there is".
 *
 * That is an honest limit rather than an oversight: a shopper narrows by searching or by moving
 * the radius, not by paging through sixty shops. Products, which genuinely do run to hundreds,
 * keep their cursor.
 */
export function usePublicStores(query: string, coords?: { lat: number; lon: number } | null) {
  const fetchPage = useCallback(
    async (_cursor: unknown | null, limit: number) => {
      const { data, error } = await getSupabase().rpc('public_stores_near', {
        p_lat: coords?.lat ?? null,
        p_lon: coords?.lon ?? null,
        p_query: query.trim() || null,
        p_within_km: null,
        p_limit: limit,
      });
      if (error) throw error;
      return { rows: (data ?? []) as PublicStore[], cursor: null };
    },
    [query, coords?.lat, coords?.lon],
  );

  return usePaginatedList<PublicStore>({
    fetchPage,
    getId: (s) => s.id,
    // Matches the server cap, so a full page is never mistaken for "there is more".
    pageSize: 60,
    deps: [query, coords?.lat, coords?.lon],
  });
}

export function usePublicProducts({
  query,
  storeId,
  category,
}: {
  query: string;
  storeId?: string | null;
  category?: string | null;
}) {
  const fetchPage = useCallback(
    async (cursor: unknown | null, limit: number) => {
      const c = cursor as { name: string; id: string } | null;
      const { data, error } = await getSupabase().rpc('public_products', {
        p_query: query.trim() || null,
        p_store_id: storeId ?? null,
        p_category: category ?? null,
        p_after_name: c?.name ?? null,
        p_after_id: c?.id ?? null,
        p_limit: limit,
      });
      if (error) throw error;
      const rows = (data ?? []) as PublicProduct[];
      const last = rows[rows.length - 1];
      return { rows, cursor: last ? { name: last.name, id: last.id } : null };
    },
    [query, storeId, category],
  );

  return usePaginatedList<PublicProduct>({
    fetchPage,
    getId: (p) => p.id,
    pageSize: 24,
    deps: [query, storeId, category],
  });
}

export async function fetchPublicCategories(storeId?: string | null): Promise<PublicCategory[]> {
  const { data, error } = await getSupabase().rpc('public_categories', {
    p_store_id: storeId ?? null,
  });
  if (error) throw error;
  return (data ?? []) as PublicCategory[];
}

export interface PublicStoreDetail {
  id: string;
  name: string;
  code: string;
  description: string | null;
  categories: { name: string; count: number }[];
}

export async function fetchPublicStore(code: string): Promise<PublicStoreDetail | null> {
  const { data, error } = await getSupabase().rpc('public_store', { p_code: code });
  if (error) throw error;
  return (data as PublicStoreDetail | null) ?? null;
}

export interface PublicTier {
  min_qty: string;
  max_qty: string | null;
  price: string;
}

/** The bulk bands a shopper sees — quantity and price only. */
export async function fetchPublicTiers(productId: string): Promise<PublicTier[]> {
  const { data, error } = await getSupabase().rpc('public_price_tiers', {
    p_product_id: productId,
  });
  if (error) throw error;
  return (data ?? []) as PublicTier[];
}
