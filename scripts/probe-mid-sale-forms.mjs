/**
 * One product form, one customer form, reached mid-sale.
 *
 * The quick-add sheet is gone. The claims:
 *
 *   · adding an item from the till pushes the REAL form, not a second one;
 *   · it asks what a sale needs — what is on the shelf, whether the container comes back, how many
 *     are already out — and REFUSES A BLANK while ACCEPTING ZERO, because "none" and "nobody
 *     looked" are different facts;
 *   · the item lands on the receipt being built, and the count is recorded as opening stock;
 *   · a customer created mid-sale is asked what they already owed, on the same terms.
 *
 *     node scripts/probe-mid-sale-forms.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/mid-sale-forms';
mkdirSync(SHOTS, { recursive: true });

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

const storeId = (await admin.from('stores').select('id').limit(1).single()).data.id;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const stamp = Date.now().toString().slice(-6);
const ITEM = `ZZ Form ${stamp}`;
const made = { products: [], customers: [], units: [] };

// A unit for the picker to offer. The form requires one — a receipt line with no unit is
// unreadable — so this is the shop's word for it, not a shortcut around the requirement.
const unitId = (
  await admin
    .from('store_units')
    .insert({ store_id: storeId, name: `FUnit${stamp}`, plural: `FUnits${stamp}` })
    .select('id')
    .single()
).data.id;
made.units.push(unitId);

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');
const dialog = () => p.locator('[class*="dialog"]:visible, [role="alertdialog"]:visible').first();

const tab = async (label) => {
  await p.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll('div')) {
      if (el.scrollHeight > el.clientHeight + 40) el.scrollTop = 0;
    }
  });
  await p.waitForTimeout(700);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(3500);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ══ The real form, from the till ══════════════════════════════════════════════════
  console.log('\n— adding an item mid-sale —');
  await tab('Sell');
  await p.getByRole('button', { name: /^Add an item$/ }).first().click();
  await p.waitForTimeout(2500);
  await p.getByPlaceholder(/Search/i).first().fill(ITEM);
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: new RegExp(`Add "${ITEM}"`) }).first().click();
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `${SHOTS}/1-form.png`, fullPage: true });

  const form = await body();
  check('it is the REAL form, pushed as a page', /Add an item you sell/i.test(form), form.slice(0, 70));
  check('asking only what a sale needs', /the rest can wait/i.test(form), form.slice(0, 110));
  check('with the name carried across', (await p.getByLabel(/What is it called|Name/i).first().inputValue()).includes(ITEM));
  check('and it asks what is on the shelf', /On the shelf right now/i.test(form));
  check('and whether the container comes back', /Does the container come back/i.test(form));

  // ══ A BLANK is refused ════════════════════════════════════════════════════════════
  console.log('\n— a blank is refused; zero is accepted —');
  /*
   * Driven through the real UnitsEditor, because that is what the form uses.
   *
   * A first version filled a field called "What are you selling it in" — the quick-add sheet's
   * wording, which no longer exists. It matched nothing, the units stayed empty, and the probe
   * reported "zero not accepted" when what had actually happened was the form correctly refusing
   * an item with no unit.
   */
  const addUnitBtn = p.getByRole('button', { name: /Add a unit you sell in/i }).first();
  await addUnitBtn.scrollIntoViewIfNeeded();
  await addUnitBtn.click();
  await p.waitForTimeout(2500);
  await p.locator('[class*="UnitPicker_row"]').filter({ hasText: `FUnit${stamp}` }).first().click();
  await p.waitForTimeout(2000);

  const addIt = p.getByRole('button', { name: /^Add it$/ }).first();
  await addIt.scrollIntoViewIfNeeded();
  await addIt.click();
  await p.waitForTimeout(3000);
  await p.screenshot({ path: `${SHOTS}/2-blank-refused.png` });

  check(
    'leaving the shelf count blank is refused',
    (await dialog().count()) > 0 && /how many are on the shelf/i.test(await body()),
    (await body()).slice(0, 100),
  );
  if (await dialog().count()) {
    await p.getByRole('button', { name: /^OK$/ }).first().click();
    await p.waitForTimeout(1200);
  }

  const shelf = p.getByLabel(/On the shelf right now/i).first();
  await shelf.scrollIntoViewIfNeeded();
  await shelf.fill('0');
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${SHOTS}/3-zero-accepted.png` });

  await addIt.scrollIntoViewIfNeeded();
  await addIt.click();
  await p.waitForTimeout(7000);
  await p.screenshot({ path: `${SHOTS}/4-back-on-the-till.png` });

  check(
    'ZERO is accepted — "none" is an answer',
    (await dialog().count()) === 0,
    (await body()).slice(0, 90),
  );

  // ══ It landed on the receipt, and the count was recorded ══════════════════════════
  const onTill = await body();
  check('and the item is on the receipt being built', onTill.includes(ITEM), onTill.slice(0, 100));

  const { data: prod } = await admin
    .from('products').select('id, cost_is_estimated').eq('name', ITEM).maybeSingle();
  check('the product exists', Boolean(prod));
  if (prod) {
    made.products.push(prod.id);

    /*
     * A COUNT OF ZERO IS A COUNT, NOT A MOVEMENT.
     *
     * `stock_movements` refuses `qty_delta = 0` and is right to — nothing moved. But somebody
     * looked and said "none", and that has to be on the record or the shop cannot tell an item it
     * has run out of from one nobody has checked. An earlier version of this probe asserted an
     * opening movement with a delta of zero, which the database can never produce.
     */
    const { data: moves } = await admin
      .from('stock_movements').select('kind, qty_delta').eq('product_id', prod.id);
    check(
      'a zero count moves no stock, because nothing moved',
      (moves ?? []).length === 0,
      (moves ?? []).map((m) => `${m.kind} ${m.qty_delta}`).join(', ') || 'none',
    );

    /*
     * The error is read, not ignored.
     *
     * A first version selected `counted_qty`, which this table does not have — so the select
     * FAILED, returned nothing, and the probe reported "no count recorded" for a count that had
     * been recorded correctly. That is three times in this session a probe has mistaken a broken
     * query for a missing row, always because the error was discarded. Read it.
     */
    const { data: periods, error: periodErr } = await admin
      .from('stock_periods')
      .select('id, actual_closing_qty, status')
      .eq('product_id', prod.id);
    check(
      'but the count itself is recorded, so "none" is not "unknown"',
      !periodErr && (periods ?? []).length > 0 && Number(periods[0].actual_closing_qty) === 0,
      periodErr
        ? `query failed: ${periodErr.message.slice(0, 50)}`
        : `${(periods ?? []).length} period(s), counted ${periods?.[0]?.actual_closing_qty}`,
    );

    check(
      'and its cost is flagged as an estimate',
      prod.cost_is_estimated === true,
      String(prod.cost_is_estimated),
    );

    /*
     * And a real quantity DOES become an opening movement — not a purchase.
     *
     * A shop starting from its shelf has no invoice and no supplier, and a report that cannot tell
     * an opening from a delivery shows a month of purchases that never happened.
     */
    const shop2 = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    await shop2.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
    const { error: openErr } = await shop2.rpc('open_stock_by_count', {
      p_store_id: storeId,
      p_product_id: prod.id,
      p_qty: 9,
      p_unit_cost: 100,
      p_note: 'probe: nine on the shelf',
    });
    check('nine on the shelf is accepted', !openErr, openErr?.message ?? '');

    const { data: after } = await admin
      .from('stock_movements').select('kind, qty_delta').eq('product_id', prod.id);
    const opening = (after ?? []).filter((m) => m.kind === 'opening');
    check(
      'and lands as OPENING stock, not an invented delivery',
      opening.length === 1 && Number(opening[0].qty_delta) === 9,
      (after ?? []).map((m) => `${m.kind} ${m.qty_delta}`).join(', ') || 'none',
    );
  }

  // ══ A customer, on the same terms ════════════════════════════════════════════════
  console.log('\n— and a customer created mid-sale —');
  /*
   * Reached by the control the till actually has.
   *
   * A first version guessed at a button called "customer" and found nothing, so every check in this
   * section sat inside an `if` that never ran — and the probe reported success having tested
   * nothing at all. A second guessed at `forRow`, which belongs to the PAYMENT screen. The till's
   * own control says "Say who this sale is for", and asking for it by that name is the difference
   * between testing the journey and testing a guess.
   */
  const forRow = p.getByRole('button', { name: /Say who this sale is for|Change who this sale is for/i }).first();
  check('the till offers to name a customer', (await forRow.count()) > 0);
  await forRow.click();
  await p.waitForTimeout(4000);

  const CNAME = `ZZ Cust ${stamp}`;
  const csearch = p.getByPlaceholder(/Search/i).first();
  await csearch.fill(CNAME);
  await p.waitForTimeout(2500);
  const addCust = p.getByRole('button', { name: new RegExp(`Add "${CNAME}"|Add somebody|Add a new`) }).first();
  check('and adding one who is not on the list', (await addCust.count()) > 0, (await body()).slice(0, 90));
  await addCust.click();
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `${SHOTS}/5-customer-form.png`, fullPage: true });

  const cf = await body();
  check('the real customer form is pushed', /Add a customer/i.test(cf), cf.slice(0, 70));
  check('asking what they already owed', /Before you started here/i.test(cf));
  check('and what containers are out with them', /Containers already out/i.test(cf));

  // ── The requirements bite ───────────────────────────────────────────────────────
  await p.getByLabel(/Phone/i).first().fill(`0809${stamp}1`);
  await p.waitForTimeout(400);
  const saveCust = p.getByRole('button', { name: /Save customer|Add them|^Save$/i }).last();
  await saveCust.scrollIntoViewIfNeeded();
  await saveCust.click();
  await p.waitForTimeout(3000);

  check(
    'leaving what they owe blank is refused',
    (await dialog().count()) > 0 && /already owe/i.test(await body()),
    (await body()).slice(0, 110),
  );
  if (await dialog().count()) {
    await p.getByRole('button', { name: /^OK$/ }).first().click();
    await p.waitForTimeout(1200);
  }

  const owes = p.getByLabel(/They already owe you/i).first();
  await owes.scrollIntoViewIfNeeded();
  await owes.fill('0');
  await p.waitForTimeout(400);

  await saveCust.scrollIntoViewIfNeeded();
  await saveCust.click();
  await p.waitForTimeout(3000);
  await p.screenshot({ path: `${SHOTS}/6-empties-required.png` });

  /*
   * A LIST cannot be zero, so the question is asked outright.
   *
   * "None are out" is an answer; an empty list is not, and the two are indistinguishable a month
   * later. This is the same rule as the numbers, said the only way a list can say it.
   */
  const emptiesAsked = (await dialog().count()) > 0 && /containers already out/i.test(await body());
  check('and an unanswered empties question is refused too', emptiesAsked, (await body()).slice(0, 110));
  if (await dialog().count()) {
    await p.getByRole('button', { name: /^OK$/ }).first().click();
    await p.waitForTimeout(1200);
  }

  const none = p.getByText(/None are out with them/i).first();
  if (await none.count()) {
    await none.scrollIntoViewIfNeeded();
    await none.click();
    await p.waitForTimeout(600);
  }
  await saveCust.scrollIntoViewIfNeeded();
  await saveCust.click();
  await p.waitForTimeout(7000);
  await p.screenshot({ path: `${SHOTS}/7-customer-attached.png` });

  check('saying "none are out" is accepted', (await dialog().count()) === 0, (await body()).slice(0, 90));
  check(
    'and the customer is attached to the sale being built',
    (await body()).includes(CNAME),
    (await body()).slice(0, 110),
  );

  const { data: cust } = await admin
    .from('store_customers').select('id').eq('display_name', CNAME).maybeSingle();
  check('the customer exists', Boolean(cust));
  if (cust) made.customers.push(cust.id);

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  for (const id of made.products) {
    await admin.from('stock_movements').delete().eq('product_id', id);
    await admin.from('product_units').delete().eq('product_id', id);
    await admin.from('product_sale_units').delete().eq('product_id', id);
    const gone = await admin.from('products').delete().eq('id', id);
    if (gone.error) await admin.from('products').update({ status: 'archived' }).eq('id', id);
  }
  for (const id of made.customers) await admin.from('store_customers').delete().eq('id', id);
  await admin.from('store_customers').delete().like('display_name', `ZZ Cust ${stamp}%`);
  for (const id of made.units) await admin.from('store_units').delete().eq('id', id);
  console.log('\n  (probe rows removed)');
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
