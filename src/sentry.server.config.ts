import * as Sentry from '@sentry/nextjs';
import { dataCollection, environment, tracesSampleRate } from '@/lib/sentry-options';

/**
 * The server: pages, API routes, and the WhatsApp agent. Its `console.warn` and `console.error` go to
 * Sentry's logs too — they are where the agent says what went wrong ("whatsapp handle failed").
 */
const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment,
  tracesSampleRate,
  dataCollection,
  integrations: [Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] })],
});
