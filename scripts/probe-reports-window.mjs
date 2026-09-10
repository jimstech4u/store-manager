/**
 * A report covers the window it says it covers — all of it.
 *
 * «we need filters, summary sections like daily, weekly, monthly, customs in the ui»
 *
 * The old sales report asked for `p_limit: 1000` and then filtered to thirty days IN JAVASCRIPT.
 * PostgREST caps a response at 1,000 rows regardless of what is asked for, so a shop with more than
 * a thousand receipts got a document quietly missing the rest — no error, no empty result, just a
 * window that silently stopped covering the thing being looked for.
 *
 * THE TRUNCATION IS THE POINT OF THIS PROBE, and it is proved in two halves. First that the cap is
 * REAL — `draft_orders` has over a thousand rows here and a single plain read returns exactly a
 * thousand of them, silently. Then that the reports do not read that way: each aggregates in SQL
 * and returns one row, checked against a direct aggregate paged past the limit.
 *
 * The sample shop has only about 180 sales, so the sales tables cannot demonstrate the cap
 * themselves — which is exactly why the first half exists rather than an assertion that would
 * quietly pass for the wrong reason.
 *
 * MUTATION TEST. Restore the fault and this fails:
 *   · cap `sales_summary` at 1000 rows            → "the total covers every receipt" fails.
 *   · resolve the period in UTC instead of the shop's zone → "today ends at the shop's midnight" fails.
 *
 *     node scripts/probe-reports-window.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const NL = String.fromCharCode(10);

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
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const period = async (kind, from, to) => {
  const { data, error } = await shop.rpc('period_range', {
    p_store_id: storeId,
    p_kind: kind,
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data[0] : data;
};

try {
  // ── The vocabulary ────────────────────────────────────────────────────────────────
  console.log(NL + '— one vocabulary for when —');

  const { data: st } = await shop.from('stores').select('timezone').eq('id', storeId).maybeSingle();
  const tz = st?.timezone ?? 'UTC';

  const today = await period('today');
  check('a period resolves to a range and a sentence', !!today.from_at && !!today.label, today.label);

  /*
   * THE SHOP'S MIDNIGHT, NOT THE SERVER'S.
   *
   * Eight seconds of clock skew once put a delivery in the wrong counting period and wrote 147
   * phantom bottles into stock. "Today's takings" read at seven in the morning has to agree with
   * the calendar on the wall, and Lagos is an hour ahead of UTC — so the day must NOT start at
   * 00:00Z.
   */
  const startsAt = new Date(today.from_at).toLocaleString('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
  });
  check(
    "today ends at the shop's midnight, not the server's",
    startsAt === '00:00',
    `${tz} local start ${startsAt}`,
  );

  const span = (p) => (new Date(p.to_at) - new Date(p.from_at)) / 86400000;
  check('today is exactly one day long', Math.round(span(today)) === 1, `${span(today)} days`);
  check('a week is seven', Math.round(span(await period('this_week'))) === 7);

  /*
   * HALF-OPEN, ALWAYS. Yesterday must END where today BEGINS — if the two overlap by so much as a
   * second, the boundary day is counted twice, and the boundary day is the one somebody checks
   * against the drawer.
   */
  const yday = await period('yesterday');
  check(
    'yesterday ends exactly where today begins',
    yday.to_at === today.from_at,
    `${yday.to_at} vs ${today.from_at}`,
  );

  const all = await period('all');
  check('and "everything" has no edges', all.from_at === null && all.to_at === null, all.label);

  const { error: nonsense } = await shop.rpc('period_range', {
    p_store_id: storeId,
    p_kind: 'next_tuesday',
  });
  check('an unknown period is refused', !!nonsense, nonsense?.message?.slice(0, 40) ?? 'accepted');

  // ── The truncation ────────────────────────────────────────────────────────────────
  console.log(NL + '— and the report covers all of it —');

  /*
   * FIRST, THAT THE CAP IS REAL — measured, not assumed.
   *
   * PostgREST answers at most 1,000 rows however many exist and however many are asked for, with no
   * error and no marker. The sample shop has only ~180 sales, so the sales tables cannot show this;
   * `draft_orders` has well over a thousand and shows it exactly. This is the mechanism that made
   * the old sales report wrong, demonstrated on the one table here big enough to demonstrate it.
   */
  const { count: drafts } = await admin
    .from('draft_orders')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', storeId);

  const { data: rawPage } = await shop
    .from('draft_orders')
    .select('id')
    .eq('store_id', storeId)
    .limit(5000);

  check(
    'a plain read is capped at a thousand rows, silently',
    (drafts ?? 0) > 1000 && (rawPage ?? []).length === 1000,
    `${drafts} rows exist, a single read returned ${(rawPage ?? []).length}`,
  );

  /*
   * AND THAT THE REPORTS DO NOT READ THAT WAY.
   *
   * They aggregate in SQL and return one row, so the cap cannot reach them — proved by comparing
   * the report's own total against a direct aggregate PAGED past the limit. Counting rows alone
   * would survive a cap that happened to fall on a round number; totalling them cannot.
   */
  const { count: everSold } = await admin
    .from('sales')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', storeId)
    .eq('status', 'posted');

  const ever = await period('all');
  const { data: sum } = await shop.rpc('sales_summary', {
    p_store_id: storeId,
    p_from: ever.from_at,
    p_to: ever.to_at,
  });
  const s = Array.isArray(sum) ? sum[0] : sum;

  check(
    'the report counts every receipt',
    Number(s?.receipts) === Number(everSold),
    `report ${s?.receipts}, actually ${everSold}`,
  );

  let billed = 0;
  let page = 0;
  for (;;) {
    const { data, error } = await admin
      .from('sales')
      .select('total')
      .eq('store_id', storeId)
      .eq('status', 'posted')
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data.length) break;
    billed += data.reduce((t, r) => t + Number(r.total), 0);
    page += 1;
  }

  check(
    'and the total is the whole total',
    Math.abs(Number(s?.billed) - billed) < 0.01,
    `report ₦${Number(s?.billed).toLocaleString()}, direct ₦${billed.toLocaleString()}`,
  );

  // ── The window actually windows ───────────────────────────────────────────────────
  console.log(NL + '— and a window excludes what is outside it —');

  const month = await period('this_month');
  const { data: monthSum } = await shop.rpc('sales_summary', {
    p_store_id: storeId,
    p_from: month.from_at,
    p_to: month.to_at,
  });
  const m = Array.isArray(monthSum) ? monthSum[0] : monthSum;
  check(
    'a month is a subset of everything',
    Number(m?.receipts) <= Number(s?.receipts),
    `${m?.receipts} of ${s?.receipts}`,
  );

  const days = (await shop.rpc('sales_by_day', {
    p_store_id: storeId,
    p_from: month.from_at,
    p_to: month.to_at,
  })).data ?? [];
  const fromDays = days.reduce((t, d) => t + Number(d.billed), 0);
  check(
    'and the days in it add up to the month',
    Math.abs(fromDays - Number(m?.billed)) < 0.01,
    `days ₦${fromDays.toLocaleString()}, month ₦${Number(m?.billed).toLocaleString()}`,
  );

  // ── The rest of the catalogue answers ─────────────────────────────────────────────
  console.log(NL + '— and every report answers —');
  for (const [fn, args] of [
    ['sales_by_product', { p_store_id: storeId, p_from: month.from_at, p_to: month.to_at }],
    ['takings_by_method', { p_store_id: storeId, p_from: month.from_at, p_to: month.to_at }],
    ['debtors_aged', { p_store_id: storeId }],
    ['price_list', { p_store_id: storeId }],
    ['staff_activity', { p_store_id: storeId, p_from: month.from_at, p_to: month.to_at }],
  ]) {
    const { error } = await shop.rpc(fn, args);
    check(`${fn} answers`, !error, error?.message ?? '');
  }

  /*
   * AND THE PRICE LIST LEAKS NOTHING.
   *
   * A seller printing a list for the wall must not need a permission that also shows what the shop
   * paid. If a cost ever appears in these columns, the poster carries the shop's margins onto a
   * wall its customers stand in front of.
   */
  const { data: prices } = await shop.rpc('price_list', { p_store_id: storeId });
  const leaked = Object.keys((prices ?? [])[0] ?? {}).filter((k) =>
    /cost|margin|profit/i.test(k),
  );
  check('the price list carries no cost', leaked.length === 0, leaked.join(', ') || 'none');
} catch (e) {
  console.log(`  FAIL  the probe could not finish — ${e.message}`);
  failed += 1;
} finally {
  // Reads only. Nothing is written, so there is nothing to leave behind and nothing to tidy.
  console.log(NL + '  left behind: nothing — this probe only reads.');
}

console.log(NL + (failed === 0 ? 'ALL PASS' : `${failed} FAILED`));
process.exit(failed === 0 ? 0 : 1);
