/**
 * Adding an item the way a real shop's stock actually works.
 *
 * The form asked "How do you count it?" and "What is a pack?" — the one-pack-per-product model,
 * which nothing in this trade fits. It now asks what the item IS and then what it is bought in,
 * sold in, and what a customer pays for buying more.
 *
 * The case driven here is the one from the brief: a crate of twelve, sold by the crate AND by the
 * bottle, with a cheaper price at five crates or more.
 *
 *     node scripts/probe-product-form.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/product-form';
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const stamp = Date.now().toString().slice(-6);
const NAME = `ZZ Form Probe ${stamp}`;
/*
 * THE SHOP THE BROWSER WILL SIGN INTO, asked of the membership.
 *
 * `stores.limit(1)` is whichever row the database hands back first, which stopped being the sample
 * account's shop the day a second shop existed. Rows were created somewhere the browser could not
 * see them, and the failure looked like a broken picker.
 */
const probeShop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await probeShop.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
const storeId = (await probeShop.rpc('my_membership')).data[0].store_id;

// Two units this shop keeps, so the picker has something to offer.
const crate = (
  await admin
    .from('store_units')
    .insert({ store_id: storeId, name: `FCrate${stamp}`, plural: `FCrates${stamp}` })
    .select('id')
    .single()
).data.id;
const bottle = (
  await admin
    .from('store_units')
    .insert({ store_id: storeId, name: `FBottle${stamp}`, plural: `FBottles${stamp}` })
    .select('id')
    .single()
).data.id;

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const tab = async (label) => {
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(1000);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(4500);
};

