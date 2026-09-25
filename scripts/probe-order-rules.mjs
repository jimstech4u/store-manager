/**
 * TWO RULES THE INTERFACE CANNOT BE TRUSTED WITH.
 *
 * Both are enforced in `place_online_order`, and both are checked here by calling it DIRECTLY —
 * not through the pages. A hidden button is not a rule: anyone can open a console, and the whole
 * point of putting these in the database is that the answer does not depend on which screen asked.
 *
 *   A SHOP CANNOT ORDER FROM ITSELF. An owner browsing the marketplace could send their own shop
 *   an order, which would arrive in their own queue and, on being accepted, open a till against a
 *   customer record for themselves. An online order exists so the person who placed it can sign in
 *   and follow it; a shop following its own order is nobody following anything.
 *
 *   THE BULK BAND IS APPLIED. A shop selling American Cola at ₦3,700, or ₦3,600 from six up, was
 *   being asked for six at ₦3,700 — the marketplace quoting a price the receipt would not match.
 *   Checked against the shop's own `product_price_tiers`, so the test knows the real band rather
 *   than a number written into it.
 *
 *     node scripts/probe-order-rules.mjs
 */

import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);

const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const note = (what, detail = '') => console.log(`  ····  ${what}${detail ? ` — ${detail}` : ''}`);

const admin = (path, body, method = 'POST') =>
  fetch(`${URL_BASE}/${path}`, {
    method,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

/** An RPC as a particular signed-in person — which is the whole point of these checks. */
const rpcAs = async (token, fn, args) => {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const signIn = async (email, password) => {
  const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => null);
  return body?.access_token ?? null;
};

const sql = async (query) => {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${URL_BASE.split('//')[1].split('.')[0]}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'curl/8.4.0',
      },
      body: JSON.stringify({ query }),
    },
  );
  return res.json();
};

const STAMP = Date.now().toString().slice(-8);
const EMAIL = `probe.rules.${STAMP}@example.com`;
const PASSWORD = `Probe-${STAMP}!`;
let shopperId = null;
let placed = [];

try {
  // ══ The shop, and a product with a real bulk band ═════════════════════════════════
  /*
   * The band has to be for the shape the MARKETPLACE shows, which is the sale unit
   * `public_product` picks — the same lateral pick, repeated here so the probe is checking the
   * price a shopper actually sees rather than some other unit's ladder.
   */
  const shopRows = await sql(
    `select s.code, p.id as product_id, p.name, su.price as base, t.min_qty, t.price as band
     from products p
     join stores s on s.id = p.store_id
     join lateral (
       select su2.id, su2.price from product_sale_units su2
       where su2.product_id = p.id order by su2.sort_order, su2.base_qty desc limit 1
     ) su on true
     join product_price_tiers t
       on t.product_id = p.id and t.sale_unit_id is not distinct from su.id
     where s.is_public and s.onboarded_at is not null
       and p.status = 'active' and p.confirmed_at is not null
       and su.price is not null and t.price < su.price
     order by t.min_qty limit 1`,
  );
  const banded = Array.isArray(shopRows) ? shopRows[0] : null;
  check('there is a public product with a bulk band to test', Boolean(banded), banded?.name ?? 'none found');
  if (!banded) throw new Error('no banded public product');
  note('band', `${banded.name}: ${banded.min_qty}+ at ₦${banded.band} (ordinarily ₦${banded.base})`);

  // ══ 1. A SHOP CANNOT ORDER FROM ITSELF ════════════════════════════════════════════
  const ownerToken = await signIn(env.SAMPLE_EMAIL, env.SAMPLE_PASSWORD);
  check('the shop owner can sign in', Boolean(ownerToken));

  // They need a shopper account for the refusal being tested to be the one that fires, rather
  // than "finish your shopper account first".
  await rpcAs(ownerToken, 'save_customer_account', { p_name: 'ZZ Probe Owner', p_phone: `0809${STAMP}` });

  const ownAttempt = await rpcAs(ownerToken, 'place_online_order', {
    p_store_code: banded.code,
    p_lines: [{ product_id: banded.product_id, qty: 1 }],
    p_note: null,
  });
  check(
    'the server refuses an order to the shop they work at',
    ownAttempt.status >= 400,
    `${ownAttempt.status} ${ownAttempt.body?.message ?? ''}`.slice(0, 80),
  );
  check(
    'and says why, in words the screen can show',
    /work at this shop/i.test(ownAttempt.body?.message ?? ''),
    ownAttempt.body?.message ?? '',
  );

  // ══ 2. THE BULK BAND IS APPLIED ═══════════════════════════════════════════════════
  const made = await admin('auth/v1/admin/users', {
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { signed_up_as: 'customer' },
  });
  shopperId = (await made.json().catch(() => null))?.id ?? null;
  const token = await signIn(EMAIL, PASSWORD);
  check('a shopper can sign in', Boolean(token));
  await rpcAs(token, 'save_customer_account', { p_name: `ZZ Probe Rules ${STAMP}`, p_phone: `0807${STAMP}` });

  const qty = Number(banded.min_qty);
  const atBand = await rpcAs(token, 'place_online_order', {
    p_store_code: banded.code,
    p_lines: [{ product_id: banded.product_id, qty, shown_price: banded.base }],
    p_note: null,
  });
  check('a shopper may order', atBand.status < 400, `${atBand.status} ${atBand.body?.message ?? ''}`.slice(0, 70));
  const row = Array.isArray(atBand.body) ? atBand.body[0] : atBand.body;
  if (row?.code) placed.push(row.code);

  const expected = Number(banded.band) * qty;
  check(
    `${qty} is charged at the band, not the ordinary price`,
    Number(row?.total) === expected,
    `got ₦${Number(row?.total).toLocaleString()} · band says ₦${expected.toLocaleString()} · ordinary would be ₦${(Number(banded.base) * qty).toLocaleString()}`,
  );
  check(
    'and the shopper is told the price differs from what the basket showed',
    Number(row?.repriced) === 1,
    `repriced: ${row?.repriced}`,
  );

  // One below the band pays the ordinary price — the band must not leak downwards.
  if (qty > 1) {
    const below = await rpcAs(token, 'place_online_order', {
      p_store_code: banded.code,
      p_lines: [{ product_id: banded.product_id, qty: qty - 1, shown_price: banded.base }],
      p_note: null,
    });
    const belowRow = Array.isArray(below.body) ? below.body[0] : below.body;
    if (belowRow?.code) placed.push(belowRow.code);
    check(
      `${qty - 1} is charged at the ordinary price`,
      Number(belowRow?.total) === Number(banded.base) * (qty - 1),
      `₦${Number(belowRow?.total).toLocaleString()}`,
    );
  }
} catch (e) {
  check('the probe ran to the end', false, e.message);
} finally {
  // Everything this wrote, removed: two orders and one account.
  if (placed.length) {
    await sql(
      `delete from draft_order_lines where draft_order_id in
         (select id from draft_orders where code in (${placed.map((c) => `'${c}'`).join(',')}) and source='online');
       delete from draft_orders where code in (${placed.map((c) => `'${c}'`).join(',')}) and source='online';`,
    );
  }
  if (shopperId) await admin(`auth/v1/admin/users/${shopperId}`, null, 'DELETE');
  // The owner's shopper account was created by this probe and is not otherwise real.
  await sql(`delete from customer_accounts where display_name = 'ZZ Probe Owner'`);

  console.log(failed === 0 ? '\n  all good\n' : `\n  ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}
