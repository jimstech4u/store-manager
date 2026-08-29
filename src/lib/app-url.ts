/**
 * The address to put in something a customer will open.
 *
 * NOT `window.location.origin`. That is wherever the seller's browser happens to be — which on a
 * shop's own machine during setup is `localhost:3100`, and a link to localhost sent to a customer
 * opens nothing at all. The shop's public address is a fact about the deployment, so it comes from
 * the deployment.
 *
 * `NEXT_PUBLIC_APP_URL` is set per environment: the live domain in production, localhost while
 * developing, so a link shared from a dev machine still points somewhere that works for whoever is
 * testing it. The origin is kept as a fallback rather than throwing — a missing variable should
 * degrade to "the link works for me" rather than break sharing outright.
 */
export function appUrl(path = ''): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '');
  const base =
    configured || (typeof window === 'undefined' ? '' : window.location.origin.replace(/\/+$/, ''));
  if (!path) return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
