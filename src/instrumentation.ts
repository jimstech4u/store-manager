import * as Sentry from '@sentry/nextjs';

/**
 * ERRORS ON THE SERVER — a route or a page that throws, the WhatsApp agent included — go to Sentry.
 * Off until `SENTRY_DSN` (or `NEXT_PUBLIC_SENTRY_DSN`) is set. What is sent: `lib/sentry-options.ts`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./sentry.server.config');
  if (process.env.NEXT_RUNTIME === 'edge') await import('./sentry.edge.config');
}

// Errors from Server Components, route handlers and middleware.
export const onRequestError = Sentry.captureRequestError;
