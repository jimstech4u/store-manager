/**
 * A SUPPLIER'S CONTAINERS, COUNTED BY MAKER.
 *
 * A supplier delivers Gulder, Goldberg and 33 Export and takes back "25 NBL crates" — nobody
 * records which beer was in which, because an NBL crate is an NBL crate. The customer ledger and
 * the yard have both had that grain since they were built; `supplier_empties` had not, so the only
 * thing it could record was "3 Goldberg 60cl crates" and the form asked for every returnable shape
 * the shop has as its own numbered box.
 *
 * Checked through the RPCs rather than the screen, because the rules live there: the grain is
 * enforced by a database constraint, and both readers had inner joins that would have dropped a
 * maker-grain row silently — recorded, counted in the outstanding figure, and invisible.
 *
 *     node scripts/probe-supplier-empties.mjs
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

const STAMP = Date.now().toString().slice(-8);
let supplierId = null;

try {
  const token = await (
    await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD }),
    })
  ).json().then((r) => r.access_token);
  check('the shop signs in', Boolean(token));

  const ctx = (await sql(
    `select s.id as store_id,
            (select c.id from product_categories c
              where c.store_id = s.id and coalesce(c.status,'active')='active' limit 1) as category_id,
            (select c.name from product_categories c
              where c.store_id = s.id and coalesce(c.status,'active')='active' limit 1) as category_name,
            (select u.id from store_units u where u.store_id = s.id limit 1) as store_unit_id
       from stores s where s.code = '7R8U2A'`,
  ))[0];
  check('there is a maker and a unit to count in', Boolean(ctx?.category_id && ctx?.store_unit_id),
    `${ctx?.category_name ?? 'no maker'}`);
  if (!ctx?.category_id) throw new Error('no maker to test with');

  // A supplier of this probe's own, so nothing here touches a real account.
  const made = await rpcAs(token, 'upsert_supplier', {
    p_store_id: ctx.store_id,
    p_name: `ZZ Probe Supplier ${STAMP}`,
    p_phone: null,
    p_note: null,
    p_id: null,
  });
  supplierId = made.body;
  check('a supplier can be added', Boolean(supplierId), `${made.status}`);

  // ══ 1. MAKER GRAIN — the thing that was impossible ════════════════════════════════
  const recorded = await rpcAs(token, 'record_supplier_empties_for_group', {
    p_store_id: ctx.store_id,
    p_supplier_id: supplierId,
    p_category_id: ctx.category_id,
    p_store_unit_id: ctx.store_unit_id,
    p_qty: 25,
    p_side: 'we_hold',
    p_direction: 'out',
    p_note: 'Probe: 25 of theirs in the yard',
  });
  check('25 of a maker’s crates can be recorded', recorded.status < 400,
    `${recorded.status} ${recorded.body?.message ?? ''}`.slice(0, 70));

  // ══ 2. AND IT IS VISIBLE — both readers inner-joined products before ══════════════
  const sent = await rpcAs(token, 'supplier_empties_sent', { p_supplier_id: supplierId });
  const makerRow = (Array.isArray(sent.body) ? sent.body : []).find((r) => r.category_id === ctx.category_id);
  check('it shows on the supplier’s account', Boolean(makerRow),
    JSON.stringify(Array.isArray(sent.body) ? sent.body.slice(0, 1) : sent.body).slice(0, 80));
  check('as 25 outstanding', Number(makerRow?.outstanding) === 25, `${makerRow?.outstanding}`);
  check('named by the maker, not a product', makerRow?.product_id === null && Boolean(makerRow?.category_name),
    makerRow?.category_name ?? '');

  const history = await rpcAs(token, 'supplier_history', { p_supplier_id: supplierId });
  const ev = (Array.isArray(history.body) ? history.body : []).find((e) => e.kind === 'empties');
  check('and on the supplier’s history', Boolean(ev), ev?.detail ?? 'not on the timeline');
  check('saying the maker and the count', (ev?.detail ?? '').includes('25'), ev?.detail ?? '');

  // ══ 3. ONE GRAIN OR THE OTHER, enforced by the database ═══════════════════════════
  const both = await sql(
    `insert into supplier_empties (store_id, supplier_id, product_id, product_unit_id, category_id, store_unit_id, qty, side, direction)
     select '${ctx.store_id}', '${supplierId}', p.id, pu.id, '${ctx.category_id}', '${ctx.store_unit_id}', 1, 'we_hold', 'out'
       from products p join product_units pu on pu.product_id = p.id
      where p.store_id = '${ctx.store_id}' limit 1`,
  );
  check(
    'a row that is half each grain is refused',
    Boolean(both?.message && /supplier_empties_one_grain/.test(both.message)),
    (both?.message ?? 'it was accepted').slice(0, 70),
  );
} catch (e) {
  check('the probe ran to the end', false, e.message);
} finally {
  if (supplierId) {
    await sql(
      `delete from supplier_empties where supplier_id = '${supplierId}';
       delete from suppliers where id = '${supplierId}';`,
    );
    note('cleaned up', 'the probe’s supplier and its containers');
  }
  console.log(failed === 0 ? '  all good' : '  ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
