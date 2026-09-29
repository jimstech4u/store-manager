/**
 * AN ORDER THE SHOP NO LONGER HAS — the till must recover, and a Close must never land elsewhere.
 *
 * 29 Sep: a tab's order was deleted on the server under a seller. Every save said "that order is no
 * longer open", payment could not start, the tab would not close, and pressing Close again
 * cancelled the NEIGHBOURING order (A406 Hotel, N142,600).
 *
 * This opens its own tab, puts an item on it, cancels THAT order behind the till's back (the probe's
 * own, found by the client id its browser sent), and checks:
 *   · the next save recovers — the tab is saved again as a new order and says so
 *   · Close then closes the probe's tab, and every other open order is exactly as it was
 *
 * SAFETY, because this is a live shop: the other open orders are read before and after, and any
 * that this run changed are put back.
 *
 *     node scripts/probe-dead-order-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SID = '7138327c-c81c-4486-a97c-92207b48b64e';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/dead-order';
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

/** Every open order in the shop, by id — the ones this probe must not disturb. */
const openOrders = async () => {
  const { data } = await admin
    .from('draft_orders')
    .select('id, code, label, status, client_uuid')
    .eq('store_id', SID)
    .eq('status', 'open');
  return data ?? [];
};

const theShops = await openOrders();
console.log(`  the shop's open orders before: ${theShops.map((o) => `${o.code} ${o.label ?? ''}`).join(', ') || 'none'}`);

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

  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  await plus.waitFor({ state: 'visible', timeout: 120000 });
  await plus.scrollIntoViewIfNeeded();
  await plus.click();
  await p.waitForTimeout(5000);

  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(2000);
  const search = p.locator('[role="dialog"] input').first();
  await search.fill('Chivita Active');
  const hit = p.locator('[role="dialog"]').getByText(/Chivita Active \(1L\)/i).first();
  await hit.waitFor({ state: 'visible', timeout: 30000 });
  await hit.click();
  await p.waitForTimeout(6000);

  // THE PROBE'S OWN ORDER, and only that: its client id came from this browser's own saves.
  const { data: mine } = await admin
    .from('draft_orders')
    .select('id, code, client_uuid')
    .in('client_uuid', [...PROBE_DRAFTS])
    .eq('status', 'open');
  // The till may have started an empty tab of its own as well; the one being served holds the item.
  let own = null;
  for (const o of mine ?? []) {
    const { count } = await admin
      .from('draft_order_lines')
      .select('id', { count: 'exact', head: true })
      .eq('draft_order_id', o.id);
    if ((count ?? 0) > 0) own = o;
  }
  check('the probe has its own saved order with the item', own !== null, own?.code ?? 'none');

  console.log('\n— the shop closes it behind the till —');
  await admin.from('draft_orders').update({ status: 'cancelled' }).eq('id', own.id);

  // An edit, which is what makes the till save again.
  await p.getByRole('button', { name: /One more Chivita Active/ }).first().click();
  await p.waitForTimeout(8000);
  await p.screenshot({ path: `${SHOTS}/1-after-save.png`, fullPage: true });
  const t = await text();
  check('the till says it was saved again as a new order', /saved again as a new order/i.test(t));
  check('and no longer says "no longer open"', !/no longer open/i.test(t));

  const { data: again } = await admin
    .from('draft_orders')
    .select('id, code, status')
    .in('client_uuid', [...PROBE_DRAFTS])
    .eq('status', 'open');
  // The new order is the one carrying the item — not the till's own empty tab beside it.
  let replacement = null;
  for (const o of again ?? []) {
    if (o.id === own.id) continue;
    const { count } = await admin
      .from('draft_order_lines')
      .select('id', { count: 'exact', head: true })
      .eq('draft_order_id', o.id);
    if ((count ?? 0) > 0) replacement = o;
  }
  check('a new open order holds the tab', replacement !== null, (again ?? []).map((o) => o.code).join(','));
  const { count: lineCount } = await admin
    .from('draft_order_lines')
    .select('id', { count: 'exact', head: true })
    .eq('draft_order_id', replacement?.id ?? '00000000-0000-0000-0000-000000000000');
  check('with the item still on it', (lineCount ?? 0) >= 1, `${lineCount} line(s)`);

  console.log('\n— and Close closes THIS tab —');
  const close = p.getByText('Close', { exact: true }).first();
  await close.click();
  await p.waitForTimeout(1500);
  const discard = p.getByRole('button', { name: /Discard it/ }).first();
  await discard.click();
  await p.waitForTimeout(6000);
  await p.screenshot({ path: `${SHOTS}/2-after-close.png`, fullPage: true });

  const { data: still } = await admin
    .from('draft_orders')
    .select('id')
    .eq('id', replacement?.id ?? '00000000-0000-0000-0000-000000000000')
    .eq('status', 'open');
  check("the probe's tab is closed in the shop", (still ?? []).length === 0);

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await p.screenshot({ path: `${SHOTS}/last.png`, fullPage: true }).catch(() => {});
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);

  // THE SHOP'S ORDERS, exactly as found. Anything this run closed is opened again.
  const after = new Set((await openOrders()).map((o) => o.id));
  const disturbed = theShops.filter((o) => !after.has(o.id));
  check("every one of the shop's open orders is untouched", disturbed.length === 0,
    disturbed.map((o) => o.code).join(', '));
  for (const o of disturbed) {
    await admin.from('draft_orders').update({ status: 'open' }).eq('id', o.id);
    console.log(`  (put ${o.code} ${o.label ?? ''} back to open)`);
  }
  console.log(`\n  shots in ${SHOTS}`);
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
