'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase/client';

/**
 * A shop's own pictures for a product: list, add, reorder, remove.
 *
 * Separate from `storefront.ts`, which reads media through the public RPCs as an anonymous
 * shopper. This is the members' side — it goes through the tables directly and relies on the
 * `product_media_write` policy, which requires `products.manage`. Two modules rather than one
 * because the two callers have genuinely different auth, and merging them would mean a public
 * page importing code that can write.
 */

export interface ProductImage {
  id: string;
  path: string;
  alt: string | null;
  sortOrder: number;
}

interface Row {
  id: string;
  path: string;
  alt: string | null;
  sort_order: number;
}

export function useProductImages(productId: string | null) {
  const [images, setImages] = useState<ProductImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!productId) {
      setImages([]);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: e } = await getSupabase()
      .from('product_media')
      .select('id, path, alt, sort_order')
      .eq('product_id', productId)
      .eq('kind', 'image')
      .order('sort_order', { ascending: true });

    if (e) setError(e.message);
    else {
      setImages(
        (data as Row[] | null)?.map((r) => ({
          id: r.id,
          path: r.path,
          alt: r.alt,
          sortOrder: r.sort_order,
        })) ?? [],
      );
    }
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { images, loading, error, reload, setImages };
}

/**
 * Put one prepared image in the bucket and record it against the product.
 *
 * The path is `<store_id>/products/<product_id>/<random>.webp`. The leading store id is not
 * cosmetic — the storage policy reads it with `split_part(name, '/', 1)` to decide whether the
 * caller may write here at all, so a path that does not start with the store's own id is rejected
 * by the database rather than by this function.
 *
 * The random segment matters too: reusing a stable filename would mean a replaced photo keeps its
 * URL, and every CDN and browser that already cached the old bytes would go on serving them. A
 * fresh name makes a new picture appear immediately, which is what someone who just retook it
 * expects.
 */
export async function addProductImage({
  storeId,
  productId,
  blob,
  alt,
  sortOrder,
}: {
  storeId: string;
  productId: string;
  blob: Blob;
  alt: string;
  sortOrder: number;
}): Promise<ProductImage> {
  const supabase = getSupabase();
  const name = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const path = `${storeId}/products/${productId}/${name}.webp`;

  const { error: upErr } = await supabase.storage.from('media').upload(path, blob, {
    contentType: 'image/webp',
    cacheControl: '31536000',
    upsert: false,
  });
  if (upErr) throw new Error(upErr.message);

  const { data, error } = await supabase
    .from('product_media')
    .insert({ product_id: productId, kind: 'image', path, alt, sort_order: sortOrder })
    .select('id, path, alt, sort_order')
    .single();

  if (error) {
    // The row failed but the file is already in the bucket. Remove it rather than leave an
    // orphan: nothing else will ever reference it, and storage that only grows is a bill nobody
    // can explain later.
    await supabase.storage.from('media').remove([path]);
    throw new Error(error.message);
  }

  const row = data as Row;
  return { id: row.id, path: row.path, alt: row.alt, sortOrder: row.sort_order };
}

/**
 * Take a picture out of the catalogue.
 *
 * Voided, not deleted, and the stored FILE is kept as well. Nothing in this product destroys a
 * record — a photo removed by mistake would otherwise be unrecoverable, and the storage cost of a
 * few product images is not worth that. Actually deleting the object is a separate, deliberate
 * piece of housekeeping.
 */
export async function removeProductImage(image: ProductImage): Promise<void> {
  const { error } = await getSupabase().rpc('void_product_media', { p_id: image.id });
  if (error) throw new Error(error.message);
}

/** Make one picture the product's main image by moving it to the front. */
export async function makePrimaryImage(
  images: ProductImage[],
  id: string,
): Promise<ProductImage[]> {
  const reordered = [
    ...images.filter((i) => i.id === id),
    ...images.filter((i) => i.id !== id),
  ].map((image, index) => ({ ...image, sortOrder: index }));

  const supabase = getSupabase();
  // One statement per row. `upsert` would be fewer round-trips but needs every NOT NULL column
  // restated, and getting that list wrong silently rewrites `product_id`.
  for (const image of reordered) {
    const { error } = await supabase
      .from('product_media')
      .update({ sort_order: image.sortOrder })
      .eq('id', image.id);
    if (error) throw new Error(error.message);
  }
  return reordered;
}
