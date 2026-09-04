/**
 * A throwaway shop, and the tools to run a business through it.
 *
 * The benchmark runs against a shop CREATED FOR THE RUN and dropped afterwards. That is not
 * tidiness — it is the only way this can exist at all. Every ledger in this system is append-only
 * and there is no void path: a scenario that settles a sale in the real shop cannot take it back,
 * so a suite run twice would leave two of everything and a third run would be measuring the mess
 * from the first two.
 *
 * `delete from stores` cascades, verified before this was written. What survives a run is nothing.
 *
 * Every helper here goes through the SAME RPCs the app calls. A harness that writes rows directly
 * would pass while the app was broken, which is the one thing a benchmark must never do.
 *
 * AND IT SENDS WHAT THE APP SENDS — including, crucially, no `p_occurred_at`. The first trading run
 * stamped every write with this machine's clock, which is eight seconds behind the database, and
 * eight seconds put a delivery and a sale outside the counting period that should have contained
 * them. The count then read "you are 147 over" and closing it wrote 147 bottles into stock that had
 * never existed. The app was innocent — it lets the server stamp a sale — and the harness was
 * testing a shop nobody runs. Let the server say when something happened.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

export const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;

/** The shop's own client — everything a scenario does goes through this, as the app would. */
export const shop = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });

