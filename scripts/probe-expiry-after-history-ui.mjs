/**
 * AFTER STOCK HISTORY, THE SHELF IS LOCKED — AND ITS DATES ARE NOT.
 *
 * "Expiry date should still be editable in the edit product form; only the initial qty cannot be
 * after stock history exists."
 *
 * 5-Alive Pulpy Orange Big PET has sold and carries a dated lot. Its edit form must keep the shelf
 * boxes read-only while the lot's date can be changed and saved — with no reason asked, because a
 * date is not stock. Every writer is answered by the probe, so nothing in the shop changes.
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

const sent = [];
for (const fn of ['set_stock_layer_expiry', 'set_product_expiry', 'correct_layer_expiry', 'set_layer_expiry', 'date_shelf_stock', 'set_opening_stock', 'enter_stock_count', 'update_product', 'save_product_units']) {
  await p.route(`**/rest/v1/rpc/${fn}*`, async (route) => {
    sent.push({ fn, body: JSON.parse(route.request().postData() ?? '{}') });
    await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
}
// Anything else that writes expiry, whatever it is called, is stopped too — this probe changes nothing.
await p.route(/rest\/v1\/rpc\/(?!expiring_)[a-z_]*expir/, async (route) => {
  sent.push({ fn: route.request().url().split('/rpc/')[1], body: route.request().postData() });
  await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
});

const activePage = () =>
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
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(8000);

  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /Search your stock/ }).locator('visible=true').first().click();
  await p.waitForTimeout(1500);
  await p.keyboard.type('5-Alive Big');
  await p.waitForTimeout(3500);
  await p.locator('.react-modal-sheet-container').getByText(/5-Alive Pulpy Orange Big/).locator('visible=true').first().click();
  await p.waitForTimeout(4000);
  await p.locator('button[aria-label="Edit this item"]').locator('visible=true').first().click();
  await p.waitForTimeout(6000);

  const boxes = await p.evaluate(() =>
    [...document.querySelectorAll('.group-stack-container[data-active="true"] [class*="shapeBox"] input')].map((i) => i.readOnly),
  );
  check('the shelf boxes are read-only (it has sold)', boxes.length > 0 && boxes.every(Boolean), JSON.stringify(boxes));

  const heading = p.getByText('When does it go off?').first();
  check('"When does it go off?" is on the form', (await heading.count()) > 0);
  await heading.scrollIntoViewIfNeeded().catch(() => {});
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${SHOTS}/expiry-after-history.png` });

  const dates = p.locator('.group-stack-container[data-active="true"] input[type="date"]');
  const count = await dates.count();
  const editable = count > 0 ? await dates.first().evaluate((i) => !i.readOnly && !i.disabled) : false;
  check('the dated lot has a date that can be changed', editable, `${count} date box(es)`);

  if (editable) {
    await dates.first().fill('2027-03-01');
    await p.waitForTimeout(800);
    const t = await activePage();
    check('changing it does not ask why', !/Why is this date being corrected/.test(t));
    const own = p.getByRole('button', { name: 'Save this date' }).locator('visible=true');
    check('the change registered (its own save button shows)', (await own.count()) > 0, `value now ${await dates.first().inputValue()}`);
    await p.screenshot({ path: `${SHOTS}/expiry-after-history-changed.png` });
    const after = [];
    p.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rpc/')) after.push(r.url().split('/rpc/')[1].split('?')[0]); });
    p.on('response', async (r) => {
      if (r.url().includes('/rpc/') && r.status() >= 400) after.push(`!! ${r.url().split('/rpc/')[1].split('?')[0]} ${r.status()} ${(await r.text().catch(() => '')).slice(0, 160)}`);
    });
    const saveButtons = await p.getByRole('button', { name: /Save/ }).locator('visible=true').allTextContents();
    console.log('  (save buttons:', JSON.stringify(saveButtons), ')');
    await Promise.all([
      p.waitForRequest(/rpc\/[a-z_]*expir/, { timeout: 15000 }).catch(() => null),
      p.getByRole('button', { name: /Save/ }).locator('visible=true').last().click(),
    ]);
    await p.waitForTimeout(8000);
    await p.screenshot({ path: `${SHOTS}/expiry-after-save.png` });
    console.log('  (page after save:', JSON.stringify((await activePage()).slice(0, 200)), ')');
    const shown = await p.evaluate(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map((d) => (d.textContent ?? '').trim().slice(0, 200)));
    if (shown.length) console.log('  (on screen after save:', JSON.stringify(shown), ')');
    console.log('  (requests after save:', JSON.stringify(after), ')');
    const expiry = sent.find((s) => /expir/.test(s.fn));
    check('saving sends the new date', Boolean(expiry) && JSON.stringify(expiry.body).includes('2027-03-01'), JSON.stringify(sent.map((s) => s.fn)));
    check('… and no stock change', !sent.some((s) => ['set_opening_stock', 'enter_stock_count', 'date_shelf_stock'].includes(s.fn)), JSON.stringify(sent.map((s) => s.fn)));
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/expiry-crash.png` }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
