/**
 * A change this device made must be on screen before the server is asked anything.
 *
 * The shop adds an item and presses Back to a list that does not have it. It invents a unit and
 * returns to a picker that has never heard of it. It renames something and sees the old name. All
 * three had the same cause: the screen asked the server to tell it what this device had just
 * decided, and until the answer came back the old thing was what you saw — so the habit became to
 * pull the page down and reload.
 *
 * state-stack is reactive. A write patches the cache it already holds.
 *
 * THE NETWORK IS WATCHED, not just the pixels. "It appeared" is not the claim — the claim is that
 * it appeared without a read, so this counts the RPCs that fetch a list and fails if one fires.
 *
 *     node scripts/probe-no-round-trip.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/no-round-trip';
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
const NAME = `AAA Round Trip ${stamp}`;
const RENAMED = `AAA Renamed ${stamp}`;
const storeId = (await admin.from('stores').select('id').limit(1).single()).data.id;

const crate = (
  await admin
    .from('store_units')
    .insert({ store_id: storeId, name: `RCrate${stamp}`, plural: `RCrates${stamp}` })
    .select('id')
    .single()
).data.id;

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

/** The reads that would mean the screen asked instead of knowing. */
const LIST_READS = ['list_products', 'store_units_for', 'product_selling_units'];
let reads = [];
p.on('request', (r) => {
  const m = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(r.url());
  if (m && LIST_READS.includes(m[1])) reads.push(m[1]);
});

const tab = async (label) => {
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(1000);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(4500);
};

const rowNames = () => p.locator('[class*="stock-page_itemName"]').allInnerTexts();

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  await tab('Stock');
  const before = await rowNames();
  check('the stock list is loaded', before.length > 0, `${before.length} rows`);

  // ── 1. A unit invented mid-form reaches the picker ────────────────────────────────
  console.log('\n— a unit the shop invents while adding an item —');
  await p.getByRole('button', { name: /add an item/i }).first().click();
  await p.waitForTimeout(4000);
  await p.getByLabel(/What is it called/i).fill(NAME);

  await p.getByRole('button', { name: /Add a unit you sell in/i }).first().click();
  await p.waitForTimeout(3000);

  const NEWUNIT = `RKeg${stamp}`;
  await p.locator('[class*="UnitPicker_addRow"]').first().click();
  await p.waitForTimeout(4000);
  await p.getByLabel(/What is one of them called/i).fill(NEWUNIT);
  await p.getByLabel(/And more than one/i).fill(`${NEWUNIT}s`);
  await p.waitForTimeout(400);

  reads = [];
  await p.getByRole('button', { name: /Add it/i }).first().click();
  await p.waitForTimeout(6000);
  await p.screenshot({ path: `${SHOTS}/1-back-on-form.png` });

  // Re-open the picker and look for the word that was just invented.
  await p.getByRole('button', { name: /Add a unit you sell in/i }).first().click();
  await p.waitForTimeout(3000);
  const offered = await p.locator('[class*="UnitPicker_name"]').allInnerTexts();
  await p.screenshot({ path: `${SHOTS}/2-picker.png` });

  check(
    'the new unit is in the picker straight away',
    offered.includes(NEWUNIT),
    offered.slice(0, 8).join(' | '),
  );
  check(
    'and the shop was never asked for the unit list again',
    !reads.includes('store_units_for'),
    reads.join(', ') || 'no list reads',
  );

  // ── 2. A saved item reaches the list ──────────────────────────────────────────────
  console.log('\n— an item the shop adds —');
  await p.locator('[class*="UnitPicker_row"]').filter({ hasText: `RCrate${stamp}` }).first().click();
  await p.waitForTimeout(2500);
  await p
    .locator('li[class*="UnitsEditor_card__"]')
    .getByLabel(/^Price for one/i)
    .first()
    .fill('5000');
  await p.waitForTimeout(600);

  reads = [];
  await p.getByRole('button', { name: /^Add it$/i }).click();
  await p.waitForTimeout(7000);
  await p.screenshot({ path: `${SHOTS}/3-list-after-add.png` });

  const afterAdd = await rowNames();
  check('the new item is in the list on the way back', afterAdd.includes(NAME), `${afterAdd.length} rows`);
  check(
    'and the list was not re-read to learn it',
    !reads.includes('list_products'),
    reads.join(', ') || 'no list reads',
  );

  // ── 3. A rename reaches the list ──────────────────────────────────────────────────
  console.log('\n— and when the shop renames it —');
  await p.locator('[class*="stock-page_itemName"]:visible').filter({ hasText: NAME }).first().click();
  await p.waitForTimeout(4000);
  await p.locator('button[aria-label*="Edit" i]:visible').first().click();
  await p.waitForTimeout(4000);
  await p.getByLabel(/What is it called/i).fill(RENAMED);
  await p.waitForTimeout(400);

  reads = [];
  await p.getByRole('button', { name: /Save changes/i }).click();
  await p.waitForTimeout(7000);
  await p.locator('button[aria-label*="back" i]:visible').first().click();
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${SHOTS}/4-list-after-rename.png` });

  const afterRename = await rowNames();
  check('the new name is in the list', afterRename.includes(RENAMED), `${afterRename.length} rows`);
  check('and the old one is gone', !afterRename.includes(NAME));
  check(
    'with no re-read',
    !reads.includes('list_products'),
    reads.join(', ') || 'no list reads',
  );

  // ── Clean up ──────────────────────────────────────────────────────────────────────
  const { data: made } = await admin
    .from('products')
    .select('id')
    .in('name', [NAME, RENAMED]);
  for (const row of made ?? []) {
    await admin.from('product_price_tiers').delete().eq('product_id', row.id);
    await admin.from('product_units').delete().eq('product_id', row.id);
    await admin.from('product_sale_units').delete().eq('product_id', row.id);
    const gone = await admin.from('products').delete().eq('id', row.id);
    if (gone.error) await admin.from('products').update({ status: 'archived' }).eq('id', row.id);
  }
  await admin.from('store_units').delete().eq('store_id', storeId).eq('name', NEWUNIT);
} finally {
  await browser.close();
  await admin.from('store_units').delete().eq('id', crate);
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
