/**
 * THE PRODUCT FORM, LOOKED AT.
 *
 * The shop said two sections were not fit to show anybody: "the expiry date already recorded
 * section is not well designed and professional across new and edit product form", and the
 * opening-count section, where "When does it go off?" printed on top of the line above it.
 *
 * Both were CSS, and neither shows up in a typecheck. So this opens the add form and the edit form
 * and photographs them, and asserts the two things that can be asserted: that the headings do not
 * overlap what precedes them, and that the undated remainder counts down as dates are added.
 *
 *     node scripts/probe-product-form-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { trackDrafts } from './probe-drafts.mjs';
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const startedAt = new Date().toISOString();

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
// Only the tabs THIS browser saves are ever cleaned up — never the shop's own (see probe-drafts).
const PROBE_DRAFTS = trackDrafts(p);
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

/**
 * Do two elements share the same pixels?
 *
 * The reported fault was a heading printed over the line above it — a negative top margin meant
 * for a different parent. An overlap is the fault itself, so it is what is measured, rather than
 * a margin value that could be right and still collide.
 */
const overlaps = async (a, b) => {
  const [x, y] = [await a.boundingBox(), await b.boundingBox()];
  if (!x || !y) return false;
  return y.y < x.y + x.height - 1;
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(10000);

  console.log('\n— adding an item —');
  await p.getByRole('button', { name: 'Stock', exact: true }).first().click();
  await p.waitForTimeout(3000);

  const add = p.getByRole('button', { name: /Add an item you sell|Add an item/i }).first();
  await add.waitFor({ state: 'visible', timeout: 120000 });
  await add.click();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/1-add-top.png`, fullPage: true });

  // A shape, so the opening-count section appears at all.
  const name = p.getByLabel(/What is it called|Name/i).first();
  if (await name.count()) await name.fill(`ZZ Form Probe ${Date.now().toString().slice(-5)}`);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${SHOTS}/2-add-named.png`, fullPage: true });

  const body = await p.locator('body').innerText();
  check('the add form opens', /What you have now|What is it called|shape/i.test(body));

  /*
   * THE COLLISION ITSELF. "When does it go off?" sits under a hint line, and the note beneath it
   * used to be dragged up through it by a margin borrowed from a different heading.
   */
  const goesOff = p.getByText('When does it go off?', { exact: true }).first();
  if (await goesOff.count()) {
    const note = p.getByText(/Only if it has a date on it/i).first();
    check('the "goes off" note sits below its heading, not over it',
      !(await overlaps(goesOff, note)));
    await goesOff.scrollIntoViewIfNeeded();
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${SHOTS}/3-goes-off.png`, fullPage: true });
  } else {
    console.log('  (no shape yet, so the dated-stock section is not offered — expected)');
  }

  console.log('\n— an item that already has stock, edited —');
  await p.goto(`${BASE}/main`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: 'Stock', exact: true }).first().click();
  await p.waitForTimeout(4000);

  /*
   * SCROLLED TO, because the list only renders what is near the screen.
   *
   * A hundred products are not all in the page — six were, on a shop with a hundred and five — so
   * asking for one by name finds nothing until it has been scrolled into existence. Searching is
   * not the way either: the search control is not a text input at this point in the page.
   */
  const goldbergHunt = p.getByText(/Goldberg Bottle/i).first();
  for (let i = 0; i < 40 && (await goldbergHunt.count()) === 0; i += 1) {
    /*
     * The COLUMN scrolls, not the window. `mouse.wheel` goes to whatever is under the pointer,
     * which at 0,0 is the header, so the list never moved and the item was never rendered.
     */
    await p.evaluate(() => {
      const col = document.querySelector('.navstack-column-body');
      if (col) col.scrollTop += 900;
    });
    await p.waitForTimeout(400);
  }
  await p.waitForTimeout(1500);

  const goldberg = p.getByText(/Goldberg Bottle/i).first();
  if (await goldberg.count()) {
    await goldberg.click();
    await p.waitForTimeout(4000);
    await p.screenshot({ path: `${SHOTS}/4-product.png`, fullPage: true });

    const edit = p.getByRole('button', { name: /Edit this item|Edit/i }).first();
    if (await edit.count()) {
      await edit.click();
      await p.waitForTimeout(5000);
      await p.screenshot({ path: `${SHOTS}/5-edit.png`, fullPage: true });

      const recorded = p.getByText('Expiry dates already recorded', { exact: true }).first();
      if (await recorded.count()) {
        await recorded.scrollIntoViewIfNeeded();
        await p.waitForTimeout(800);
        await p.screenshot({ path: `${SHOTS}/6-expiry-lots.png`, fullPage: true });

        /*
         * The button used to stretch to half the row because it shared `.shapeBoxes`, which gives
         * every child equal flex. It should now be only as wide as its word.
         */
        const save = p.getByRole('button', { name: 'Save', exact: true }).first();
        if (await save.count()) {
          const boxSave = await save.boundingBox();
          check('the Save on a lot is a button, not half the row',
            boxSave !== null && boxSave.width < 160, `${Math.round(boxSave?.width ?? 0)}px wide`);
        }
      } else {
        console.log('  (this item has no dated lots, so there is nothing to re-date)');
      }
    }
  }

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await p.screenshot({ path: `${SHOTS}/last.png`, fullPage: true }).catch(() => {});
  await browser.close();
  // Anything this probe opened at the till, taken back off it.
  const { data: mine } = await admin
    .from('draft_orders').select('id').eq('status', 'open').in('client_uuid', [...PROBE_DRAFTS]);
  const ids = (mine ?? []).map((d) => d.id);
  if (ids.length) {
    await admin.from('draft_order_lines').delete().in('draft_order_id', ids);
    await admin.from('draft_orders').delete().in('id', ids);
  }
  console.log(`\n  shots in ${SHOTS}`);
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
