/**
 * A Goldberg opened from the shelf: crates and bottles, full and empty.
 *
 * The product form asked one number for "on the shelf right now" and never said which shape it
 * meant, and one for "containers already out with customers" — a question about a CUSTOMER, whose
 * answer this form had nowhere to put and duly wrote nowhere at all.
 *
 * It now asks a box per shape the shop counts in, and a box per shape that comes back, and this
 * checks the FIGURES THAT LAND — not that the form saved. The one that matters is the shelf: shapes
 * are saved before `base_qty` is derived, so a form multiplying by the shape's own `baseQty` puts
 * twelve crates away as twelve bottles and nothing on screen looks wrong.
 *
 *     node scripts/probe-opening-in-shapes.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS = 'shots/opening-in-shapes';
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

const stamp = Date.now().toString().slice(-6);
const CRATE = `OCrate${stamp}`;
const BOTTLE = `OBottle${stamp}`;
const NAME = `ZZ Opening ${stamp}`;

const madeUnits = [];
for (const [name, plural] of [
  [CRATE, `${CRATE}s`],
  [BOTTLE, `${BOTTLE}s`],
]) {
  const { data } = await admin
    .from('store_units')
    .insert({ store_id: storeId, name, plural })
    .select('id')
    .single();
  madeUnits.push(data.id);
}

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

let step = 0;
const shot = async (name) => {
  step += 1;
  const file = `${SHOTS}/${String(step).padStart(2, '0')}-${name}.png`;
  await p.screenshot({ path: file });
  console.log(`     ${file}`);
};

const addShape = async (unitName) => {
  await p.getByRole('button', { name: /Add a shape/i }).first().click();
  await p.waitForTimeout(2000);
  const box = p.getByPlaceholder(/Crate, Bag, Litre/i).first();
  await box.click();
  await p.waitForTimeout(500);
  await box.pressSequentially(unitName, { delay: 40 });
  await p.waitForTimeout(3000);
  await p.locator('[class*="UnitPicker_row"]').filter({ hasText: unitName }).first().click();
  await p.waitForTimeout(1500);
};

const card = (name) =>
  p
    .locator('li[class*="UnitsEditor_card__"]')
    .filter({ hasText: new RegExp(`^${name}`) })
    .first();

/** Tick one of the four roles on a shape, by its words. */
const role = async (name, words) =>
  card(name)
    .locator('label')
    .filter({ hasText: words })
    .first()
    .locator('input')
    .check();

