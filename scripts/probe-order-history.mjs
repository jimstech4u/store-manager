/**
 * AN ORDER HAS AN ANSWER, AND THE ANSWER HAS A HISTORY.
 *
 * Three rules, all of them server-side, all checked by calling the functions directly — the screen
 * is not what enforces any of them and a hidden button is not a rule.
 *
 *   ANSWERED ONCE. Accepting used to check `status`, which is the SALE's business and stays 'open'
 *   while an accepted order sits at the till. So the queue went on listing it, the badge went on
 *   counting it, and it could be accepted again and again — each time claiming it afresh and each
 *   time making another customer record.
 *
 *   REOPENING IS GATED AND EXPLAINED. Putting an answer back is a correction, so it asks for
 *   `sales.amend` and refuses to happen without a reason. A correction nobody explained is a
 *   correction nobody can review.
 *
 *   THE HISTORY IS THE SEQUENCE. "Placed, accepted, reopened, turned down" is a real thing that can
 *   happen to one order, and the log has to be able to say so — in order, with who and why.
 *
 *     node scripts/probe-order-history.mjs
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
  return (await res.json().catch(() => null))?.access_token ?? null;
};

const STAMP = Date.now().toString().slice(-8);
const EMAIL = `probe.history.${STAMP}@example.com`;
const PASSWORD = `Probe-${STAMP}!`;
const NAME = `ZZ Probe History ${STAMP}`;

let shopperId = null;
let code = null;
let draftId = null;

try {
  const rows = await sql(
    `select s.id as store_id, s.code as store_code, p.id as product_id
     from products p join stores s on s.id = p.store_id
     where s.is_public and s.onboarded_at is not null
       and p.status = 'active' and p.confirmed_at is not null
     limit 1`,
  );
  const target = Array.isArray(rows) ? rows[0] : null;
  check('there is a public product to order', Boolean(target));
  if (!target) throw new Error('nothing public to order');

  const made = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: EMAIL, password: PASSWORD, email_confirm: true,
      user_metadata: { signed_up_as: 'customer' },
    }),
  });
  shopperId = (await made.json().catch(() => null))?.id ?? null;
  const shopper = await signIn(EMAIL, PASSWORD);
  await rpcAs(shopper, 'save_customer_account', { p_name: NAME, p_phone: `0805${STAMP}` });

  const placed = await rpcAs(shopper, 'place_online_order', {
    p_store_code: target.store_code,
    p_lines: [{ product_id: target.product_id, qty: 1 }],
    p_note: null,
  });
  code = (Array.isArray(placed.body) ? placed.body[0] : placed.body)?.code ?? null;
  check('an order is placed', Boolean(code), code ?? '');
  draftId = (await sql(`select id from draft_orders where code = '${code}'`))[0]?.id;

  const owner = await signIn(env.SAMPLE_EMAIL, env.SAMPLE_PASSWORD);
  check('the shop signs in', Boolean(owner));

  // ══ 1. Waiting, and findable ══════════════════════════════════════════════════════
  const waiting = await rpcAs(owner, 'online_orders', {
    p_store_id: target.store_id, p_answer: 'waiting', p_since: null, p_query: null, p_limit: 60,
  });
  check(
    'it is in the waiting list',
    (Array.isArray(waiting.body) ? waiting.body : []).some((o) => o.code === code),
  );

  const found = await rpcAs(owner, 'online_orders', {
    p_store_id: target.store_id, p_answer: null, p_since: null, p_query: NAME, p_limit: 60,
  });
  check(
    'and can be searched for by the shopper’s name',
    (Array.isArray(found.body) ? found.body : []).some((o) => o.code === code),
  );

  const byCode = await rpcAs(owner, 'online_orders', {
    p_store_id: target.store_id, p_answer: null, p_since: null, p_query: code, p_limit: 60,
  });
  check('and by its code', (Array.isArray(byCode.body) ? byCode.body : []).length >= 1);

  // ══ 2. Turned down, once ══════════════════════════════════════════════════════════
  const declined = await rpcAs(owner, 'decline_online_order', {
    p_draft_id: draftId, p_reason: 'Out of stock today',
  });
  check('it can be turned down', declined.status < 400, `${declined.status}`);

  const again = await rpcAs(owner, 'decline_online_order', { p_draft_id: draftId, p_reason: null });
  check(
    'and not turned down twice',
    again.status >= 400 && /already been answered/i.test(again.body?.message ?? ''),
    `${again.status} ${again.body?.message ?? ''}`.slice(0, 60),
  );

  const gone = await rpcAs(owner, 'online_orders', {
    p_store_id: target.store_id, p_answer: 'waiting', p_since: null, p_query: null, p_limit: 60,
  });
  check(
    'it has left the waiting list',
    !(Array.isArray(gone.body) ? gone.body : []).some((o) => o.code === code),
  );
  const inDeclined = await rpcAs(owner, 'online_orders', {
    p_store_id: target.store_id, p_answer: 'declined', p_since: null, p_query: null, p_limit: 60,
  });
  check(
    'and appears under turned down',
    (Array.isArray(inDeclined.body) ? inDeclined.body : []).some((o) => o.code === code),
  );

  // ══ 3. Reopening: gated, and it needs a reason ════════════════════════════════════
  const noReason = await rpcAs(owner, 'reopen_online_order', { p_draft_id: draftId, p_reason: '  ' });
  check(
    'reopening without a reason is refused',
    noReason.status >= 400 && /say why/i.test(noReason.body?.message ?? ''),
    noReason.body?.message ?? '',
  );

  /*
   * THE SHOPPER, who has no business at this shop at all, is the cheapest proof that this is gated
   * on the server rather than by hiding a button. A staff account would test the permission more
   * precisely; this tests that the gate exists.
   */
  const byStranger = await rpcAs(shopper, 'reopen_online_order', {
    p_draft_id: draftId, p_reason: 'let me in',
  });
  check(
    'and somebody who does not work here cannot reopen it',
    byStranger.status >= 400,
    `${byStranger.status} ${byStranger.body?.message ?? ''}`.slice(0, 60),
  );

  const reopened = await rpcAs(owner, 'reopen_online_order', {
    p_draft_id: draftId, p_reason: 'Turned down by mistake',
  });
  check('an owner can reopen it, with a reason', reopened.status < 400, `${reopened.status}`);

  const backWaiting = await rpcAs(owner, 'online_orders', {
    p_store_id: target.store_id, p_answer: 'waiting', p_since: null, p_query: null, p_limit: 60,
  });
  check(
    'and it is waiting again',
    (Array.isArray(backWaiting.body) ? backWaiting.body : []).some((o) => o.code === code),
  );

  // ══ 4. The history is the sequence ════════════════════════════════════════════════
  const history = await rpcAs(owner, 'online_order_history', { p_draft_id: draftId });
  const actions = (Array.isArray(history.body) ? history.body : []).map((e) => e.action);
  note('history', actions.join(' → '));
  check(
    'the history reads placed → declined → reopened',
    JSON.stringify(actions) === JSON.stringify(['placed', 'declined', 'reopened']),
    actions.join(' → '),
  );
  const why = (Array.isArray(history.body) ? history.body : []).find((e) => e.action === 'reopened');
  check('and keeps the reason it was given', why?.reason === 'Turned down by mistake', why?.reason ?? '(none)');
  check(
    'and names who did it',
    Boolean(why?.actor_name) && why.actor_name !== 'The shopper',
    why?.actor_name ?? '(nobody)',
  );
} catch (e) {
  check('the probe ran to the end', false, e.message);
} finally {
  if (code) {
    await sql(
      `delete from draft_order_lines where draft_order_id in (select id from draft_orders where code = '${code}');
       delete from draft_orders where code = '${code}' and source = 'online';`,
    );
    note('cleaned up', `order ${code}`);
  }
  if (shopperId) {
    await fetch(`${URL_BASE}/auth/v1/admin/users/${shopperId}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
  }
  console.log(failed === 0 ? '  all good' : '  ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
