/**
 * THREE OPEN TRACKER ROWS, CHECKED WITHOUT WRITING ANYTHING.
 *
 *   A  Stock › shape price: tapping a price opens its page, and "Cheaper for taking more" loads.
 *      Left with Cancel.
 *   B  Stock › receive: a line put on the load and Record pressed with NO supplier is refused with
 *      "Say who this load came from." — the check runs before `record_purchase`, and the probe
 *      fails loudly if that call is ever made.
 *   C  Count › count entry: asks in the item's shapes (Packs, Cans…), not in base units. Left
 *      without saving.
 *
 *     node scripts/probe-open-items-ui.mjs [http://localhost:3100]
 */

import { chromium, webkit } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/open-items';
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

const browser = await (process.env.ENGINE === 'webkit' ? webkit : chromium).launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
/*
 * The till starts a customer by itself when it opens with none, so even a probe that never
 * touches Sell can leave an empty tab on the shop's till. Only what THIS browser saved is closed.
 */
const PROBE_DRAFTS = trackDrafts(p);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

// Nothing here may write. Any of these leaving the browser fails the probe.
const WRITES = /\/rpc\/(record_purchase|record_supplier_empties|enter_stock_count|ensure_open_period|close_stock_period|set_unit_price|save_shape_price)/;
const writes = [];
p.on('request', (r) => {
  if (r.method() === 'POST' && WRITES.test(r.url())) writes.push(r.url().split('/rpc/')[1]);
});

const activeText = () =>
  p.evaluate(() => document.querySelector('.group-stack-container[data-active="true"]')?.textContent ?? '');
const tab = async (label) => {
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(2500);
};
const back = async () => {
  await p.goBack({ waitUntil: 'commit' }).catch(() => {});
  await p.waitForTimeout(1800);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(8000);

  console.log('A  shape price');
  await tab('Stock');
  await p.getByText(/Chivita Active/).locator('visible=true').first().click();
  await p.waitForTimeout(3500);
  const price = p.locator('[class*="shapePriceButton"]').locator('visible=true').first();
  check('the product shows its shapes with a price to tap', (await price.count()) > 0);
  await price.click();
  await p.waitForTimeout(4000);
  let t = await activeText();
  await p.screenshot({ path: `${SHOTS}/a-shape-price.png`, fullPage: true });
  check('the price page has "Cheaper for taking more"', /Cheaper for taking more/.test(t));
  check('… and its quantity prices loaded', !/Loading the quantity prices|Could not load the quantity prices/i.test(t));
  await p.getByRole('button', { name: /^Cancel$/ }).locator('visible=true').first().click();
  await p.waitForTimeout(2000);
  await back();

  console.log('B  receive without a supplier');
  await p.locator('button[aria-label="Record a delivery"]').locator('visible=true').first().click();
  await p.waitForTimeout(3500);
  await p.getByRole('button', { name: /Add an item/ }).locator('visible=true').first().click();
  await p.waitForTimeout(2000);
  await p.keyboard.type('Chivita Active');
  await p.waitForTimeout(3000);
  await p.getByText(/Chivita Active/).locator('visible=true').last().click();
  await p.waitForTimeout(2500);
  await p.getByLabel('How many').first().fill('1');
  await p.getByRole('button', { name: /Put it on the load/ }).first().click();
  await p.waitForTimeout(1500);
  await p.getByRole('button', { name: /^Record/ }).locator('visible=true').last().click();
  await p.waitForTimeout(3000);
  t = await p.evaluate(() => document.body.innerText);
  await p.screenshot({ path: `${SHOTS}/b-receive.png`, fullPage: true });
  check('Record with no supplier is refused', /Say who this load came from/.test(t));
  check('… before anything reached the shop', writes.length === 0, writes.join(', '));
  await p.keyboard.press('Escape').catch(() => {});
  await p.waitForTimeout(800);
  await back();

  console.log('C  count entry in shapes');
  await p.getByRole('button', { name: /^Count$/ }).locator('visible=true').first().click();
  await p.waitForTimeout(4000);
  // Found through Count's own search: the list is alphabetical and Malta is well down it.
  await p.getByRole('button', { name: 'Find a product to count' }).locator('visible=true').first().click();
  await p.waitForTimeout(1500);
  await p.keyboard.type('Malta Guinness Can');
  await p.waitForTimeout(3500);
  await p.locator('.react-modal-sheet-container').getByText(/Malta Guinness Can/).locator('visible=true').first().click();
  await p.waitForTimeout(4000);
  const labels = await p.evaluate(() =>
    [...document.querySelectorAll('.group-stack-container[data-active="true"] label')]
      .filter((l) => l.getBoundingClientRect().width > 0)
      .map((l) => (l.textContent ?? '').trim().split('\n')[0])
      .slice(0, 6),
  );
  await p.screenshot({ path: `${SHOTS}/c-count-entry.png`, fullPage: true });
  check('Malta is counted in Cans and Pieces', labels.some((l) => /^Cans/i.test(l)) && labels.some((l) => /^Pieces/i.test(l)), JSON.stringify(labels));

  check('nothing was written', writes.length === 0, writes.join(', '));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/crash.png` }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(`\nwrites seen: ${writes.length}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
