import * as Sentry from '@sentry/nextjs';
import { dataCollection, environment } from '@/lib/sentry-options';

/**
 * ERRORS FROM THE PHONE IN THE SHOP (13 Nov) — reported to Sentry, so a crash or a failed save reaches
 * us without the owner having to send a screenshot. Off until `NEXT_PUBLIC_SENTRY_DSN` is set.
 *
 * Errors and logs only. No tracing (next.config strips its code from this bundle: 31 KB the phones need
 * not download) and no Session Replay, which records what is on screen — customers and money. What is
 * sent is set in `sentry-options.ts`. Reports go through `/monitoring` on our own site (next.config's
 * `tunnelRoute`), which the security policy allows and ad blockers pass.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment,
  dataCollection,
  ignoreErrors: [
    // The browser's own notice, not a fault: a layout settled a frame late.
    'ResizeObserver loop',
  ],
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
