import { createClient } from '@supabase/supabase-js';

/**
 * THE PUBLIC MARKETPLACE, READ ON A SERVER.
 *
 * The same RPCs the browser calls, through a client built per call with the anon key and no session.
 * A crawler has no session and neither does this: what it can read is exactly what any passer-by can
 * read, which is the only safe definition of "public" for something that will be indexed.
 *
 * Separate from `lib/stacks/storefront.ts` on purpose — that one holds React hooks and a browser
 * Supabase client, and importing it here would drag both into a server bundle.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function db() {
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export interface ShopForSeo {
  id: string;
  name: string;
  code: string;
  description: string | null;
  categories: { name: string; count: number }[];
}

export interface ProductForSeo {
  id: string;
  name: string;
  price: string | null;
  unit_label: string;
  in_stock: boolean;
  image_path: string | null;
  store_name: string;
  store_code: string;
}

/**
 * Nothing here throws.
 *
 * A read that fails must not take a page down: a crawler that receives a 500 may back off for days,
 * and a person who followed a link should still get a shop even if one query was slow. Every caller
 * handles null by rendering what it can.
 */
export async function getShop(code: string): Promise<ShopForSeo | null> {
  try {
    const client = db();
    if (!client) return null;
    const { data, error } = await client.rpc('public_store', { p_code: code });
    if (error) throw error;
    return (data as ShopForSeo | null) ?? null;
  } catch {
    return null;
  }
}

export async function getShopProducts(storeId: string, limit = 24): Promise<ProductForSeo[]> {
  try {
    const client = db();
    if (!client) return [];
    const { data, error } = await client.rpc('public_products', {
      p_store_id: storeId,
      p_query: null,
      p_category: null,
      p_cursor: null,
      p_limit: limit,
    });
    if (error) throw error;
    return (data ?? []) as ProductForSeo[];
  } catch {
    return [];
  }
}

/** A storage path is stored, never a URL — the host can change, and every row would break at once. */
export function imageUrl(path: string | null | undefined): string | null {
  if (!path || !url) return null;
  return `${url}/storage/v1/object/public/${path.replace(/^\/+/, '')}`;
}