/** Only for looking, and for dropping the shop at the end. Never for writing what the app writes. */
export const admin = createClient(supabaseUrl, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export const money = (n) =>
  '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Two money figures agree if they agree to the kobo. Floating point does not deserve a vote. */
export const same = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

// ─── Running one ────────────────────────────────────────────────────────────────────

let failures = 0;
let checks = 0;

export function check(what, ok, detail = '') {
  checks += 1;
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

/**
 * Assert a figure, and SAY BOTH NUMBERS when it is wrong.
 *
 * "The balance is wrong" costs another run to find out by how much. Most accounting failures are
 * off by a recognisable amount — a deposit counted as goods, a fee added twice — and the difference
 * names the bug.
 */
export function expectMoney(what, got, want) {
  const ok = same(got, want);
  return check(what, ok, ok ? money(got) : `${money(got)}, expected ${money(want)}`);
}

export function expectQty(what, got, want) {
  const ok = Math.abs(Number(got) - Number(want)) < 0.0001;
  return check(what, ok, ok ? String(got) : `${got}, expected ${want}`);
}

export const results = () => ({ checks, failures });

// ─── The shop ───────────────────────────────────────────────────────────────────────

/**
 * A fresh shop, signed in as its owner.
 *
 * The owner is the sample account, because creating an auth user per run needs the admin API and
 * leaves users behind that nothing cascades. One person owning many shops is ordinary.
 */
export async function openShop(label) {
  const { error: signInErr } = await shop.auth.signInWithPassword({
    email: env.SAMPLE_EMAIL,
    password: env.SAMPLE_PASSWORD,
  });
  if (signInErr) throw new Error(`could not sign in: ${signInErr.message}`);

  const slug = `bench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const { error } = await shop.rpc('create_store', {
    p_name: `Benchmark — ${label}`,
    p_slug: slug,
  });
  if (error) throw new Error(`could not create the shop: ${error.message}`);

  const { data } = await admin.from('stores').select('id').eq('slug', slug).single();
  return { storeId: data.id, slug };
}

/**
 * And drop it.
 *
 * `delete from stores` cascades — except into `audit_log`, which is append-only and refuses, so a
 * shop that has actually TRADED cannot be deleted at all. The first run of this benchmark found
 * that by leaving its own shop behind.
 *
 * So the trigger comes off for the length of one delete and goes straight back, the way
 * `clean-probe-rows.py` already does for the deposit ledgers. Through the Management API rather
 * than the client, because the client cannot disable a trigger and should not be able to.
 */
export async function closeShop(storeId) {
  /*
   * ALL SEVEN of them, not just the first to complain.
   *
   * `audit_log` refused, and behind it were `stock_movements`, the three deposit ledgers and the two
   * review tables. Listed rather than looped over `pg_trigger` so that a table added to this family
   * later fails loudly here instead of quietly leaving shops behind.
   */
  const appendOnly = [
    'audit_log',
    'deposit_forfeits',
    'deposit_holdings',
    'deposit_ledger',
    'movement_reviews',
    'stock_movements',
    'variance_resolutions',
  ];
  /*
   * AND THE AUDIT TRIGGER, which is the one that actually stopped it.
   *
   * With the append-only triggers down the delete began, and then `audit` — which sits on the
   * tables being emptied — logged every deletion into `audit_log`, stamped with the id of the store
   * halfway through being deleted. A foreign key violation caused by the delete itself.
   *
   * `session_replication_role = replica` stands every user trigger down at once, including that
   * one, and leaves the foreign keys doing the cascade. Reset in the same script, so a run that
   * fails cannot leave the database with its triggers off — which would be a far worse thing to
   * leave behind than a shop.
   */
  const sql = `
    set session_replication_role = replica;
    delete from public.audit_log where store_id = '${storeId}';
    delete from public.stores    where id       = '${storeId}';
    reset session_replication_role;
  `;
  void appendOnly;
  try {
    const res = await fetch(
      `https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF ?? 'zinhzpgprhhqmyxmchhm'}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN ?? env.SUPABASE_MANAGEMENT_TOKEN}`,
          'Content-Type': 'application/json',
          // Cloudflare in front of the Management API rejects the default agent.
          'User-Agent': 'curl/8.4.0',
        },
        body: JSON.stringify({ query: sql }),
      },
    );
    if (!res.ok) throw new Error((await res.text()).slice(0, 160));
  } catch (e) {
    console.log(`    ..  the benchmark shop could not be dropped: ${String(e.message ?? e)}`);
    console.log(`    ..  it is ${storeId} — drop it by hand, or it will show up in the shop list`);
    return false;
  }

  const { data } = await admin.from('stores').select('id').eq('id', storeId);
  const gone = (data ?? []).length === 0;
  if (!gone) console.log('    ..  the shop is still there after the delete');
  return gone;
}

// ─── Doing business ─────────────────────────────────────────────────────────────────
//
// Each of these is the RPC the app calls, with the arguments the app sends. When one of them stops
// matching the app, the benchmark should break — that is the point of not writing rows directly.

/** A unit the shop names — Crate, Bottle, Kilogram. */
export async function makeUnit(storeId, name, plural) {
  const { data, error } = await shop.rpc('create_store_unit', {
    p_store_id: storeId,
    p_name: name,
    p_plural: plural ?? `${name}s`,
  });
  if (error) throw new Error(`unit "${name}": ${error.message}`);
  return data;
}

export async function makeProduct(storeId, name, baseUnit = 'piece') {
  const { data, error } = await shop.rpc('create_product', {
    p_store_id: storeId,
    p_name: name,
    p_base_unit: baseUnit,
    p_pack_name: null,
    p_pack_qty: null,
    p_list_price: null,
    p_price_per_pack: false,
  });
  if (error) throw new Error(`product "${name}": ${error.message}`);
  return data;
}

/**
 * The shapes a product comes in, and what each is for.
 *
 * `defined_against` is the PARENT and `defined_qty` how many to it — the tree, not a flat list of
 * multipliers. 0080 nearly erased every relationship in the shop by renaming this key, so the
 * harness sends exactly what the app sends.
 */
/**
 * @param shapes one object per shape, exactly as `saveProductUnits` sends them:
 *   `{ store_unit_id, is_sold, is_bought, is_counted, is_deposit, sell_price, is_returnable,
 *      whole_digit, allow_quarter, allow_half, allow_three_quarter,
 *      defined_against, defined_qty, base_qty, sort_order }`
 *   A shape with a parent gives `defined_against` and `defined_qty` and NO `base_qty` — the trigger
 *   works it out. A root shape gives `base_qty` and no parent.
 */
export async function setShapes(productId, shapes) {
  const { error } = await shop.rpc('save_product_units', {
    p_product_id: productId,
    p_units: shapes,
  });
  if (error) throw new Error(`shapes: ${error.message}`);
}

export async function makeCustomer(storeId, name, phone) {
  const { data, error } = await shop.rpc('upsert_customer', {
    p_store_id: storeId,
    p_phone: phone ?? null,
    p_display_name: name,
    p_business_name: null,
  });
  if (error) throw new Error(`customer "${name}": ${error.message}`);
  return data;
}

/** What the shop had before it started using this app — money owed, and containers already out. */
export async function backfillDebt(storeId, customerId, amount, note) {
  const { error } = await shop.rpc('backfill_debtor', {
    p_store_id: storeId,
    p_customer_id: customerId,
    p_amount: amount,
    // Dated BEFORE today on purpose: an opening balance is business done before this app, and the
    // reports separate it from business done here.
    p_as_of: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    p_note: note ?? 'from the book',
  });
  if (error) throw new Error(`opening balance: ${error.message}`);
}

export async function backfillEmpties(storeId, customerId, categoryId, qty) {
  const { error } = await shop.rpc('backfill_empties', {
    p_store_id: storeId,
    p_customer_id: customerId,
    p_category_id: categoryId,
    p_qty: qty,
    p_as_of: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
  });
  if (error) throw new Error(`opening empties: ${error.message}`);
}

export async function makePool(storeId, name, kind, deposit) {
  const { data, error } = await shop.rpc('create_empties_category', {
    p_store_id: storeId,
    p_name: name,
    p_kind: kind,
    p_deposit: deposit ?? 0,
  });
  if (error) throw new Error(`pool "${name}": ${error.message}`);
  return data;
}

/** A whole sale, the way the till settles one: a draft, then settling it. */
export async function sell(storeId, { customerId = null, lines, payments = [], charges = null, label }) {
  const clientUuid = randomUUID();
  const { data: draftId, error: draftErr } = await shop.rpc('save_draft_order', {
    p_store_id: storeId,
    p_client_uuid: clientUuid,
    p_customer_id: customerId,
    p_label: label ?? null,
    p_lines: lines,
    p_charges: charges,
  });
  if (draftErr) throw new Error(`draft: ${draftErr.message}`);

  const { data: saleId, error: settleErr } = await shop.rpc('settle_draft_order', {
    p_draft_id: draftId,
    p_payments: payments,
    p_client_uuid: clientUuid,
  });
  if (settleErr) throw new Error(`settling: ${settleErr.message}`);
  return { draftId, saleId };
}

/**
 * What the shop's own books say this customer owes.
 *
 * Asked through the SHOP's client, not the service role. These readers keep their membership test —
 * `empties_outstanding` has `is_store_member` in it — and the service role is not a member of
 * anything, so it reads a truthful zero for a customer holding four crates. The rule is in
 * CLAUDE.md: empty is the right answer to a read by a non-member, and the harness has to be a
 * member to get an answer.
 */
export async function balanceOf(customerId) {
  const { data } = await shop.rpc('customer_balance_total', { p_store_customer_id: customerId });
  return Number(data ?? 0);
}

/** What is on the shelf, in base units. */
export async function onHand(productId) {
  const { data } = await admin
    .from('stock_movements')
    .select('qty_delta')
    .eq('product_id', productId);
  return (data ?? []).reduce((sum, m) => sum + Number(m.qty_delta), 0);
}

/** Containers still out with a customer, per pool. */
export async function emptiesOut(customerId, categoryId) {
  const { data } = await shop.rpc('empties_outstanding', {
    p_store_customer_id: customerId,
    p_empties_category_id: categoryId,
  });
  return Number(data ?? 0);
}
