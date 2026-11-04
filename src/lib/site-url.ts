/**
 * THIS SITE'S OWN ADDRESS, for link previews, robots.txt and the sitemap.
 *
 * The fallback was 'https://store-manager.vercel.app' — somebody else's project, which answers 404 —
 * so the live robots.txt sent search engines there for the sitemap, and every link preview resolved
 * its image against a site that is not this one. Vercel says at build time what this project's
 * production address is; that is used when NEXT_PUBLIC_SITE_URL is not set.
 */
export function siteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return 'https://store-manager-sigma.vercel.app';
}
