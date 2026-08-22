import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The browser Supabase client.
 *
 * A single shared instance rather than one per import: several clients on one page each open
 * their own auth listener and token-refresh timer, which produces duplicate SIGNED_IN events
 * and, occasionally, two refreshes racing for the same session.
 *
 * The anon key ships to the browser by design. What protects the data is RLS — every table has
 * it enabled with a policy, and every mutating RPC derives the caller from `auth.uid()` rather
 * than trusting a parameter. The service_role key is deliberately absent from this project's
 * environment: it bypasses RLS entirely and has no business near a client bundle.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;

  if (!url || !anonKey) {
    // Loud and specific. A missing env var otherwise surfaces later as an opaque network error
    // against `undefined/rest/v1/...`, which is a genuinely confusing thing to debug.
    throw new Error(
      'Supabase is not configured. NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY ' +
        'must be set in .env.local',
    );
  }

  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // The session lives in localStorage rather than a cookie because every screen in this app
      // is client-rendered and talks to PostgREST directly; there is no server component reading
      // auth, so a cookie would add SSR complexity for no benefit.
      detectSessionInUrl: true,
    },
  });

  return client;
}

/** True when the app has been given its Supabase configuration. */
export function isSupabaseConfigured(): boolean {
  return Boolean(url && anonKey);
}
