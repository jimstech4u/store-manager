import type { MetadataRoute } from 'next';

/**
 * WHAT A CRAWLER MAY READ, AND WHAT IT MAY NOT.
 *
 * This site is two things behind one domain, and they want opposite treatment:
 *
 *   THE MARKETPLACE is public and wants to be found — shops, their products, their prices. A person
 *   searching for a crate of Gulder near them should be able to arrive at a shop that has one.
 *
 *   THE SHOP'S OWN OPERATION is not. `/main` is somebody's till, stock and customer accounts; it is
 *   behind a session and there is nothing there for a search engine but a login screen it will index
 *   as though it were the product.
 *
 * Disallowing the private half is not a security measure — that is what auth is for — it is about
 * not spending a crawler's budget on pages it can never read, and not letting a sign-in screen
 * become the thing that ranks for the shop's own name.
 */
export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://store-manager.vercel.app';

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/main',      // the app: till, stock, money, people
          '/setup',     // making a shop
          '/login',
          '/preview',
          '/r/',        // a receipt someone was sent, by token
          '/t/',        // a delivery being tracked, by token
          '/track',
          '/api/',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
