import * as Sentry from '@sentry/nextjs';
import { dataCollection, environment, tracesSampleRate } from '@/lib/sentry-options';

/** The edge runtime, for anything that runs there. Same rules as the server. */
const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment,
  tracesSampleRate,
  dataCollection,
});
