/**
 * THE PAYMENT CONFIRMATION, and the navigation-report switch — looked at, nothing recorded.
 *
 * Opens the confirmation for the shop's most recent customer payment through navigation-stack's
 * devtools (so no payment has to be made to see it), and the Updates page with its recorder.
 *
 *     node scripts/probe-payment-done-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SID = '7138327c-c81c-4486-a97c-92207b48b64e';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/payment-done';
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

const { data: pays } = await admin
  .from('payments')
  .select('id, amount, store_customer_id')
  .eq('store_id', SID)
  .eq('direction', 'in')
  .not('store_customer_id', 'is', null)
  .order('occurred_at', { ascending: false })
  .limit(1);
const pay = pays?.[0];
const { data: cust } = await admin.from('store_customers').select('display_name').eq('id', pay.store_customer_id).single();
console.log(`  the latest payment: ${cust.display_name}, ${pay.amount}`);

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
/*
 * The till starts a customer by itself when it opens with none, so even a probe that never
 * touches Sell can leave an empty tab on the shop's till. Only what THIS browser saved is closed.
 */
const PROBE_DRAFTS = trackDrafts(p);
await p.addInitScript({ content: 'window.__NAV_STACK_DEVTOOLS__ = true;' });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  const r = await p.evaluate((id) => window.__NAV_STACK__.push('sell-stack', 'payment_done_page', { id }), pay.id);
  check('the confirmation page opens', r.ok, JSON.stringify(r).slice(0, 80));
  await p.waitForTimeout(5000);
  await p.screenshot({ path: `${SHOTS}/1-done.png` });
  const t = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('it names the customer', t.includes(cust.display_name));
  check('and the amount', /₦[\d,]+/.test(t));
  check('and where the account stands', /Owes|Paid up|In credit|Could not read/.test(t));
  check('with Done and Share', /Done/.test(t) && /Share/.test(t));

  await p.evaluate(() => window.__NAV_STACK__.push('sell-stack', 'updates_page'));
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/2-updates.png`, fullPage: true });
  const t2 = await p.locator('body').innerText();
  check('Updates offers the navigation recorder', /Record navigation|Stop recording/.test(t2));

  // FROM HISTORY: the statement's "Payment received" line opens the same page, as a receipt to send.
  await p.goto(`${BASE}/main`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(6000);
  await p.locator('.nav-item').filter({ hasText: /^Money$/ }).first().click();
  await p.waitForTimeout(5000);
  const who = p.getByRole('button', { name: new RegExp(cust.display_name, 'i') }).locator('visible=true').first();
  await who.waitFor({ state: 'visible', timeout: 60000 });
  await who.click();
  await p.waitForTimeout(6000);
  const line = p.getByRole('button', { name: /Payment received/ }).locator('visible=true').first();
  check('a payment line on the statement can be tapped', (await line.count()) > 0);
  if (await line.count()) {
    await line.scrollIntoViewIfNeeded();
    await line.click();
    await p.waitForTimeout(5000);
    await p.screenshot({ path: `${SHOTS}/3-from-history.png` });
    const t3 = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
    check('it opens as a payment receipt', /Payment receipt/.test(t3));
    check('with Share, to send it again', /Share/.test(t3));
  }

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
  console.log(`\n  shots in ${SHOTS}`);
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
