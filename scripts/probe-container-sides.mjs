/**
 * Which way each container movement ran.
 *
 * `they_hold` is ours, out with them; `we_hold` is theirs, left with us. Both the standing figures
 * and the history read as if every row were the first kind: a customer holding 55 of our crates
 * while we held 65 of theirs was shown "120 crates still with them", and the rows where they left
 * their own crates with the shop said "Took". This checks the screen against the ledger, for a
 * customer who is on both sides of it.
 *
 * Figures are compared PER SHAPE. 55 crates and 8 bottles are two facts, not 63 of anything.
 *
 *     node scripts/probe-container-sides.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const says = (text, n) => new RegExp(`\\b${n}\\b`).test(text);

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await db.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const { data: membership } = await db.rpc('my_membership');
const storeId = (membership.find((m) => m.store_name === env.SAMPLE_STORE) ?? membership[0]).store_id;

// Somebody who is on BOTH sides — the case every screen used to flatten.
const { data: customers } = await db.rpc('customers_with_empties', { p_store_id: storeId });
let both = null;
for (const c of customers ?? []) {
  const id = c.store_customer_id ?? c.id;
  const { data: owed } = await db.rpc('customer_empties_owed', { p_store_customer_id: id });
  const live = (owed ?? []).filter((r) => Number(r.owed) > 0);
  const sides = new Set(live.map((r) => r.side));
  if (sides.has('they_hold') && sides.has('we_hold')) {
    both = { id, name: c.display_name ?? c.customer_name, owed: live };
    break;
  }
}
check('the shop has a customer on both sides of the ledger', Boolean(both), both?.name ?? 'none');
if (!both) process.exit(1);

const rowsFor = (side) => both.owed.filter((r) => r.side === side);
const theyRows = rowsFor('they_hold');
const weRows = rowsFor('we_hold');
// A shape on both sides is the one that used to be added up.
const onBoth = theyRows.find((t) => weRows.some((w) => w.product_unit_id === t.product_unit_id));
const mergedWouldBe = onBoth
  ? Number(onBoth.owed) +
    Number(weRows.find((w) => w.product_unit_id === onBoth.product_unit_id).owed)
  : null;
console.log(
  `  ledger: they hold ${theyRows.map((r) => `${r.owed} ${r.unit_name}`).join(', ')}` +
    ` | we hold ${weRows.map((r) => `${r.owed} ${r.unit_name}`).join(', ')}` +
    (mergedWouldBe ? ` | added up, one shape would read ${mergedWouldBe}` : ''),
);

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(14000);

  await p
    .getByRole('button', { name: /Containers still to come back/i })
    .locator('visible=true')
    .first()
    .click();
  await p.waitForTimeout(6000);
  const row = p
    .getByRole('button', { name: new RegExp(both.name.slice(0, 18)) })
    .locator('visible=true')
    .first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await p.waitForTimeout(7000);

  const text = await p.evaluate(() => {
    const pages = [...document.querySelectorAll('.navstack-page')].filter((c) => c.offsetParent !== null);
    return (pages[pages.length - 1] ?? document.body).innerText.replace(/\s+/g, ' ');
  });

  check('the two sides are named apart', /Still with them/.test(text) && /Theirs, in your yard/.test(text));

  const figures = text.split('Everything that has happened')[0];
  if (mergedWouldBe) {
    check('the two sides are not added together', !says(figures, mergedWouldBe), `must not say ${mergedWouldBe}`);
  }

  const stillWith = text.split('Still with them')[1]?.split('Theirs, in your yard')[0] ?? '';
  for (const r of theyRows) {
    check(`"Still with them" says ${r.owed} ${r.unit_name.toLowerCase()}`, says(stillWith, r.owed), stillWith.slice(0, 70));
  }
  const inYard = text.split('Theirs, in your yard')[1]?.split('They brought some back')[0] ?? '';
  for (const r of weRows) {
    check(`"Theirs, in your yard" says ${r.owed} ${r.unit_name.toLowerCase()}`, says(inYard, r.owed), inYard.slice(0, 70));
  }

  // The history: rows on the shop's side are not worded as if the customer took them.
  const { data: moves } = await db.rpc('customer_empties_ledger', { p_store_customer_id: both.id });
  const weHoldOut = (moves ?? []).filter((m) => m.side === 'we_hold' && m.direction === 'out').length;
  const history = text.split('Everything that has happened')[1] ?? '';
  check('the history has rows for the shop’s side', weHoldOut > 0, `${weHoldOut} rows`);
  check('one of them reads "Left with you", not "Took"', /Left with you/.test(history), history.slice(0, 90));
} catch (e) {
  console.log('STOPPED:', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
