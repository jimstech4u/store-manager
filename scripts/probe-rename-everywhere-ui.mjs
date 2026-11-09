/**
 * A RENAME REACHES EVERY PLACE THAT NAMES THEM, without a reload and without asking the shop.
 *
 * "renaming a product or customer and any changes to data does not get updated in some lists like
 * pickers and pages." The customer edit page told the People list and the debtors list, and nothing
 * else: the picker on the till kept its cached rows and the tab being served kept its name.
 *
 * A probe customer is made (as the sample account, through `upsert_customer`), put on a till tab of
 * the probe's own, seen in the picker, renamed on its own edit page, and then looked for again on the
 * tab and in the picker. Nothing is sold. The customer is archived and the tab cancelled at the end.
 *
 *     node scripts/probe-rename-everywhere-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

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
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

const stamp = Date.now().toString().slice(-6);
const NAME = `AAA Probe ${stamp}`;
const RENAMED = `AAA Renamed ${stamp}`;
const { data: customerId, error: made } = await shop.rpc('upsert_customer', {
  p_store_id: storeId,
  p_phone: `0809${stamp}0`,
  p_display_name: NAME,
  p_business_name: null,
});
if (made) throw made;

let failed = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const PROBE = trackDrafts(p);
const mine = new Set();
p.on('response', async (r) => {
  if (!r.url().includes('/rpc/save_draft_order') || !r.ok()) return;
  try {
    mine.add(String(await r.json()));
  } catch {
    // not ours
  }
});
await p.route('**/rest/v1/rpc/my_open_drafts*', async (route) => {
  const res = await route.fetch();
  const rows = (await res.json()) ?? [];
  await route.fulfill({ response: res, json: rows.filter((r) => mine.has(r.id)) });
});
let reads = [];
p.on('request', (r) => {
  const m = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(r.url());
  if (m) reads.push(m[1]);
});

const picker = () => p.locator('.react-modal-sheet-container').locator('visible=true');
const tabs = () => p.getByRole('tablist', { name: 'Customers being served' });

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(7000);

  // On the till's tab, through the picker — which caches what it showed.
  await p.getByRole('button', { name: 'Say who this sale is for' }).locator('visible=true').first().click();
  await p.waitForTimeout(3000);
  await picker().getByText(NAME, { exact: true }).first().click();
  await p.waitForTimeout(3000);
  check((await tabs().innerText()).includes(NAME), 'the probe customer is on the tab');

  // Renamed on their own page: More → Everyone you sell to → them → Edit.
  await p.getByRole('button', { name: 'More', exact: true }).locator('visible=true').first().click();
  await p.waitForTimeout(3000);
  await p.getByText('Everyone you sell to').locator('visible=true').first().click();
  await p.waitForTimeout(4000);
  await p.getByText(NAME, { exact: true }).locator('visible=true').first().click();
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: `Edit ${NAME}` }).locator('visible=true').first().click();
  await p.waitForTimeout(3500);
  await p.getByLabel(/^Name/).locator('visible=true').first().fill(RENAMED);
  await p.getByRole('button', { name: 'Save', exact: true }).locator('visible=true').first().click();
  await p.waitForTimeout(4000);

  reads = [];
  await p.getByRole('button', { name: 'Sell', exact: true }).locator('visible=true').first().click();
  await p.waitForTimeout(2500);
  const tabText = await tabs().innerText();
  check(tabText.includes(RENAMED) && !tabText.includes(NAME), `the tab being served has the new name (${tabText.replace(/\s+/g, ' ').slice(0, 60)})`);

  await p.getByRole('button', { name: 'Change who this sale is for' }).locator('visible=true').first().click();
  await p.waitForTimeout(1200); // less than a read takes: what is shown is what was cached
  const shown = await picker().innerText();
  check(shown.includes(RENAMED) && !shown.includes(NAME), 'the picker shows the new name at once');
  console.log(`  asked on the way: ${[...new Set(reads)].join(', ') || 'nothing'}`);
} catch (e) {
  failed += 1;
  console.log('  stopped —', String(e).split('\n')[0]);
  await p.screenshot({ path: 'probe-rename-everywhere.png' }).catch(() => {});
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE);
  await admin.from('store_customers').update({ status: 'archived' }).eq('id', customerId);
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