/** Picks a unit out of the sheet the plus button opens. */
const addUnit = async (which, unitName) => {
  await p.getByRole('button', { name: which }).first().click();
  await p.waitForTimeout(2500);
  await p.locator('[class*="UnitPicker_row"]').filter({ hasText: unitName }).first().click();
  await p.waitForTimeout(2000);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  await tab('Stock');
  await p.getByRole('button', { name: /add an item|add what you sell/i }).first().click();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/1-empty-form.png` });

  console.log('\n— the old one-pack questions are gone —');
  const body = await p.locator('body').innerText();
  check('no "How do you count it?"', !/How do you count it/i.test(body));
  check('no "Pack name"', !/Pack name/i.test(body));
  // The section is shapes-first now: define the shape once, then tick what it is for. The old
  // heading described two lists that no longer exist.
  check('it asks about the shapes it comes in instead', /The shapes it comes in/i.test(body));
  check('and about buying more', /Cheaper for buying more/i.test(body));

  console.log('\n— what it is —');
  await p.getByLabel(/What is it called/i).fill(NAME);
  await p.waitForTimeout(500);

  console.log('\n— sold by the crate and by the bottle —');
  await addUnit(/Add a shape/i, `FCrate${stamp}`);
  await addUnit(/Add a shape/i, `FBottle${stamp}`);

  // Matched on the exact class: `[class*="UnitsEditor_card"]` also finds cardHead and cardName,
  // so two units counted as six.
  const cards = await p.locator('li[class*="UnitsEditor_card__"]').count();
  check('both units are on the item', cards === 2, `${cards} card(s)`);

  /*
   * ONE CRATE HOLDS TWELVE BOTTLES, said in that direction from the start.
   *
   * This used to press "Wrong way round" — a swap button from when a shape declared what it was
   * MADE OF, so adding the crate first made it the ruler and the bottle's card asked "one bottle is
   * [ ] crates", whose honest answer is a twelfth. A shape declares what it GOES INSIDE now, so the
   * sentence reads "[12] bottles fit inside one [crate]" and there is nothing to turn round.
   *
   * The swap button has been gone since f241257; this probe had been asserting on it since.
   */
  const bottleCard = p.locator('li[class*="UnitsEditor_card__"]').nth(1);

  /*
   * TICK, THEN PICK THE CONTAINER, THEN SAY HOW MANY — in that order.
   *
   * Ticking adds an EMPTY row: which shape a bottle goes inside is the question, and choosing one
   * for the shop would be a guess written into the tree. The "How many" field only exists once a
   * container has been chosen, so filling it first fills nothing.
   */
  await bottleCard.getByText(/go inside something bigger/i).first().click();
  await p.waitForTimeout(1000);

  const parent = bottleCard.locator('select').first();
  await parent.waitFor({ timeout: 15000 });
  const options = await parent.locator('option').count();
  check('the bottle is offered a container to go inside', options > 1, `${options} option(s)`);
  await parent.selectOption({ index: options - 1 });
  await p.waitForTimeout(1000);

  const howMany = bottleCard.getByLabel(/^How many /i).first();
  await howMany.fill('12');
  await p.waitForTimeout(600);

  const sentence = (await bottleCard.innerText()).replace(/\s+/g, ' ');
  /*
   * THE QUANTITY IS READ OFF THE INPUT, never off the text.
   *
   * `innerText` does not contain an input's VALUE. Asserting `/12/` against it could not pass
   * whatever the form did — the same mistake as the probe that once checked a form field through
   * `innerText` and reported data loss that had already been fixed.
   */
  const said = await howMany.inputValue();
  check(
    'the sentence can be said the way a shop says it',
    said.trim() === '12' && /fit inside one/i.test(sentence),
    `"${said}" ${(sentence.match(/How many .*?fit inside one \S+/i) ?? ['(no sentence)'])[0]}`,
  );

  /*
   * AND SAYING A CUSTOMER CAN BUY THEM, which is now a deliberate tick.
   *
   * A new shape starts COUNTED and nothing else — anything the shop has a word for it can count,
   * while whether customers may buy in it is a decision only the shop can make. The price field
   * belongs to a SOLD shape, so without this there is no price to fill and `unitProblems` refuses
   * the save with "Say what a customer can buy".
   */
  for (const card of await p.locator('li[class*="UnitsEditor_card__"]').all()) {
    const sells = card.getByText(/^Customers buy this$/i).first();
    if ((await sells.count()) > 0) {
      await sells.click();
      await p.waitForTimeout(500);
    }
  }
  await p.waitForTimeout(800);

  // A price on each: the crate at 9,600, the bottle at 900.
  // Scoped to the unit cards. The discount composer also carries a "Price for one X …" label, and
  // an anchored regex does not separate them because the accessible name includes the hint.
  const prices = await p
    .locator('li[class*="UnitsEditor_card__"]')
    .getByLabel(/Price for one/i)
    .all();
  check('each sold unit asks its own price', prices.length === 2, `${prices.length} price field(s)`);
  await prices[0].fill('9600');
  await prices[1].fill('900');
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${SHOTS}/2-units.png`, fullPage: true });

  console.log('\n— cheaper at five crates —');
  await p.getByLabel(/^From/i).first().fill('5');
  await p.getByLabel(/Price for one .* at that quantity/i).fill('9000');
  await p.waitForTimeout(500);
  await p.getByRole('button', { name: /Add this price/i }).click();
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${SHOTS}/3-discount.png`, fullPage: true });

  const withBand = await p.locator('body').innerText();
  check('the band reads as a sentence', /5 or more/i.test(withBand), 'expected "5 or more …"');

  console.log('\n— save it —');
  await p.getByRole('button', { name: /^Add it$/i }).click();
  await p.waitForTimeout(9000);
  await p.screenshot({ path: `${SHOTS}/4-saved.png` });

  // ── What the shop actually recorded ───────────────────────────────────────────────
  const { data: saved } = await admin
    .from('products')
    .select('id, name, base_unit')
    .eq('name', NAME)
    .maybeSingle();
  check('the item exists', Boolean(saved), saved ? saved.id : 'not found');

  if (saved) {
    const { data: units } = await admin
      .from('product_units')
      .select('store_unit_id, base_qty, is_sold, is_bought, sell_price')
      .eq('product_id', saved.id);

    check('it has two units', (units ?? []).length === 2, `${(units ?? []).length}`);

    const c = units?.find((u) => u.store_unit_id === crate);
    const bo = units?.find((u) => u.store_unit_id === bottle);
    check('a crate is twelve bottles', Number(c?.base_qty) === 12, `base_qty ${c?.base_qty}`);
    check('the crate sells at 9,600', Number(c?.sell_price) === 9600, `${c?.sell_price}`);
    check('the bottle sells at 900', Number(bo?.sell_price) === 900, `${bo?.sell_price}`);

    const { data: tiers } = await admin
      .from('product_price_tiers')
      .select('min_qty, max_qty, price')
      .eq('product_id', saved.id);
    check('the cheaper price was saved', (tiers ?? []).length === 1, `${(tiers ?? []).length} band(s)`);
    check(
      'from five, with no upper end, at 9,000',
      Number(tiers?.[0]?.min_qty) === 5 && tiers?.[0]?.max_qty === null && Number(tiers?.[0]?.price) === 9000,
      JSON.stringify(tiers?.[0]),
    );

    // The till reads a derived table; what the form saved has to reach it.
    /*
     * Read off the TABLE, not through the RPC.
     *
     * `product_sale_units_for` is membership-gated, and the service key has no auth.uid() — so it
     * answered "0 units" for a product that had two, and the probe reported a fault in the app
     * that was a fault in the probe.
     */
    const { data: forTill } = await admin
      .from('product_sale_units')
      .select('name, base_qty, price')
      .eq('product_id', saved.id);
    check('the till has both units', (forTill ?? []).length === 2, JSON.stringify(forTill));

    await admin.from('product_price_tiers').delete().eq('product_id', saved.id);
    await admin.from('product_units').delete().eq('product_id', saved.id);
    await admin.from('product_sale_units').delete().eq('product_id', saved.id);
    const gone = await admin.from('products').delete().eq('id', saved.id);
    if (gone.error) await admin.from('products').update({ status: 'archived' }).eq('id', saved.id);
  }

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await admin.from('store_units').delete().in('id', [crate, bottle]);
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
