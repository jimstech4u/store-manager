/**
 * One list of shapes, and four things a shape can be for.
 *
 * «bought in and sold in are now SELECTING from the shape, not defining it again»
 *
 * The editor had two lists with two Add buttons, and a note under the second explaining that
 * anything you also sell is "already above" — an explanation the design needed because the design
 * was wrong. The claims now:
 *
 *   · one list, one Add button, every shape on the item in it;
 *   · four roles per shape — arrives in, customers buy, counted in, deposits held in;
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
const storeId = (await admin.from('stores').select('id').limit(1).single()).data.id;

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

  // ══ Four roles ════════════════════════════════════════════════════════════════════
  console.log('\n— four things a shape can be for —');
  for (const role of [
    'It arrives in this',
    'Customers buy this',
    'You count the shelf in this',
    'Deposits are held in this',
  ]) {
    check(`"${role}" is offered`, (await p.getByText(role, { exact: true }).count()) > 0);
  }

  // ══ Changing one saves, and the tree survives ═════════════════════════════════════
  console.log('\n— ticking a role saves, and a crate still knows it is twelve —');
  const bottleCounted = p.getByText('You count the shelf in this', { exact: true }).nth(1);
  await bottleCounted.scrollIntoViewIfNeeded();
  await bottleCounted.click();
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
  check(
    'the role that was ticked was saved',
    bottleAfter?.is_counted === true,
    `bottle counted: ${bottleAfter?.is_counted}`,
  );
  check(
    'and the roles that were not ticked are untouched',
    after.every((u) => {
      const b = before.find((x) => x.name === u.name);
      return b && b.is_bought === u.is_bought && b.is_sold === u.is_sold;
    }),
    after.map((u) => `${u.name}:b=${u.is_bought},s=${u.is_sold}`).join(' '),
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
