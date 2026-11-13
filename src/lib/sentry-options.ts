/**
 * WHAT SENTRY MAY SEE (13 Nov) — shared by the browser, server and edge set-ups.
 *
 * The screens and the agent carry customers' names, phone numbers, debts and WhatsApp messages. SDK 11
 * collects request and response bodies, database query data, AI prompts and replies, local variables
 * and the user's IP by default; none of that goes. What does: the error, its stack, the page or route,
 * headers and query names (the till's `?nav=` is ids, not people), the release and the environment.
 */
import type { BrowserOptions } from '@sentry/nextjs';

export const dataCollection: NonNullable<BrowserOptions['dataCollection']> = {
  userInfo: false,
  cookies: false,
  httpBodies: [],
  databaseQueryData: false,
  genAI: { inputs: false, outputs: false },
  stackFrameVariables: false,
};

/** Every trace on a laptop, so a check can see one; a tenth in production, where phones pay for data. */
export const tracesSampleRate = process.env.NODE_ENV === 'development' ? 1.0 : 0.1;

/** Vercel's own name for where it runs (production, preview); anywhere else is a laptop, never "production". */
export const environment = process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.VERCEL_ENV ?? 'local';
