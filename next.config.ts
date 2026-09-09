import type { NextConfig } from "next";

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

export default nextConfig;
