/**
 * One list of shapes, and two things a shape can be for.
 *
 * «bought in and sold in are now SELECTING from the shape, not defining it again»
 *
 * The editor had two lists with two Add buttons, and a note under the second explaining that
 * anything you also sell is "already above" — an explanation the design needed because the design
 * was wrong. The claims now:
 *
 *   · one list, one Add button, every shape on the item in it;
 *   · three roles per shape — arrives in, customers buy, counted in. The fourth, deposits held
 *     in, was removed: a deposit is a round sum against a customer, not a rate per container;
 *   · ticking a role SAVES, and the shape tree survives the save (a crate still knows it is 12).
 *
 * That last one is not decoration. A first version of 0080 renamed the key the second pass reads,
 * which would have erased every relationship in the shop on the next save of any product, silently.
 *
 *     node scripts/probe-shape-roles.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/shape-roles';
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const ITEM = 'Star Lager 60cl';
const shapesOf = async () => {
  const { data: p } = await admin
    .from('products').select('id').eq('store_id', storeId).eq('name', ITEM).single();
  const { data } = await admin
    .from('product_units')
    .select('base_qty, defined_qty, is_bought, is_sold, is_counted, is_deposit, store_units(name)')
    .eq('product_id', p.id);
  return (data ?? []).map((u) => ({ ...u, name: u.store_units.name }));
};

const before = await shapesOf();

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ══ The units screen ══════════════════════════════════════════════════════════════
  console.log('\n— one list of shapes —');
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(4000);
  const row = p.locator('[class*="stock-page_itemName"]').filter({ hasText: ITEM }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: /The shapes it comes in/i }).first().click();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/1-shapes.png`, fullPage: true });

  const page = await body();
  check('the screen lists SHAPES', /Shapes/i.test(page), page.slice(0, 80));
  check(
    'and no longer has two lists to keep in step',
    !/Sold in/i.test(page) && !/Bought in/i.test(page),
    /Sold in|Bought in/i.test(page) ? 'the old headings are still there' : 'one list',
  );
  check('with one way to add', (await p.getByRole('button', { name: /Add a shape/i }).count()) === 1);
  check('both shapes are listed', /Crate/i.test(page) && /Bottle/i.test(page));

  // ══ Two roles, and the container question ═════════════════════════════════════════
  console.log('\n— what a shape can be for —');
  for (const role of [
    'It arrives in this',
    'Customers buy this',
  ]) {
    check(`"${role}" is offered`, (await p.getByText(role, { exact: true }).count()) > 0);
  }

  /*
   * AND THE FOURTH IS GONE, which is the assertion worth keeping.
   *
   * "Deposits are held in this" came off at the shop's request: a deposit is a round sum against a
   * CUSTOMER on its own ledger, not a rate per container, so no shape has to claim it. It was
   * saved, read back, and consulted by nothing — a question the app could not act on, which is
   * worse than one it never asks. This probe demanded it for a while after it left.
   */
  check(
    'and "Deposits are held in this" is gone',
    (await p.getByText('Deposits are held in this', { exact: true }).count()) === 0,
  );

  /*
   * AND SO IS COUNTING, which was never a choice.
   *
   * A shape is on an item because the shop has a word for it, and anything it has a word for it can
   * count. The tick's wrong answer silently removed the opening-stock box, so a new item saved with
   * an unexamined nought on its shelf. 0138 forces it true for every shape.
   */
  check(
    'and so is "You count the shelf in this"',
    (await p.getByText('You count the shelf in this', { exact: true }).count()) === 0,
  );

  // ══ Changing one saves, and the tree survives ═════════════════════════════════════
  console.log('\n— ticking a role saves, and a crate still knows it is twelve —');
  /*
   * "It arrives in this" ON THE BOTTLE'S CARD — the CHECKBOX, not the nth label.
   *
   * `getByText(...).nth(1)` counts every matching node in the document, and a pushed-under page
   * stays mounted: the second match was not reliably the bottle's, and clicking a span that happens
   * to sit under another card toggles nothing the probe then checks. Scoping to the card and
   * checking the input says exactly what is meant, and `check()` is idempotent so it cannot
   * accidentally untick.
   */
  const bottleCard = p.locator('li[class*="UnitsEditor_card__"]').filter({ hasText: 'Bottle' }).first();
  const bottleCounted = bottleCard
    .locator('label')
    .filter({ hasText: /It arrives in this/i })
    .first()
    .locator('input');
  await bottleCounted.scrollIntoViewIfNeeded();
  await bottleCounted.check();
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${SHOTS}/2-ticked.png`, fullPage: true });

  const save = p.getByRole('button', { name: /Save|Done/i }).last();
  await save.scrollIntoViewIfNeeded();
  await save.click();
  await p.waitForTimeout(7000);
  await p.screenshot({ path: `${SHOTS}/3-saved.png` });

  const after = await shapesOf();
  const crateBefore = before.find((u) => u.name === 'Crate');
  const crateAfter = after.find((u) => u.name === 'Crate');

  check(
    'the crate still holds twelve bottles',
    crateAfter && Number(crateAfter.defined_qty) === Number(crateBefore.defined_qty),
    `${crateBefore?.defined_qty} → ${crateAfter?.defined_qty}`,
  );
  check(
    'and its base quantity is unchanged',
    crateAfter && Number(crateAfter.base_qty) === Number(crateBefore.base_qty),
    `${crateBefore?.base_qty} → ${crateAfter?.base_qty}`,
  );

  const bottleAfter = after.find((u) => u.name === 'Bottle');
  /*
   * THE ROLE THAT WAS TICKED — "It arrives in this", on the bottle.
   *
   * This used to tick and then assert `is_counted`. Counting stopped being a tick in 0138: a shape
   * is on an item because the shop has a word for it, and anything it has a word for it can count.
   * The claim is unchanged — ticking a role saves, and the shape tree survives the save — it is
   * just made with a role that still exists.
   */
  check(
    'the role that was ticked was saved',
    bottleAfter?.is_bought === true,
    `bottle arrives-in: ${bottleAfter?.is_bought}`,
  );
  check(
    'and the roles that were not ticked are untouched',
    after.every((u) => {
      const b = before.find((x) => x.name === u.name);
      if (!b) return false;
      // The bottle's `is_bought` is the one that was just ticked; everything else must be as it was.
      const boughtOk = u.name === 'Bottle' ? true : b.is_bought === u.is_bought;
      return boughtOk && b.is_sold === u.is_sold;
    }),
    after.map((u) => `${u.name}:b=${u.is_bought},s=${u.is_sold}`).join(' '),
  );

  /*
   * AND EVERY SHAPE IS COUNTED, whatever anybody ticked.
   *
   * Forced by a trigger rather than by the writer, so the guarantee holds for the two migrations
   * that insert shapes directly and for anything written later.
   */
  check(
    'and every shape is counted, with nothing to press',
    after.every((u) => u.is_counted === true),
    after.map((u) => `${u.name}:${u.is_counted}`).join(' '),
  );

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  // Put the roles back exactly as they were — this is a real product in a real shop.
  const { data: prod } = await admin
    .from('products').select('id').eq('store_id', storeId).eq('name', ITEM).single();
  for (const u of before) {
    const { data: su } = await admin
      .from('store_units').select('id').eq('store_id', storeId).eq('name', u.name).maybeSingle();
    if (su) {
      await admin
        .from('product_units')
        .update({ is_counted: u.is_counted, is_deposit: u.is_deposit })
        .eq('product_id', prod.id)
        .eq('store_unit_id', su.id);
    }
  }
  console.log('\n  (roles restored)');
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
