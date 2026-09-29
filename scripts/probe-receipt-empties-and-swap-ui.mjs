/**
 * A RECEIPT SETTLES ITS OWN EMPTIES, AND ALL ITEMS HANDS OVER TO PAYMENT — clicked through.
 *
 *  1. An older receipt for a customer who took crates on it lists only THAT sale's containers,
 *     each with All back / Part. Looks only: nothing is recorded.
 *  2. All items → Take payment swaps the page: Back from payment is the till, not the list.
 *
 *     node scripts/probe-receipt-empties-and-swap-ui.mjs [http://localhost:3100] [customer]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const WHO = process.argv[3] ?? 'Funke mama stores';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/receipt-empties';
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

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const PROBE_DRAFTS = trackDrafts(p);
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const text = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  console.log(`\n— ${WHO}'s receipt —`);
  await p.locator('.nav-item').filter({ hasText: /^Money$/ }).first().click();
  await p.waitForTimeout(6000);
  const sale = p.getByRole('button', { name: new RegExp(WHO, 'i') }).locator('visible=true').first();
  await sale.waitFor({ state: 'visible', timeout: 60000 });
  await sale.click();
  await p.waitForTimeout(5000);
  // The customer's statement first; the sale on it opens the receipt.
  const card = p.getByText(/items · ₦/).locator('visible=true').first();
  await card.waitFor({ state: 'visible', timeout: 30000 });
  await card.click();
  await p.waitForTimeout(7000);
  const block = p.getByText('Empties from this receipt', { exact: true }).locator('visible=true').first();
  await block.scrollIntoViewIfNeeded().catch(() => {});
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${SHOTS}/1-receipt.png` });
  check('the receipt offers its own empties', (await block.count()) > 0);
  const t1 = await text();
  check('each with All back and Part',
    (await p.getByRole('button', { name: 'All back', exact: true }).locator('visible=true').count()) > 0 &&
      (await p.getByRole('button', { name: 'Part', exact: true }).locator('visible=true').count()) > 0);
  check('only what this sale sent out (no "everything" button for one line)', !/They brought everything back/.test(t1) ||
    (await p.getByRole('button', { name: 'All back', exact: true }).locator('visible=true').count()) > 1);

  console.log('\n— All items → Take payment → Back —');
  await p.locator('.nav-item').filter({ hasText: /^Sell$/ }).first().click();
  await p.waitForTimeout(4000);
  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  await plus.waitFor({ state: 'visible', timeout: 60000 });
  await plus.scrollIntoViewIfNeeded();
  await plus.click();
  await p.waitForTimeout(5000);
  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(2000);
  await p.locator('[role="dialog"] input').first().fill('Chivita Active');
  const hit = p.locator('[role="dialog"]').getByText(/Chivita Active \(1L\)/i).first();
  await hit.waitFor({ state: 'visible', timeout: 30000 });
  await hit.click();
  await p.waitForTimeout(5000);

  await p.getByRole('button', { name: /All items/ }).first().click();
  await p.waitForTimeout(5000);
  const pay = p.getByRole('button', { name: /Take payment ·/ }).first();
  check('All items offers Take payment', (await pay.count()) > 0);
  await pay.click();
  await p.waitForTimeout(6000);
  await p.screenshot({ path: `${SHOTS}/2-payment.png` });
  check('it opens Take payment', /Recording for/.test(await text()));

  await p.locator('button[aria-label*="back" i], button[aria-label*="Back"]').first().click().catch(() => {});
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/3-after-back.png` });
  const t3 = await text();
  check('Back from payment is the till, not All items', /Add an item/.test(t3) && !/NOT A RECEIPT|Not a receipt/.test(t3));

  await p.goBack().catch(() => {});
  await p.waitForTimeout(3000);
  const t4 = await text();
  check('and the browser Back does not reopen All items', !/Not a receipt/i.test(t4), t4.slice(0, 80));

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await p.screenshot({ path: `${SHOTS}/last.png`, fullPage: true }).catch(() => {});
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
  console.log(`\n  shots in ${SHOTS}`);
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
