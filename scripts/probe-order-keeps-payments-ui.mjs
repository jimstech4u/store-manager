/**
 * AN OPEN ORDER KEEPS WHAT WAS DONE ON IT — the + tapped during a save, and the payments typed on
 * Take payment (0276).
 *
 *   A. A save is made slow. + is tapped, the save leaves, + is tapped again while it is in the air.
 *      After a reload the quantity must be the last one tapped. Before the fix the save marked the
 *      order saved with the newer quantity it never sent, and the reload brought back the older one.
 *   B. A cash payment is added and a second amount left in the box. The seller goes to the till,
 *      starts the next customer, comes back, and then reloads. Both must still be there.
 *
 * On a tab of its own: the browser is shown only the orders this probe saved. Today's counts are
 * answered as counted IN THE BROWSER so the pay button opens; nothing is settled and nothing is
 * counted. The probe's orders are cancelled at the end.
 *
 *     node scripts/probe-order-keeps-payments-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';
import { addOnTill } from './till.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
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

const ITEM = 'Big Stout Bottle (600mL)';
let failed = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const PROBE = trackDrafts(p);
const mine = new Set();
const settles = [];
p.on('request', (r) => {
  if (/rpc\/(settle|record_sale)/.test(r.url())) settles.push(r.url());
});
p.on('response', async (r) => {
  if (!r.url().includes('/rpc/save_draft_order') || !r.ok()) return;
  try {
    mine.add(String(await r.json()));
  } catch {
    // not ours
  }
});
// Only this probe's orders, read from the shop for real.
await p.route('**/rest/v1/rpc/my_open_drafts*', async (route) => {
  const res = await route.fetch();
  const rows = (await res.json()) ?? [];
  await route.fulfill({ response: res, json: rows.filter((r) => mine.has(r.id)) });
});
await p.route('**/rest/v1/rpc/todays_counts*', async (route) => {
  const ids = JSON.parse(route.request().postData() ?? '{}').p_product_ids ?? [];
  await route.fulfill({
    json: ids.map((id) => ({
      product_id: id, period_id: 'probe', period_status: 'open', counted_qty: 0, first_qty: 0,
      counted_by_name: 'Probe', counted_by_you: true, counted_at: new Date().toISOString(), edits: 0,
    })),
  });
});
let slow = false;
await p.route('**/rest/v1/rpc/save_draft_order*', async (route) => {
  if (slow) await new Promise((r) => setTimeout(r, 3000));
  await route.continue();
});

const payBox = () => p.locator('section').filter({ hasText: 'How are they paying?' }).first();
// The quantity on the till's compact line, read from its button ("3 crates — type a quantity").
const qty = async () => {
  const label = await p.getByRole('button', { name: /— type a quantity$/ }).locator('visible=true').first().getAttribute('aria-label');
  const word = (label ?? '').split(' ')[0];
  const parts = { '½': 0.5, '¼': 0.25, '¾': 0.75 };
  const m = /^(\d*)([½¼¾]?)$/.exec(word);
  return m ? String(Number(m[1] || 0) + (parts[m[2]] ?? 0)) : word;
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(7000);

  await addOnTill(p, 'Big Stout', ITEM);
  await p.waitForTimeout(1500);
  const more = p.getByRole('button', { name: `One more ${ITEM}` }).locator('visible=true').first();
  await more.click();
  await p.waitForTimeout(3500); // saved, quietly

  // ── A ──
  const start = Number(await qty());
  slow = true;
  await more.click(); // start + 1, saved in 1.2s…
  // …and that save is in the air for 3s. The next + lands late in it, so the save COMES BACK before
  // the next one is due: that is the moment the old code called the newer quantity saved.
  await p.waitForTimeout(3700);
  await more.click(); // start + 2, while it is
  await p.waitForTimeout(7000);
  slow = false;
  await p.waitForTimeout(2500);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(7000);
  check(Number(await qty()) === start + 2, `the + tapped during a save survives a reload (${start} -> ${await qty()}, wanted ${start + 2})`);

  // ── B ──
  const pay = p.locator('button').filter({ hasText: /Take payment/ }).locator('visible=true').last();
  await pay.click();
  await p.waitForTimeout(4000);
  await payBox().getByLabel('Amount').fill('1000');
  await payBox().getByRole('button', { name: /Add payment/ }).click();
  await payBox().getByLabel('Amount').fill('250');
  await p.waitForTimeout(2500);

  await p.goBack();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: 'Start another customer' }).locator('visible=true').first().click();
  await p.waitForTimeout(2000);
  // back to the first tab
  await p.getByRole('tablist', { name: 'Customers being served' }).getByRole('tab').first().click();
  await p.waitForTimeout(1500);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(7000);
  await p.locator('button').filter({ hasText: /Take payment/ }).locator('visible=true').last().click();
  await p.waitForTimeout(4000);
  // Waited for, not slept on: on a slow line the page is still reading the order at four seconds.
  await p.getByText('Paying with').first().waitFor({ timeout: 20000 }).catch(() => {});
  const body = await p.locator('body').innerText();
  check(/Paying with[\s\S]*Cash[\s\S]*₦1,000/.test(body), 'the ₦1,000 cash payment is still listed after the next customer and a reload');
  check((await payBox().getByLabel('Amount').inputValue()).replace(/\D/g, '') === '250', 'the ₦250 left in the box is still in it');

  const { data: rows } = await admin
    .from('draft_order_payments')
    .select('method, amount, draft_order_id')
    .in('draft_order_id', [...mine]);
  check((rows ?? []).some((r) => r.method === 'cash' && Number(r.amount) === 1000), 'the shop holds the payment on the order');

  check(settles.length === 0, 'nothing was settled');
} catch (e) {
  failed += 1;
  console.log('  stopped —', String(e).split('\n')[0]);
  await p.screenshot({ path: 'probe-order-keeps-payments.png' }).catch(() => {});
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE);
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
