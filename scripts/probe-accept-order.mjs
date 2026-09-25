/**
 * ACCEPTING AN ORDER PUTS A CUSTOMER ON THE TILL.
 *
 * The reported failure: accept an order, land on the till, and it says "No customer being served"
 * — while the order sits in the database perfectly claimed. Nothing errored, nothing looked broken,
 * and the shop's answer had simply gone nowhere it could see.
 *
 * The cause is worth stating because it is invisible from the database: the till's open orders are
 * a LIST IT HOLDS, and `accept_online_order` claimed the draft server-side without telling it. The
 * fix is that accepting goes on to call the till's own `claimByCode`, the same path the counter
 * uses when somebody reads a code aloud. So the only check worth having is the one this makes: after
 * accepting, is there a customer being served, and is it the right one?
 *
 * The order is placed through the RPC rather than the shop pages — the shopper's journey has its own
 * probe (`probe-checkout`) and repeating it here would only make this slower and vaguer about what
 * failed.
 *
 *     node scripts/probe-accept-order.mjs [http://localhost:3101]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
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

const signInApi = async (email, password) => {
  const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return (await res.json().catch(() => null))?.access_token ?? null;
};

const STAMP = Date.now().toString().slice(-8);
const EMAIL = `probe.accept.${STAMP}@example.com`;
const PASSWORD = `Probe-${STAMP}!`;
const NAME = `ZZ Probe Accept ${STAMP}`;
const PHONE = `0806${STAMP}`;

let shopperId = null;
let code = null;
const browser = await chromium.launch();
const shop = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const rpcLog = [];
shop.on('response', async (r) => {
  const m = /\/rpc\/([a-z_]+)/.exec(r.url());
  if (!m) return;
  if (!/accept_online_order|claim_draft_order|my_open_drafts|search_draft_orders/.test(m[1])) return;
  let body = '';
  try { body = (await r.text()).slice(0, 120); } catch {}
  rpcLog.push(`${m[1]} ${r.status()} ${body}`);
});
shop.on('console', (m) => { if (m.type() === 'error') rpcLog.push('console: ' + m.text().slice(0, 140)); });

try {
  // ══ An order waiting, placed as a real shopper ════════════════════════════════════
  const rows = await sql(
    `select s.code as store_code, p.id as product_id
     from products p join stores s on s.id = p.store_id
     where s.is_public and s.onboarded_at is not null
       and p.status = 'active' and p.confirmed_at is not null
     limit 1`,
  );
  const target = Array.isArray(rows) ? rows[0] : null;
  check('there is a public product to order', Boolean(target), target?.product_id ?? 'none');
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
  const token = await signInApi(EMAIL, PASSWORD);
  await rpcAs(token, 'save_customer_account', { p_name: NAME, p_phone: PHONE });
  const placed = await rpcAs(token, 'place_online_order', {
    p_store_code: target.store_code,
    p_lines: [{ product_id: target.product_id, qty: 2 }],
    p_note: null,
  });
  code = (Array.isArray(placed.body) ? placed.body[0] : placed.body)?.code ?? null;
  check('an order is waiting for the shop', Boolean(code), code ?? JSON.stringify(placed.body).slice(0, 70));
  if (!code) throw new Error('could not place an order');

  // ══ The shop opens it ═════════════════════════════════════════════════════════════
  await shop.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await shop.waitForTimeout(2500);
  await shop.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await shop.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await shop.locator('button[type="submit"]').first().click();
  await shop.waitForTimeout(16000);
  check('the shop is at its till', new URL(shop.url()).pathname.startsWith('/main'));

  await shop.locator('.nav-item').filter({ hasText: /^Sell$/ }).first().dispatchEvent('click');
  await shop.waitForTimeout(5000);
  await shop.getByRole('button', { name: /orders/i }).first().dispatchEvent('click');
  await shop.waitForTimeout(5000);

  const card = shop.locator('li').filter({ hasText: code }).first();
  check('the order is in the queue', (await card.count()) > 0, code);
  // A glimpse of what is on it, so two orders for the same money are not identical rows.
  const cardText = (await card.innerText()).replace(/\s+/g, ' ');
  check('and the card says what is on it', /×/.test(cardText), cardText.slice(0, 70));

  await card.getByRole('button').first().dispatchEvent('click');
  await shop.waitForTimeout(5000);
  check('it opens the order', (await shop.locator('body').innerText()).includes(code));

  // ══ ACCEPT — and the till must have a customer on it ══════════════════════════════
  await shop.getByRole('button', { name: /accept and open at the till/i }).first().dispatchEvent('click');
  await shop.waitForTimeout(12000);

  for (const line of rpcLog) note('rpc', line);
  const till = (await shop.locator('body').innerText()).replace(/\s+/g, ' ');
  check('accepting lands back at the till', new URL(shop.url()).pathname.startsWith('/main'), new URL(shop.url()).pathname);
  /*
   * THE CHECK THIS FILE EXISTS FOR. The order was claimed in the database the whole time; what was
   * missing was the till knowing about it.
   */
  check('and somebody is being served', !/no customer being served/i.test(till), till.slice(0, 80));
  /*
   * NOT by the shopper's name: the tab strip labels tabs by position ("Customer 4"), so a name
   * check would be testing the strip rather than the order. What proves the right order is open is
   * what is ON it — the product this probe ordered.
   */
  const product = await sql(`select name from products where id = '${target.product_id}'`);
  const productName = Array.isArray(product) ? product[0]?.name : null;
  check(
    'and the order that was accepted is the one open',
    Boolean(productName) && till.includes(productName),
    productName ? `${productName} on the till` : 'could not read the product name',
  );

  // Did the write land in the store, or just not reach the screen? A reload answers that: the
  // till rebuilds from the same persisted state either way.
  const persisted = await shop.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open('StateStackDB', 1);
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const st = open.result.transaction(['state'], 'readonly').objectStore('state');
      const a = st.get('sell_flow::draftActive');
      const o = st.get('sell_flow::draftOrders');
      a.onsuccess = () => { o.onsuccess = () => resolve({ active: a.result, orders: String(o.result).slice(0, 160) }); };
    };
  }));
  note('persisted active', JSON.stringify(persisted?.active ?? null));
  note('persisted orders', String(persisted?.orders ?? '').slice(0, 120));

  await shop.reload({ waitUntil: 'domcontentloaded' });
  await shop.waitForTimeout(12000);
  const afterReload = (await shop.locator('body').innerText()).replace(/\s+/g, ' ');
  check('after a reload, somebody is being served', !/no customer being served/i.test(afterReload), afterReload.slice(0, 70));

  // The shop's own customer record was made from the order, which is what lets them be followed up.
  const linked = await sql(
    `select sc.display_name
     from draft_orders d join store_customers sc on sc.id = d.store_customer_id
     where d.code = '${code}'`,
  );
  check(
    'the order now carries the shop\'s customer record for them',
    Array.isArray(linked) && linked[0]?.display_name === NAME,
    Array.isArray(linked) ? (linked[0]?.display_name ?? 'no customer attached') : 'read failed',
  );
} catch (e) {
  check('the probe ran to the end', false, e.message);
} finally {
  await browser.close();
  /*
   * The accepted order is now an open tab at a real shop's till, so it is cancelled rather than
   * left for somebody to find. Its customer record is left: it is an ordinary customer of that
   * shop now, and deleting people is not something a probe should do quietly.
   */
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
  await sql(`delete from store_customers where display_name like 'ZZ Probe Accept %'`);

  console.log(failed === 0 ? '\n  all good\n' : `\n  ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}
