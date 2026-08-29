/**
 * The till writes to the shop. That is the whole product.
 *
 * THIS EXISTS BECAUSE IT BROKE TWICE AND NEITHER TIME WAS CAUGHT HERE. Once when a function was
 * given a tidier parameter order and became a second overload — PostgREST answers an ambiguous
 * name with 300 and every save failed silently. Once when a persistence flag was flipped and the
 * till started empty. Both looked completely normal on screen: a tab appeared, items went into it,
 * nothing said the shop had never heard of any of it. Both were found by a person on a real phone.
 *
 * So this asserts the least interesting thing in the codebase, which is exactly why it is worth
 * asserting: press the buttons, then look in the DATABASE and check the rows are there. It fails
 * in about twenty seconds where a person needed a working day to notice.
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const type = async (locator, value) =>
  locator.evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);

const storeId = (
  await admin.from('stores').select('id').eq('name', 'ASHABI GLOBAL RESOURCES').single()
).data.id;

const openDrafts = async () =>
  (
    await admin
      .from('draft_orders')
      .select('id, code')
      .eq('store_id', storeId)
      .eq('status', 'open')
  ).data;

const before = new Set((await openDrafts()).map((d) => d.id));
const created = [];

const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  const rpcFailures = [];
  page.on('response', (r) => {
    // 300 is the overload failure specifically, and it is not an error status anybody watches for.
    if (/\/rest\/v1\/rpc\//.test(r.url()) && r.status() >= 300) {
      rpcFailures.push(`${r.url().split('/rpc/')[1].split('?')[0]} -> ${r.status()}`);
    }
  });

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await type(page.locator('input[type="email"]').first(), env.SAMPLE_EMAIL);
  await type(page.locator('input[type="password"]').first(), env.SAMPLE_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(12000);

  // ── Pressing + must reach the shop ─────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Start another customer' }).click();
  await page.waitForTimeout(6000);

  const after = (await openDrafts()).filter((d) => !before.has(d.id));
  created.push(...after.map((d) => d.id));

  check('pressing + creates an order IN THE DATABASE', after.length > 0, `${after.length} new`);
  check('and the shop gave it a code', after.every((d) => Boolean(d.code)),
    after.map((d) => d.code).join(', '));

  // ── An item added must reach it too ────────────────────────────────────────────────
  await page.getByRole('button', { name: /Add an item/i }).first().click();
  await page.waitForTimeout(2500);

  const firstResult = page.locator('[role="dialog"] [class*="ProductPicker_name"]').first();
  if (await firstResult.count()) {
    await firstResult.click();
    await page.waitForTimeout(6000);

    /*
     * Any of the orders this probe created, not "the last one".
     *
     * The query that found them has no ORDER BY, so which row comes back last is arbitrary —
     * pressing "+" leaves two open orders (the till starts one on an empty screen, the click makes
     * another) and the item goes to whichever is active. Asking about a specific one made this
     * fail on a coin toss.
     */
    const { data: lines } = await admin
      .from('draft_order_lines')
      .select('id, draft_order_id')
      .in('draft_order_id', after.map((d) => d.id));

    check('adding an item writes a line to that order', (lines?.length ?? 0) > 0,
      `${lines?.length ?? 0} line(s)`);
  } else {
    console.log('  SKIP  item check (no products in the picker)');
  }

  /*
   * No RPC answered outside 2xx.
   *
   * The overload failure was a 300, which is not an error to a browser and not a thrown exception
   * to the app — the save simply returned something that was not a row and the code carried on.
   */
  check('every RPC the till made succeeded', rpcFailures.length === 0, rpcFailures.join(' | '));
} finally {
  for (const id of created) {
    await admin.from('draft_orders').update({ status: 'cancelled' }).eq('id', id);
  }
  if (created.length) console.log(`  (cleaned up ${created.length} order(s))`);
  await browser.close();
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
