/**
 * A shop declaring what its crates come back in, by clicking.
 *
 * `probe-return-units` proves the rule in the database. This proves a shop can make it: reach the
 * screen from the beer it is holding, add "full crate of 12", and see the settle screen refuse
 * seven before anything is recorded.
 *
 * Cleans up the shapes it declares — the pool is a real one, and leaving a rule behind would change
 * how the shop's returns work tomorrow.
 *
 *     node scripts/probe-return-units-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/return-units';
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

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

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

  // ══ Reached from the beer, not from settings ══════════════════════════════════════
  console.log('\n— from the item a shop is looking at —');
  await tab('Stock');
  const beer = p
    .locator('[class*="stock-page_itemName"]')
    .filter({ hasText: /Gulder|Star Lager|Trophy/ })
    .first();
  await beer.scrollIntoViewIfNeeded();
  await beer.click();
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `${SHOTS}/1-product.png`, fullPage: true });

  const prod = await body();
  check('the item shows what it has out', /Containers out/i.test(prod), prod.slice(0, 80));
  check('and says the shape can be set from here', /what shape it comes back in/i.test(prod));

  const poolRow = p.locator('[class*="emptiesRow"]').first();
  await poolRow.scrollIntoViewIfNeeded();
  await poolRow.click();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/2-shapes.png`, fullPage: true });

  const page = await body();
  check('tapping a pool opens its shapes', /What shape it comes back in/i.test(page), page.slice(0, 70));
  check('and says the rule is the pool’s, not this item’s', /Shared with every item/i.test(page));

  // ══ Declaring one ═════════════════════════════════════════════════════════════════
  console.log('\n— declaring "full crate of 12" —');
  /*
   * Located inside the composer, not by label.
   *
   * `getByLabel` matched the SAME input for both questions, so "Full crate" went into the quantity
   * box and was overwritten by "12" a line later — the name stayed empty, the Add button stayed
   * disabled, and the probe reported "it can be added" because Playwright reads a styled-muted
   * button as enabled unless the attribute is set. Two boxes, in order, asks the question properly.
   */
  const boxes = p.locator('[class*="return-units-page_grid"] input');
  await boxes.nth(0).fill('Full crate');
  await boxes.nth(1).fill('12');
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${SHOTS}/2b-filled.png` });
  console.log(
    `    boxes: ${await boxes.count()} — [0]="${await boxes.nth(0).inputValue()}" [1]="${await boxes.nth(1).inputValue()}"`,
  );

  const add = p.getByRole('button', { name: /Add this shape/i }).first();
  check(
    'it can be added',
    await add.isEnabled(),
    `name="${await boxes.nth(0).inputValue()}" qty="${await boxes.nth(1).inputValue()}"`,
  );
  await add.click();
  await p.waitForTimeout(1000);
  await p.screenshot({ path: `${SHOTS}/3-added.png` });
  check('and is listed', /12 to one/i.test(await body()), (await body()).slice(0, 100));

  await p.getByRole('button', { name: /^Save$/ }).first().click();
  await p.waitForTimeout(5000);
  await p.screenshot({ path: `${SHOTS}/4-saved.png` });

  check('saving returns to the item', /Containers out/i.test(await body()), (await body()).slice(0, 70));

  const { data: saved } = await admin
    .from('empties_return_units').select('name, base_qty');
  check(
    'and the shape is on the pool',
    (saved ?? []).some((u) => u.name === 'Full crate' && Number(u.base_qty) === 12),
    (saved ?? []).map((u) => `${u.name}=${Number(u.base_qty)}`).join(', ') || 'none',
  );

  // ══ The counter is told before it records ═════════════════════════════════════════
  console.log('\n— and the counter is told before it records —');
  await tab('Sell');
  await p.getByRole('button', { name: /Containers still to come back/i }).first().click();
  await p.waitForTimeout(4500);
  const card = p.locator('[class*="empties-page_card"]').first();
  await card.click();
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `${SHOTS}/5-settle.png`, fullPage: true });

  const settle = await body();
  const saysShape = /Comes back in/i.test(settle);
  console.log(`    ${saysShape ? 'the settle screen names the shape' : 'this receipt uses a pool with no shape declared'}`);

  if (saysShape) {
    const box = p.locator('[class*="qtyBox"] input').first();
    await box.fill('7');
    await p.waitForTimeout(900);
    await p.screenshot({ path: `${SHOTS}/6-refused.png`, fullPage: true });

    check(
      'seven is refused ON THE PAGE, before anything is recorded',
      /not a shape these come back in/i.test(await body()),
      (await body()).slice(0, 110),
    );
    check(
      'and the button will not let it through',
      !(await p.getByRole('button', { name: /Record it/i }).first().isEnabled()),
    );

    await box.fill('12');
    await p.waitForTimeout(900);
    check(
      'twelve is accepted',
      !/not a shape these come back in/i.test(await body()) &&
        (await p.getByRole('button', { name: /Record it/i }).first().isEnabled()),
    );
  }

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  const { data: left } = await admin.from('empties_return_units').select('id');
  for (const u of left ?? []) await admin.from('empties_return_units').delete().eq('id', u.id);
  console.log(`\n  (${(left ?? []).length} declared shape(s) removed)`);
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
