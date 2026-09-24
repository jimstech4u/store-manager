/**
 * The address of a product, shared by the server and the browser.
 *
 * It lives apart from `marketplace/server.ts` because that module builds a Supabase client, and a
 * client component importing it for one string would pull that into the browser bundle. A URL is a
 * pure function of a product; it belongs on its own.
 */
export function slugify(input: string): string {
  return String(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 *     /s/7R8U2A/product/gulder-60cl~2d6ab81c-0e67-4bcd-ae22-38160f0f1965
 *
 * Words first, because an id is often a uuid and a search result truncates the tail — identity-first
 * loses exactly the part worth reading. Everything after the first `~` is what the page is looked up
 * by, so renaming a product never breaks a link already out in the world.
 */
export function productHref(product: { id: string; name: string; store_code: string }): string {
  return `/s/${product.store_code}/product/${slugify(product.name)}~${product.id}`;
}

export function productIdFromSlug(slug: string): string | null {
  const decoded = decodeURIComponent(slug);
  const at = decoded.indexOf('~');
  const id = at >= 0 ? decoded.slice(at + 1) : decoded;
  return id.trim() || null;
}
