import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";
import { withSentryConfig } from "@sentry/nextjs/config";

/*
 * WRITE THE SERVICE WORKER HERE, where it cannot be skipped.
 *
 * It was a `prebuild` script, which npm runs for `npm run build` — and not for `npx next build`,
 * which is what a person types. Every local build since quietly served a STALE public/sw.js: the
 * template had the handler that answers "which build are you", the served worker did not, and the
 * feature that depends on it failed with no error anywhere. Vercel runs `npm run build` so
 * production was right, which is the worst shape for a bug like this — it only lies to whoever is
 * testing.
 *
 * next.config is evaluated by every build and every dev server, however it was started.
 */
execFileSync(process.execPath, ["scripts/build-sw.mjs"], { stdio: "inherit" });

/**
 * Security headers, enforced from the start.
 *
 * connect-src/img-src are intentionally minimal right now — 'self' only. This project has no
 * backend wired up yet (see ACADEMIX_PLAN, store-manager section). Add each origin here the moment
 * something real is integrated (a Supabase project, an API Gateway, an asset host) rather than
 * widening it speculatively — an unused allowance is just attack surface nobody is watching.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

// Report-only until a real pass over the app's actual flows proves the policy — see
// academix-web/next.config.ts for why this is the right default rather than timidity.
const cspHeaderName = process.env.CSP_ENFORCE === 'true'
  ? 'Content-Security-Policy'
  : 'Content-Security-Policy-Report-Only';

const nextConfig: NextConfig = {
  /*
   * NO DEV BADGE. It is a click target on a phone-sized viewport.
   *
   * Next's dev indicator renders into a `nextjs-portal` fixed to the bottom-left corner, which on
   * the 390px viewport every probe runs at sits over the page's own controls. Playwright reports it
   * honestly — "<nextjs-portal> intercepts pointer events" — after retrying for thirty seconds, and
   * the run fails in a way that reads exactly like a broken button.
   *
   * It costs nothing: it is dev-only chrome, `next build` never emits it, and a probe that cannot
   * reach a control it can see is worse than no probe.
   */
  devIndicators: false,
  /*
   * NO TRACING CODE IN THE PHONE'S DOWNLOAD (13 Nov). Sentry's browser tracing is 31 KB compressed of the
   * 69 KB it added to the first load (265 KB before); the shop's phones are on weak data. Errors and logs
   * still come from the phones; timing comes from the server, where the agent's slow steps are. Sentry's
   * own `excludeTracing` would strip the server's too, so this is set for the browser build only.
   */
  webpack(config, { isServer, webpack }) {
    if (!isServer) config.plugins.push(new webpack.DefinePlugin({ __SENTRY_TRACING__: false }));
    return config;
  },
  /*
   * THE SERVER CANVAS AND ITS FONT, kept out of the bundle and shipped with the agent's route: the
   * agent draws the app's own paper on `@napi-rs/canvas` (a native module), in a bundled font.
   */
  serverExternalPackages: ['@napi-rs/canvas'],
  outputFileTracingIncludes: {
    '/api/whatsapp': ['./node_modules/dejavu-fonts-ttf/ttf/DejaVuSansMono-Bold.ttf'],
  },

  eslint: { ignoreDuringBuilds: true },
  output: 'standalone',
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: cspHeaderName, value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

/*
 * SENTRY (13 Nov): errors from the phones and the server, `instrumentation*.ts`. Reports come in through
 * `/monitoring` on this site, so the security policy (connect-src 'self') and ad blockers let them
 * through. Readable stack traces need the build to upload source maps, which needs SENTRY_AUTH_TOKEN;
 * without it the build skips the upload and the reports still arrive, minified.
 */
export default withSentryConfig(nextConfig, {
  org: "store-developer",
  project: "store-manager",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  tunnelRoute: "/monitoring",
  widenClientFileUpload: true,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  telemetry: false,
  // The shop's phones are on weak data: none of the SDK's debug text, and no Session Replay code, is shipped.
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
    excludeReplayShadowDom: true,
    excludeReplayIframe: true,
    excludeReplayWorker: true,
  },
});
