/**
 * A FRESH TILL OPENS WITH ONE CUSTOMER, NOT FIVE.
 *
 * Reported as "on fresh load I get up to 5 customers in the till without pressing add, all ₦0".
 *
 * The till starts a customer when it is holding none, so the screen is ready to sell. `orders` is
 * state-stack state, so the append is not visible on the very next render — while the effect's
 * dependencies do change between renders. So it ran again with the count still zero and started
 * another, and again: a row of empty tabs nobody asked for.
 *
 *     node scripts/probe-till-tabs.mjs [http://localhost:3101]
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
try {
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(18000);
  check('the shop is at its till', new URL(p.url()).pathname.startsWith('/main'));

  // Long enough for every re-render the old code would have fired on.
  await p.waitForTimeout(8000);
  const text = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  /*
   * EMPTY tabs, not all of them. A till legitimately restores whatever open orders the shop left
   * on the server, and counting those would make this a test of who used the app last. The bug
   * created EMPTY ones — ₦0, nothing on them — so that is what is counted, and one is expected:
   * a till holding nothing opens a customer so the screen is ready to sell.
   */
  const empties = [...text.matchAll(/Customer \d+ ₦0(?!\d)/g)].length;
  check('a fresh till opens at most one empty customer', empties <= 1, `${empties} empty: ${text.slice(0, 90)}`);
} catch (e) {
  check('the probe ran to the end', false, e.message);
} finally {
  await b.close();
  console.log(failed === 0 ? '  all good' : '  ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