let productId = null;

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  // Waited FOR, not waited out: the nav bar appearing is what "signed in" means, and a cold dev
  // server compiles /main for longer than any fixed number worth writing down.
  await p.locator('.nav-item').first().waitFor({ state: 'visible', timeout: 180000 });
  await p.waitForTimeout(3000);

  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(800);
  await p
    .locator('.nav-item')
    .filter({ hasText: /^Stock$/ })
    .first()
    .click();
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: /add an item|add what you sell/i }).first().click();
  await p.waitForTimeout(4000);

  await p.getByLabel(/What is it called/i).fill(NAME);
  await p.waitForTimeout(500);

  // A maker, because a container that comes back needs somewhere to come back to.
  await p.getByRole('button', { name: /Add a group|group/i }).first().click();
  await p.waitForTimeout(2500);
  await p.getByText('Nigerian Breweries (NBL)', { exact: true }).first().click();
  await p.waitForTimeout(1500);
  // Groups are multi-select — a product can carry more than one maker — so the sheet stays open
  // after a pick and is closed deliberately. There is no Done button by design; the X is the way out.
  await p.getByRole('button', { name: /close/i }).first().click();
  await p.waitForTimeout(2000);

  // ── Crate and bottle, twelve to the crate ──────────────────────────────────────────
  await addShape(CRATE);
  await addShape(BOTTLE);
  await p.waitForTimeout(800);

  const bottleParent = card(BOTTLE).locator('input[type="checkbox"]').nth(4);
  await bottleParent.check();
  await p.waitForTimeout(700);
  await card(BOTTLE)
    .getByLabel(new RegExp(`How many ${BOTTLE}s`, 'i'))
    .first()
    .fill('12');
  await card(BOTTLE).locator('select').selectOption({ label: CRATE.toLowerCase() });
  await p.waitForTimeout(1200);

  /*
   * BOTH COUNTED, BOTH COME BACK — the Goldberg case exactly.
   *
   * The shop counts crates on the shelf AND loose bottles, and both the crate and the bottle come
   * back empty. Four boxes, and the form has to ask all four.
   */
  for (const which of [CRATE, BOTTLE]) {
    await role(which, /count the shelf in this/i);
    await role(which, /comes back empty/i);
  }
  await p.waitForTimeout(1000);
  await shot('shapes-ticked');

  // ── The section that replaced the two nameless boxes ───────────────────────────────
  const body = await p.locator('body').innerText();
  check(
    'the question about what customers still have is gone from this form',
    !/already out with customers/i.test(body),
  );
  check('and the shop is asked about its own yard instead', /Empties you are holding/i.test(body));

  const shelfBoxes = p
    .locator('[class*="ProductForm_shapeBoxes"]')
    .first()
    .locator('input');
  check('a shelf box per counted shape', (await shelfBoxes.count()) === 2, `${await shelfBoxes.count()} box(es)`);

  const emptyBoxes = p
    .locator('[class*="ProductForm_shapeBoxes"]')
    .nth(1)
    .locator('input');
  check('an empties box per shape that comes back', (await emptyBoxes.count()) === 2, `${await emptyBoxes.count()} box(es)`);

  /*
   * NINE CRATES AND FIVE LOOSE BOTTLES = 113 BOTTLES.
   *
   * The figure the whole change turns on. Multiplied by the shape's own `baseQty` — still the
   * placeholder 1, because the trigger has not run — it would be 14.
   */
  await shelfBoxes.nth(0).fill('9');
  await shelfBoxes.nth(1).fill('5');
  await p.waitForTimeout(800);
  await shot('shelf-said');

  check(
    'the arithmetic is said back before saving',
    /9 .*and 5|113|9 ocrate/i.test(await p.locator('body').innerText()),
    (await p.locator('[class*="ProductForm_saidBack"]').first().innerText().catch(() => '(none)')).slice(0, 70),
  );

  // Forty empty crates in the yard, and no loose empty bottles at all — zero is an answer.
  await emptyBoxes.nth(0).fill('40');
  await emptyBoxes.nth(1).fill('0');
  await p.waitForTimeout(600);
  await shot('empties-said');

  // "Add it" — matched exactly. `getByRole` matches SUBSTRINGS, and /Add/ also finds "Add a shape"
  // and "Add a group", either of which reopens a sheet and looks exactly like a save that hung.
  await p.getByRole('button', { name: 'Add it', exact: true }).first().click();
  await p.waitForTimeout(9000);
  await shot('after-save');

  // ── What actually landed ───────────────────────────────────────────────────────────
  console.log('\n— what reached the database —');
  const { data: made } = await admin
    .from('products')
    .select('id')
    .eq('store_id', storeId)
    .eq('name', NAME)
    .maybeSingle();
  check('the item saved', Boolean(made), made ? made.id : 'not found');
  if (!made) throw new Error('nothing to check against');
  productId = made.id;

  const { data: shapes } = await shop.rpc('product_units_for', { p_product_id: productId });
  const baseOf = Object.fromEntries(
    (shapes ?? []).map((r) => [r.name, Number(r.base_qty)]),
  );
  check('the crate is twelve bottles', baseOf[CRATE] === 12, `crate base_qty ${baseOf[CRATE]}`);

  const { data: movements } = await admin
    .from('stock_movements')
    .select('qty_delta')
    .eq('product_id', productId);
  const opened = (movements ?? []).reduce((a, m) => a + Number(m.qty_delta), 0);
  check(
    'nine crates and five bottles opened as 113, not 14',
    opened === 113,
    `${opened} on the shelf`,
  );

  const { data: yard } = await shop.rpc('store_empties_on_hand', { p_store_id: storeId });
  const mine = (yard ?? []).filter((r) => /ocrate|obottle/i.test(r.category_name));
  const crateYard = mine.find((r) => new RegExp(CRATE, 'i').test(r.category_name));
  const bottleYard = mine.find((r) => new RegExp(BOTTLE, 'i').test(r.category_name));
  check('forty empty crates are recorded in the yard', Number(crateYard?.qty) === 40, `${crateYard?.qty}`);
  check(
    'and nought empty bottles is recorded, not left blank',
    bottleYard !== undefined && Number(bottleYard.qty) === 0,
    bottleYard ? `${bottleYard.qty}` : 'no row',
  );

  console.log('\n— page errors —');
  check('no uncaught error', errors.length === 0, errors.join(' / '));
} catch (e) {
  console.log(`\n  FAIL  the walk did not finish — ${String(e).split('\n')[0]}`);
  await shot('where-it-stopped');
  failed += 1;
} finally {
  await browser.close();

  /*
   * CLEANING UP WHAT CAN BE CLEANED.
   *
   * `stock_movements` is append-only and refuses deletes, so an item that received stock cannot be
   * removed — it is retired instead, and what is still there is READ and said, rather than claimed.
   */
  if (productId) {
    await admin.from('products').update({ status: 'archived' }).eq('id', productId);
    await admin.from('product_returnables').delete().eq('product_id', productId);
  }
  /*
   * A unit the item still points at cannot be deleted, so it is RETIRED — which is what 0099 and
   * 0100 exist for: `store_units_for` stops offering a retired unit, so it leaves the shop's picker
   * without breaking the rows that reference it. A probe that only tries DELETE leaves its words in
   * the real shop's picker and reports success.
   */
  for (const id of madeUnits) {
    const { error } = await admin.from('store_units').delete().eq('id', id);
    if (error) await admin.from('store_units').update({ status: 'archived' }).eq('id', id);
  }

  const { data: leftUnits } = await admin
    .from('store_units')
    .select('name,status')
    .in('id', madeUnits);
  const stillOffered = (leftUnits ?? []).filter((u) => u.status !== 'archived');
  console.log(
    `\nleft behind: ${productId ? '1 retired item' : 'nothing'}` +
      `, ${(leftUnits ?? []).length} unit(s) kept, ${stillOffered.length} still offered`,
  );
  console.log(`${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}
