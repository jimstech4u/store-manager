import type { MetadataRoute } from 'next';
import { createClient } from '@supabase/supabase-js';

/**
 * EVERY PUBLIC SHOP, LISTED FOR A CRAWLER.
 *
 * A sitemap matters more here than on most sites, because the marketplace has no crawlable links
 * yet: the grid is fetched in the browser and every card is a button, so following links from the
 * landing page reaches nothing. Until the cards become anchors, this file is the only way a crawler
 * learns that a shop exists at all.
 *
 * Built from `public_stores_near` with no coordinates, which is the same read the marketplace does
 * for somebody who has not shared a location — so a shop appears here exactly when it is genuinely
 * public, and disappears when it is not. Nothing here consults a session, because a crawler has
 * none.
 *
 * Revalidated rather than static: shops open and close, and a sitemap generated at build time would
 * describe the day of the deploy for as long as the deploy lasted.
 */

export const revalidate = 3600;

interface PublicStoreRow {
  code?: string | null;
  store_code?: string | null;
  updated_at?: string | null;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://store-manager.vercel.app';

  const pages: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: 'daily', priority: 1 },
  ];

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return pages;

  try {
    const db = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await db.rpc('public_stores_near', {
      p_lat: null,
      p_lon: null,
      p_query: null,
      p_within_km: null,
      p_limit: 5000,
    });
    if (error) throw error;

    for (const row of (data ?? []) as PublicStoreRow[]) {
      const code = row.code ?? row.store_code;
      if (!code) continue;
      pages.push({
        url: `${base}/s/${code}`,
        changeFrequency: 'daily',
        priority: 0.8,
        ...(row.updated_at ? { lastModified: new Date(row.updated_at) } : {}),
      });
    }
  } catch {
    /*
     * A sitemap that cannot be built is served with the pages we are sure of rather than as a 500.
     * A crawler reading a short sitemap tries again; one reading an error may back off for days.
     */
  }

  return pages;
}
