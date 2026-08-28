/**
 * Creating a staff login, end to end, against the real database.
 *
 * The route, the namespace, the permission checklist and the forced password change — exercised
 * as the app exercises them, then checked in the database rather than in the response body. A
 * route that returns 200 and writes nothing is the failure this is looking for.
 *
 * It also tries the things that MUST NOT work: no token, somebody else's shop, and a caller
 * without `staff.manage`. A privileged route is only as good as its refusals.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const post = (token, body) =>
  fetch(`${BASE}/api/create-staff`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

// ── Sign in as the real owner ────────────────────────────────────────────────────────
const owner = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { data: signedIn, error: signInError } = await owner.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
if (signInError) throw signInError;
const token = signedIn.session.access_token;

const { data: membership } = await owner.rpc('my_membership');
const storeId = membership[0].store_id;
check('signed in as the owner of a real shop', Boolean(storeId), membership[0].store_name);

const created = [];

try {
  // ── The refusals, first ────────────────────────────────────────────────────────────
  const noToken = await post(null, { storeId, firstName: 'Nobody', password: 'Sample@12345' });
  check('a request with no token is refused', noToken.status === 401, `HTTP ${noToken.status}`);

  const otherStore = await post(token, {
    storeId: '00000000-0000-0000-0000-000000000000',
    firstName: 'Nobody',
    password: 'Sample@12345',
  });
  check(
    "a shop the caller does not belong to is refused",
    otherStore.status === 403,
    `HTTP ${otherStore.status}`,
  );

  const shortPassword = await post(token, { storeId, firstName: 'Nobody', password: 'short' });
  check('a too-short password is refused', shortPassword.status === 400, `HTTP ${shortPassword.status}`);

  // ── The real thing ─────────────────────────────────────────────────────────────────
  const stamp = Date.now().toString().slice(-6);
  const permissions = ['sales.record', 'payments.record', 'stock.count'];

  const response = await post(token, {
    storeId,
    firstName: `John${stamp}`,
    lastName: 'Ajibewa',
    phone: '0803 000 0000',
    address: '12 Test Street',
    password: 'Sample@12345',
    roleCode: 'staff',
    permissions,
  });
  const result = await response.json();
  check('the staff account is created', response.ok, `HTTP ${response.status} ${result.error ?? ''}`);
  if (!response.ok) throw new Error(result.error);

  created.push(result.userId);

  // ── The namespace ──────────────────────────────────────────────────────────────────
  const { data: store } = await admin.from('stores').select('login_domain, name').eq('id', storeId).single();
  check(
    'the login is on the shop’s own namespace',
    result.email === `john${stamp}.ajibewa@${store.login_domain}.sm`,
    result.email,
  );
  console.log(`         "${store.name}" -> ${store.login_domain}`);

  // ── What actually landed in the database ───────────────────────────────────────────
  const { data: member } = await admin
    .from('store_members')
    .select('first_name, last_name, phone, address, login_email, must_change_password, role_code')
    .eq('store_id', storeId)
    .eq('user_id', result.userId)
    .single();

  check('their details are stored', member?.first_name === `John${stamp}` && member?.last_name === 'Ajibewa');
  check('their phone and address are stored', member?.phone === '0803 000 0000' && member?.address === '12 Test Street');
  check('the login address is recorded on the member', member?.login_email === result.email);
  check('they must change the password they were given', member?.must_change_password === true);

  // ── The checklist, not the role ────────────────────────────────────────────────────
  /*
   * Asked as the OWNER, not with the service key.
   *
   * `member_permissions` filters on `has_permission(..., 'staff.manage') or p_user_id = auth.uid()`,
   * and the service key has no `auth.uid()` at all — so it returns an empty set, which made the
   * "unticked permission is off" check below pass while proving nothing.
   */
  const { data: effective } = await owner.rpc('member_permissions', {
    p_store_id: storeId,
    p_user_id: result.userId,
  });
  const allowed = (effective ?? []).filter((r) => r.allowed).map((r) => r.code).sort();
  check(
    'exactly the ticked permissions are in force',
    JSON.stringify(allowed) === JSON.stringify([...permissions].sort()),
    allowed.join(', '),
  );

  /*
   * The checklist must BEAT the role, not merely add to it.
   *
   * `staff` normally carries `customers.manage` and `deposits.manage`. They were not ticked, so
   * they must be off — otherwise the checklist is decoration over a role that still decides.
   */
  check(
    'an unticked permission the role would grant is off',
    !allowed.includes('customers.manage') && !allowed.includes('deposits.manage'),
    allowed.join(', '),
  );

  // ── And the account really works ───────────────────────────────────────────────────
  const staff = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data: staffSession, error: staffError } = await staff.auth.signInWithPassword({
    email: result.email,
    password: 'Sample@12345',
  });
  check('the new staff member can sign in', !staffError && Boolean(staffSession?.session), staffError?.message ?? '');

  const { data: staffCan } = await staff.rpc('has_permission', {
    p_store_id: storeId,
    p_permission: 'stock.count',
  });
  const { data: staffCannot } = await staff.rpc('has_permission', {
    p_store_id: storeId,
    p_permission: 'staff.manage',
  });
  check('the database grants what was ticked', staffCan === true);
  check('and refuses what was not', staffCannot === false);

  // ── A second John Ajibewa gets his own address ─────────────────────────────────────
  const twin = await post(token, {
    storeId,
    firstName: `John${stamp}`,
    lastName: 'Ajibewa',
    password: 'Sample@12345',
    roleCode: 'staff',
    permissions: [],
  });
  const twinResult = await twin.json();
  if (twin.ok) created.push(twinResult.userId);
  check(
    'a second person with the same name gets a different login',
    twin.ok && twinResult.email !== result.email,
    twinResult.email ?? twinResult.error,
  );

  // ── Staff cannot add staff ─────────────────────────────────────────────────────────
  const staffToken = staffSession?.session?.access_token;
  if (staffToken) {
    const escalation = await post(staffToken, {
      storeId,
      firstName: 'Escalated',
      password: 'Sample@12345',
    });
    check(
      'a seller cannot create staff',
      escalation.status === 403,
      `HTTP ${escalation.status}`,
    );
  }
} finally {
  for (const id of created) await admin.auth.admin.deleteUser(id);
  if (created.length) console.log(`  (cleaned up ${created.length} test account(s))`);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
