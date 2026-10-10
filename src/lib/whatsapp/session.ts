import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * THE BOT ACTS AS THE PERSON, NEVER AS ITSELF. Server only.
 *
 * The service key bypasses every rule in the database, so it is used for exactly two things here:
 * the bot's own tables (links, sessions, the message log) and opening a session for a LINKED member.
 * Everything the member asks for is then done with THAT session — their `auth.uid()`, their role,
 * their own permissions — so the bot can never see or do more than they could in the app.
 *
 * The session is opened the way Supabase opens any magic-link sign-in (an admin-made link, verified
 * here, nothing emailed), kept in `whatsapp_sessions`, and refreshed as it ages. Unlinking deletes it.
 */
const URL = () => process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export function serviceDb(): SupabaseClient {
  return createClient(URL(), process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

function asUser(accessToken: string): SupabaseClient {
  return createClient(URL(), ANON(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function keep(db: SupabaseClient, userId: string, s: { access_token: string; refresh_token: string; expires_at?: number }) {
  await db.from('whatsapp_sessions').upsert({
    user_id: userId,
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: new Date((s.expires_at ?? Math.floor(Date.now() / 1000) + 3000) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });
}

async function open(db: SupabaseClient, userId: string): Promise<string> {
  const { data: who, error: whoErr } = await db.auth.admin.getUserById(userId);
  if (whoErr || !who.user?.email) throw new Error('That member could not be found.');
  const { data: link, error: linkErr } = await db.auth.admin.generateLink({ type: 'magiclink', email: who.user.email });
  if (linkErr || !link.properties?.hashed_token) throw new Error('Could not open a session for this member.');
  const anon = createClient(URL(), ANON(), { auth: { persistSession: false } });
  const { data, error } = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token });
  if (error || !data.session) throw new Error('Could not open a session for this member.');
  await keep(db, userId, data.session);
  return data.session.access_token;
}

/** A database client that IS this member. */
export async function clientFor(userId: string): Promise<SupabaseClient> {
  const db = serviceDb();
  const { data: row } = await db.from('whatsapp_sessions').select('*').eq('user_id', userId).maybeSingle();
  if (row && new Date(row.expires_at).getTime() - Date.now() > 120_000) return asUser(row.access_token);

  if (row) {
    const anon = createClient(URL(), ANON(), { auth: { persistSession: false } });
    const { data, error } = await anon.auth.refreshSession({ refresh_token: row.refresh_token });
    if (!error && data.session) {
      await keep(db, userId, data.session);
      return asUser(data.session.access_token);
    }
  }
  return asUser(await open(db, userId));
}
