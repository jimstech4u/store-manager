/**
 * THE SELL FLOW, PHOTOGRAPHED — one sale walked through on a phone, every screen saved, so the flow
 * can be redesigned against what it is and compared as it changes.
 *
 * Builds a three-item sale through the till's box on a tab of its own (the shop's real open orders untouched: the browser
 * is told there are none), opens each step — the picker, the till, a line, Take payment, All items —
 * and never settles. The tab is cancelled at the end.
 *
 *     SHOTS=<dir> node scripts/shots-sell-flow.mjs [http://localhost:3100]
 *
 * Writes <dir>/flow-NN-<step>.png and prints the taps each step took.
 */

import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const OUT = process.env.SHOTS ?? 'shots/sell-flow';
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const PROBE_DRAFTS = trackDrafts(p);
await p.route('**/rest/v1/rpc/my_open_drafts*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
const settles = [];
p.on('request', (r) => { if (/rpc\/(settle|record_sale|post_sale)/.test(r.url())) settles.push(r.url()); });

let n = 0;
let taps = 0;
const tap = async (locator) => { taps += 1; await locator.click(); };
const shot = async (step, full = false) => {
  n += 1;
  const file = `${OUT}/flow-${String(n).padStart(2, '0')}-${step}.png`;
  await p.screenshot({ path: file, fullPage: full });
  console.log(`  ${String(n).padStart(2, '0')} ${step.padEnd(28)} taps so far: ${taps}`);
};
const scrollAll = (to) => p.evaluate((y) => document.querySelectorAll('*').forEach((e) => { if (e.scrollHeight > e.clientHeight + 50) e.scrollTop = y === 'end' ? e.scrollHeight : 0; }), to);

/** One item through the till's box: tap it, type, tap the result. Three taps, whatever the quantity. */
async function addItem(typed, exact, shotName) {
  const box = p.getByLabel('Add an item: how many, then what').locator('visible=true').first();
  await tap(box);
  await box.pressSequentially(typed, { delay: 40 });
  await p.waitForTimeout(2500);
  if (shotName) await shot(shotName);
  await tap(p.getByRole('option').filter({ hasText: exact }).first());
  await p.waitForTimeout(3000);
}

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(8000);
  await shot('till-empty');

  await addItem('2 Big Stout', 'Big Stout Bottle (600mL)', 'till-typing');
  await shot('till-one-line');
  await addItem('½ Heineken', 'Heineken Big Bottle (600mL)');
  await addItem('1 Small 7up', 'Small 7up Bottle (35cl)');
  await shot('till-three-lines');
  await scrollAll('end');
  await p.waitForTimeout(800);
  await shot('till-three-lines-bottom');
  await scrollAll(0);

  // Take payment
  const pay = p.locator('button').filter({ hasText: /Take payment|Fix the quantity|Count|Price/ }).locator('visible=true').last();
  console.log('      pay button says:', (await pay.innerText()).replace(/\s+/g, ' '));
  await tap(pay);
  await p.waitForTimeout(4000);
  await shot('take-payment-top');
  // Scrolled as a thumb does (wheel events), so sections that draw when they come into view do.
  await p.mouse.move(195, 500);
  for (const i of [1, 2, 3, 4]) {
    for (let k = 0; k < 6; k += 1) { await p.mouse.wheel(0, 110); await p.waitForTimeout(120); }
    await p.waitForTimeout(900);
    await shot(`take-payment-${i}`);
  }
  await scrollAll(0);
  await p.waitForTimeout(500);

  // A line, from "What are they buying"
  const line = p.getByText('Heineken Big Bottle (600mL)').locator('visible=true').first();
  if (await line.count()) {
    await tap(line);
    await p.waitForTimeout(3500);
    await shot('sale-line-page');
    taps += 1;
    await p.goBack();
    await p.waitForTimeout(3000);
  }
  taps += 1;
  await p.goBack();
  await p.waitForTimeout(3000);

  // All items
  await scrollAll('end');
  await p.waitForTimeout(600);
  const all = p.getByRole('button', { name: /All items/ }).locator('visible=true').first();
  if (await all.count()) {
    await tap(all);
    await p.waitForTimeout(4000);
    await shot('all-items');
  }
  console.log(`\n  nothing settled: ${settles.length === 0 ? 'yes' : 'NO — ' + settles.join(', ')}`);
} catch (e) {
  console.log('  stopped —', String(e).split('\n')[0]);
  await shot('stopped').catch(() => {});
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
