/**
 * The tracking page, watched while an order actually changes underneath it.
 *
 * This is the promise the page makes to a customer — "you will see each item as it is added up,
 * on your own phone" — and it was broken in a way no static check could catch. A page opened from
 * a shared LINK never polled: the poll only knew how to re-read by code, so the order showed once
 * and then sat frozen while the seller added three more things.
 *
 * So the test adds a line to a real order in the database and waits for the page to notice, both
 * ways in: by the code somebody typed, and by the link somebody was sent.
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

const browser = await chromium.launch();

const storeId = (
  await admin.from('stores').select('id').eq('name', 'ASHABI GLOBAL RESOURCES').single()
).data.id;

const product = (
  await admin.from('products').select('id, name').eq('store_id', storeId).limit(1).single()
).data;

/** A throwaway order this probe owns outright, so nothing real is disturbed. */
const { data: order } = await admin
  .from('draft_orders')
  .insert({ store_id: storeId, code: 'ZZTRK', status: 'open', label: 'Tracking probe' })
  .select('id, code, share_token')
  .single();

const addLine = async (position) => {
  await admin.from('draft_order_lines').insert({
    draft_order_id: order.id,
    product_id: product.id,
    entered_qty: 1,
    unit_price: 1000,
    line_total: 1000,
    position,
  });
  // The page reads `updated_at` as the order's own clock.
  await admin.from('draft_orders').update({ updated_at: new Date().toISOString() }).eq('id', order.id);
};

/*
 * Counts LINE ITEMS, not everything whose class contains "line".
 *
 * `[class*="track_line"]` also matches `track_lineName` and `track_lineTotal`, so one item counted
 * as five — and the wait returned before the new line had arrived, then failed the assertion that
 * came after it. The `li` is the row.
 */
const LINE = 'li[class*="track_line__"]';

/** Waits for the page to show a given number of lines, rather than assuming a poll interval. */
const waitForLines = async (page, want, timeoutMs = 20000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const n = await page.locator(LINE).count();
    if (n >= want) return n;
    await page.waitForTimeout(500);
  }
  return page.locator(LINE).count();
};

try {
  await addLine(1);

  // ── Arriving by the spoken code ────────────────────────────────────────────────────
  const byCode = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  const errors = [];
  byCode.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));

  await byCode.goto(`${BASE}/track?code=${order.code}`, { waitUntil: 'networkidle' });
  check('an order opens from a typed code', (await waitForLines(byCode, 1)) >= 1);

  check(
    'the code box is gone once the order is showing',
    (await byCode.locator('input#\\:r0\\:, input[placeholder="ABCDE"]').count()) === 0,
  );
  check(
    'and there is a way to follow a different one',
    (await byCode.getByRole('button', { name: /follow a different order/i }).count()) === 1,
  );

  await addLine(2);
  check('a line added by the seller appears without touching the page',
    (await waitForLines(byCode, 2)) >= 2);
  check('and it is marked so the customer can see what changed',
    /just added/i.test(await byCode.locator('body').innerText()));
  await byCode.screenshot({ path: 'shots/track-live-code.png', fullPage: true });

  // ── Arriving by the sent link ──────────────────────────────────────────────────────
  /*
   * The case that was broken. Everything above passed before this fix too, because the poll knew
   * how to re-read a code — it simply had no idea what to do with a token.
   */
  const byLink = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  byLink.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));

  await byLink.goto(`${BASE}/t/${encodeURIComponent(order.share_token)}`, {
    waitUntil: 'networkidle',
  });
  check('an order opens from a shared link', (await waitForLines(byLink, 2)) >= 2);
  check(
    'the code box is gone there too',
    (await byLink.locator('input[placeholder="ABCDE"]').count()) === 0,
  );

  await addLine(3);
  check('A LINK KEEPS UPDATING TOO', (await waitForLines(byLink, 3)) >= 3, 'this is the one that was frozen');
  await byLink.screenshot({ path: 'shots/track-live-link.png', fullPage: true });

  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await admin.from('draft_orders').delete().eq('id', order.id);
  console.log('  (cleaned up the probe order)');
  await browser.close();
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
