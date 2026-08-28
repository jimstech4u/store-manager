import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

/**
 * Create a staff login that the shop controls.
 *
 * WHY THIS EXISTS AT ALL. Everything else in this product goes straight from the browser to
 * Postgres, because RLS and `auth.uid()` make that safe. Creating an auth user is the one thing
 * that cannot: it needs the service_role key, which bypasses RLS entirely and must never be within
 * reach of a browser. So this is the only privileged code in the app, and it is deliberately as
 * small as it can be.
 *
 * THE CALLER IS CHECKED BEFORE ANYTHING PRIVILEGED HAPPENS. The request carries the admin's own
 * access token; that token is used to ask the database — as them — whether they may manage staff
 * here. `p_store_id` from the body is not trusted on its own, because a body is written by whoever
 * is calling. The service_role client is only reached for after the database has already said yes.
 *
 * THE ADDRESS IS NOT DELIVERABLE, and that is the point. `john.doe@ashabiglobal.sm` exists so a
 * seller can be given a till without needing a personal email account. Nothing is ever sent to it:
 * the account is created already confirmed, a forgotten password is reset by the admin, and
 * anything that genuinely has to arrive by email goes to the admin's own address.
 */

export const runtime = 'nodejs';

interface Body {
  storeId?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  address?: string;
  password?: string;
  roleCode?: string;
  permissions?: string[];
}

const bad = (message: string, status = 400) => NextResponse.json({ error: message }, { status });

/** `John` + `Ajibewa` -> `john.ajibewa`. Letters and digits only; a dot between the two. */
function localPart(first: string, last: string) {
  const clean = (v: string) =>
    v
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  return [clean(first), clean(last)].filter(Boolean).join('.') || 'staff';
}

export async function POST(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  /*
   * Fail loudly when the key is missing.
   *
   * A half-configured deployment that silently cannot add staff is worse than one that says so:
   * the shop finds out when they try to give somebody a till, which is the worst moment.
   */
  if (!url || !anonKey) return bad('Supabase is not configured on the server.', 500);
  if (!serviceKey) {
    return bad(
      'Staff accounts cannot be created: SUPABASE_SERVICE_ROLE_KEY is not set on the server.',
      500,
    );
  }

  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return bad('You are not signed in.', 401);

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return bad('That request could not be read.');
  }

  const storeId = body.storeId?.trim();
  const firstName = body.firstName?.trim() ?? '';
  const lastName = body.lastName?.trim() ?? '';
  const password = body.password ?? '';
  const roleCode = body.roleCode?.trim() || 'staff';

  if (!storeId) return bad('Which shop is this for?');
  if (!firstName) return bad('Give them a first name.');
  if (password.length < 8) return bad('The password needs at least 8 characters.');

  // ── The caller, as themselves ───────────────────────────────────────────────────────
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: caller, error: whoError } = await asCaller.auth.getUser();
  if (whoError || !caller?.user) return bad('Your session has expired. Sign in again.', 401);

  /*
   * Ask the DATABASE whether they may do this.
   *
   * Not a role check in this file: `has_permission` already accounts for a member's own permission
   * overrides, and re-implementing that here would be a second answer to a question that has one.
   */
  const { data: allowed, error: permError } = await asCaller.rpc('has_permission', {
    p_store_id: storeId,
    p_permission: 'staff.manage',
  });
  if (permError) return bad('Could not check your permissions.', 500);
  if (allowed !== true) return bad('You do not have permission to add staff here.', 403);

  // The namespace, assigned on first use. Checks `staff.manage` again inside the database, which is
  // where that check belongs.
  const { data: domain, error: domainError } = await asCaller.rpc('ensure_login_domain', {
    p_store_id: storeId,
  });
  if (domainError || !domain) return bad('Could not work out this shop’s login namespace.', 500);

  // ── Privileged, and only from here ──────────────────────────────────────────────────
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const base = localPart(firstName, lastName);
  let email = `${base}@${domain}.sm`;

  /*
   * Two people called John Ajibewa.
   *
   * Rare in one shop and certain across enough of them, and the failure is ugly: the second person
   * silently takes over the first person's login. Suffixing is the same thing the namespace itself
   * does when two businesses share a name.
   */
  for (let attempt = 2; attempt <= 20; attempt += 1) {
    const { data: existing } = await admin.rpc('email_in_use', { p_email: email });
    if (existing !== true) break;
    email = `${base}${attempt}@${domain}.sm`;
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    // Confirmed on creation. There is no inbox to confirm from, and the admin standing in front of
    // this form IS the confirmation.
    email_confirm: true,
    user_metadata: { first_name: firstName, last_name: lastName, staff_of: storeId },
  });

  if (createError || !created?.user) {
    return bad(createError?.message ?? 'That account could not be created.', 500);
  }

  const userId = created.user.id;

  const { error: memberError } = await admin.from('store_members').insert({
    store_id: storeId,
    user_id: userId,
    role_code: roleCode,
    invited_by: caller.user.id,
    first_name: firstName,
    last_name: lastName || null,
    phone: body.phone?.trim() || null,
    address: body.address?.trim() || null,
    login_email: email,
    // They must choose their own before doing anything else: a password the admin knows is a
    // password two people know.
    must_change_password: true,
  });

  if (memberError) {
    /*
     * Undo the auth user.
     *
     * Otherwise the address is taken by an account that belongs to no shop — invisible in the app,
     * and in the way the next time somebody with that name is added.
     */
    await admin.auth.admin.deleteUser(userId);
    return bad(memberError.message, 500);
  }

  /*
   * Permissions, applied AS THE ADMIN.
   *
   * `set_member_permissions` derives the actor from `auth.uid()` and enforces that nobody edits
   * their equal or their senior. Called with the service_role key there is no `auth.uid()` at all,
   * so it would either fail or — worse — skip the rank check. The caller's own token is the right
   * credential for a permission decision the caller is making.
   */
  if (body.permissions) {
    const { error: permsError } = await asCaller.rpc('set_member_permissions', {
      p_store_id: storeId,
      p_user_id: userId,
      p_allowed: body.permissions,
    });
    if (permsError) {
      // The account exists and works; only the checklist did not apply. Say so precisely rather
      // than rolling back a person the admin has just created.
      return NextResponse.json(
        { email, userId, warning: `Added, but their permissions did not save: ${permsError.message}` },
        { status: 207 },
      );
    }
  }

  return NextResponse.json({ email, userId });
}
