/**
 * AFTER STOCK HISTORY THE SHELF FIGURE LOCKS — AND ITS DATES ARE SET AS LINES, LIKE BEFORE IT.
 *
 * "Expiry date should still be editable in the edit product form; only the initial qty cannot be
 * after stock history exists ... I thought editing American Cola's expiry would be like the
 * multi-line edit we have on 33 Bottle, which has no history."
 *
 * American Cola PET has sold and carries a dated lot. Its edit form keeps the shelf boxes read-only;
 * its dated lot loads into the same editable lines 33 Bottle has; a line can be removed and new ones
 * added; Save sends `set_shelf_dates` with exactly the lines — no stock move, no reason asked. Every
 * writer is answered by the probe, so nothing in the shop changes.
 *
 *     node scripts/probe-expiry-after-history-ui.mjs [http://localhost:3100]
 */

import { chromium, webkit } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad';
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

const browser = await (process.env.ENGINE === 'webkit' ? webkit : chromium).launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const PROBE_DRAFTS = trackDrafts(p);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Nothing here may change the shop: every writer this form can call is answered by the probe.
const sent = [];
for (const fn of ['set_shelf_dates', 'set_stock_layer_expiry', 'date_shelf_stock', 'set_opening_stock',
                  'enter_stock_count', 'update_product', 'save_product_units', 'set_product_groups',
                  'save_product_discounts', 'set_product_low_stock', 'set_product_returnable', 'count_empties_on_hand']) {
  await p.route(`**/rest/v1/rpc/${fn}*`, async (route) => {
    sent.push({ fn, body: JSON.parse(route.request().postData() ?? '{}') });
    await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
}

const activeText = () =>
  p.evaluate(() => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    const pages = [...(active?.querySelectorAll('.navstack-page') ?? [])];
    return pages[pages.length - 1]?.textContent ?? '';
  });

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(8000);

  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /Search your stock/ }).locator('visible=true').first().click();
  await p.waitForTimeout(1500);
  await p.keyboard.type('American Cola');
  await p.waitForTimeout(3500);
  await p.locator('.react-modal-sheet-container').getByText(/American Cola PET/).locator('visible=true').first().click();
  await p.waitForTimeout(4000);
  await p.locator('button[aria-label="Edit this item"]').locator('visible=true').first().click();
  await p.waitForTimeout(7000);

  const boxes = await p.evaluate(() =>
    [...document.querySelectorAll('.group-stack-container[data-active="true"] [class*="shapeBox"] input')].map((i) => i.readOnly),
  );
  check('the shelf boxes are read-only (it has sold)', boxes.length > 0 && boxes.every(Boolean), JSON.stringify(boxes));

  await p.getByText('When does it go off?').first().scrollIntoViewIfNeeded().catch(() => {});
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${SHOTS}/dates-after-history.png` });
  const removers = p.getByRole('button', { name: 'Remove this date' });
  check('its dated lot is one of the editable lines', (await removers.count()) === 1, `${await removers.count()} line(s)`);
  check('no per-lot "Save this date" boxes', (await p.getByRole('button', { name: 'Save this date' }).count()) === 0);
  check('no reason asked', !/Why is this date being corrected/.test(await activeText()));

  // The whole shelf is dated: nothing is left to date, so there is nothing to add.
  let t = await activeText();
  check('with the whole shelf dated, there is no box to add a line', (await p.getByRole('button', { name: /Add this date/ }).count()) === 0);
  check('… and it says every one is dated', /Every one is dated/.test(t));
  check('the line is said in shapes, not pieces', /1065 packs 7 pieces/.test(t) && !/12,?787 pieces/.test(t));

  // Take the line off and put two new ones on: 50 packs to Jan, 100 packs to June.
  await removers.first().click();
  await p.waitForTimeout(500);
  t = await activeText();
  check('with it off, the box says how much is left to date', /Up to 1065 packs 7 pieces still to date/.test(t));
  const qty = p.locator('.group-stack-container[data-active="true"]').getByText('How many', { exact: true }).first().locator('xpath=following::input[1]');
  await qty.fill('2000');
  await p.locator('.group-stack-container[data-active="true"] input[type="date"]').last().fill('2027-01-10');
  await p.waitForTimeout(400);
  check('more than is left is refused', /Only 1065 packs 7 pieces is left to date/.test(await activeText()));
  check('… and "Add this date" stays off', await p.getByRole('button', { name: /Add this date/ }).first().isDisabled());
  await qty.fill('');
  const addLine = async (packs, date) => {
    // Packs is the shape the line starts in (the item's largest).
    await p.locator('.group-stack-container[data-active="true"]').getByText('How many', { exact: true }).first().locator('xpath=following::input[1]').fill(String(packs));
    await p.locator('.group-stack-container[data-active="true"] input[type="date"]').last().fill(date);
    await p.getByRole('button', { name: /Add this date/ }).first().click();
    await p.waitForTimeout(500);
  };
  await addLine(50, '2027-01-10');
  await addLine(100, '2027-06-30');
  check('two new lines are on', (await p.getByRole('button', { name: 'Remove this date' }).count()) === 2);
  await p.screenshot({ path: `${SHOTS}/dates-after-history-edited.png` });

  await Promise.all([
    p.waitForRequest(/rpc\/set_shelf_dates/, { timeout: 30000 }).catch(() => null),
    p.getByRole('button', { name: /Save changes/ }).locator('visible=true').last().click(),
  ]);
  await p.waitForTimeout(2000);
  const dates = sent.find((s) => s.fn === 'set_shelf_dates');
  const lines = (dates?.body?.p_batches ?? []).map((b) => `${b.qty}@${b.expires_on}`).sort();
  check('saving sends set_shelf_dates with exactly the lines', JSON.stringify(lines) === JSON.stringify(['1200@2027-06-30', '600@2027-01-10'].sort()), JSON.stringify(dates?.body));
  check('… and moves no stock', !sent.some((s) => ['set_opening_stock', 'enter_stock_count', 'date_shelf_stock'].includes(s.fn)), sent.map((s) => s.fn).join(', '));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/dates-crash.png` }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
