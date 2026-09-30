/**
 * BEFORE STOCK HISTORY, THE EDIT FORM SETS THE OPENING; AFTER IT, THE SHELF CHANGES BY A COUNT.
 *
 * "In edit product form, when no history on the product, it is still the initial amount which we
 * can edit ... there is no need to be reason because it is not correction ... when we have stock
 * history, we cannot edit again."
 *
 *   A  Chivita Active Zest Can (opening only, set to 3 Cans in 0231): Stock and its page say 3 Cans.
 *   B  Its edit form: the boxes hold 3 Cans 0 pieces and can be changed, the note says it is still
 *      the opening, and there is no "why is this being corrected?". Changed to 2 Cans 12 pieces and
 *      saved, it sends `set_opening_stock` with 60 pieces — intercepted here, so the shop's stock is
 *      not touched (the function itself was proven on the database in a rolled-back run).
 *   C  Goldberg Bottle (it has sold): the boxes are read-only and say it changes by a count.
 *
 *     node scripts/probe-opening-before-history-ui.mjs [http://localhost:3100]
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

// Nothing here may change the shop's stock: every stock writer is answered by the probe.
const sent = [];
for (const fn of ['set_opening_stock', 'open_stock_by_count', 'enter_stock_count', 'ensure_open_period', 'date_shelf_stock', 'resolve_variance', 'close_stock_period']) {
  await p.route(`**/rest/v1/rpc/${fn}*`, async (route) => {
    sent.push({ fn, body: JSON.parse(route.request().postData() ?? '{}') });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fn === 'set_opening_stock' ? { opening: 60 } : null) });
  });
}

const activeText = () =>
  p.evaluate(() => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    const pages = [...(active?.querySelectorAll('.navstack-page') ?? [])];
    return (pages[pages.length - 1] ?? active)?.textContent ?? '';
  });
const tab = async (label) => {
  await p.evaluate(() => { for (const b of document.querySelectorAll('.navstack-column-body')) b.scrollTop = 0; });
  await p.waitForTimeout(800);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(2500);
};
const openItem = async (search, name) => {
  await tab('Stock');
  await p.getByRole('button', { name: /Search your stock/ }).locator('visible=true').first().click();
  await p.waitForTimeout(1500);
  await p.keyboard.type(search);
  await p.waitForTimeout(3500);
  await p.locator('.react-modal-sheet-container').getByText(name, { exact: false }).locator('visible=true').first().click();
  await p.waitForTimeout(4000);
};
/** The shelf boxes — one per counted shape, in the "What you have now" section. */
const shelfBoxes = () =>
  p.evaluate(() => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    const pages = [...(active?.querySelectorAll('.navstack-page') ?? [])];
    const page = pages[pages.length - 1];
    return [...(page?.querySelectorAll('[class*="shapeBox"]') ?? [])].map((box) => {
      const input = box.querySelector('input');
      return {
        label: (box.querySelector('label')?.textContent ?? '').trim().slice(0, 20),
        value: input?.value ?? null,
        readOnly: input?.readOnly ?? null,
      };
    });
  });

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(8000);

  console.log('A  Chivita reads 3 Cans');
  await openItem('Chivita Active Zest', 'Chivita Active Zest Can');
  let t = await activeText();
  const said = (t.match(/\d+ (Cans?|pieces?)( \d+ pieces?)?/gi) ?? []).slice(0, 4);
  await p.screenshot({ path: `${SHOTS}/opening-page-chivita.png` });
  check('its page says 3 Cans', said.some((x) => /^3 Cans?$/i.test(x.trim())) && !said.some((x) => /^3 pieces?$/i.test(x.trim())), said.join(' | '));

  console.log('A2 its history shows the count that matched');
  await p.getByText(/Stock history|Last changed|See the history/i).locator('visible=true').first().click().catch(() => {});
  await p.waitForTimeout(4000);
  const hist = await activeText();
  await p.screenshot({ path: `${SHOTS}/opening-history-chivita.png` });
  check('the history lists "Counted"', /Counted/.test(hist), hist.slice(0, 160).replace(/\s+/g, ' '));
  check('… and says it matched', /Counted\s*Matched/.test(hist));
  check('… beside the two opening lines', (hist.match(/Opening balance/g) ?? []).length === 2);
  await p.goBack({ waitUntil: 'commit' }).catch(() => {});
  await p.waitForTimeout(2500);

  console.log('B  its edit form sets the opening');
  await p.locator('button[aria-label="Edit this item"]').locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  t = await activeText();
  const boxes = await shelfBoxes();
  await p.screenshot({ path: `${SHOTS}/opening-edit-chivita.png`, fullPage: true });
  check('the boxes hold 3 Cans 0 pieces', boxes.some((b) => /Can/.test(b.label) && b.value === '3') && boxes.some((b) => /Piece/.test(b.label) && b.value === '0'), JSON.stringify(boxes));
  check('… and can be changed', boxes.length > 0 && boxes.every((b) => !b.readOnly), JSON.stringify(boxes.map((b) => b.readOnly)));
  check('the note says it is still the opening', /Still the opening/.test(t));
  check('no "why is this being corrected?"', !/Why is this count being corrected/.test(t));

  const cans = p.locator('[class*="shapeBox"]').filter({ hasText: /^Cans/ }).locator('input').first();
  const pieces = p.locator('[class*="shapeBox"]').filter({ hasText: /^Pieces/ }).locator('input').first();
  await cans.fill('2');
  await pieces.fill('12');
  const saveButtons = await p.getByRole('button', { name: /Save/ }).locator('visible=true').allTextContents();
  console.log('  (save buttons on screen:', JSON.stringify(saveButtons), ')');
  // Waits for the save itself rather than a fixed pause — a slow render made that flaky.
  await Promise.all([
    p.waitForRequest(/rpc\/set_opening_stock/, { timeout: 20000 }).catch(() => null),
    p.getByRole('button', { name: /Save/ }).locator('visible=true').last().click(),
  ]);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${SHOTS}/opening-after-save.png` });
  const dialog = await p.evaluate(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"]')].map((d) => (d.textContent ?? '').trim().slice(0, 200)).filter(Boolean));
  if (dialog.length) console.log('  (on screen after save:', JSON.stringify(dialog), ')');
  const opening = sent.find((s) => s.fn === 'set_opening_stock');
  check('saving sends set_opening_stock', Boolean(opening), sent.map((s) => s.fn).join(', ') || 'nothing sent');
  check('… with 60 pieces (2 Cans 12 pieces)', Number(opening?.body?.p_qty) === 60, JSON.stringify(opening?.body));
  check('… and no correction count', !sent.some((s) => ['enter_stock_count', 'resolve_variance', 'close_stock_period'].includes(s.fn)), sent.map((s) => s.fn).join(', '));

  console.log('C  an item that has sold');
  await openItem('Goldberg Bottle', 'Goldberg Bottle');
  await p.locator('button[aria-label="Edit this item"]').locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  t = await activeText();
  const locked = await shelfBoxes();
  await p.screenshot({ path: `${SHOTS}/opening-edit-goldberg.png`, fullPage: true });
  check('its boxes are read-only', locked.length > 0 && locked.every((b) => b.readOnly), JSON.stringify(locked));
  check('… and say it changes by a count', /changes by a count/.test(t));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/opening-crash.png` }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
