/**
 * A SALE JUST SAVED PRINTS BY ITSELF after this device's countdown, can be cancelled, and waits for
 * the empties question first.
 *
 * Real receipts are opened as the till opens them after settling (`receipt_page`, fresh), pushed
 * through navigation-stack's own test helper. Nothing is settled or recorded: this browser is set to
 * print by itself with a 3-second wait, and its print window is replaced by a counter, so "printed"
 * means the receipt's own print routine ran. The empties question is looked at, never answered.
 *
 *     node scripts/probe-auto-print-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { installNavDevtools, navStack } from '@academix-admin/navigation-stack/playwright';

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
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;
const { data: walkIn } = await shop
  .from('sales')
  .select('id')
  .eq('store_id', storeId)
  .is('store_customer_id', null)
  .neq('status', 'voided')
  .order('occurred_at', { ascending: false })
  .limit(1)
  .single();

/*
 * A sale whose crates are still out with the customer, asked of the shop's own function — the one
 * the receipt's empties question reads.
 */
let withCrates = null;
{
  const { data: recent } = await shop
    .from('sales')
    .select('id')
    .eq('store_id', storeId)
    .not('store_customer_id', 'is', null)
    .neq('status', 'voided')
    .order('occurred_at', { ascending: false })
    .limit(40);
  for (const s of recent ?? []) {
    const { data } = await shop.rpc('sale_empties_outstanding', { p_sale_id: s.id });
    if ((data ?? []).some((r) => Number(r.owed ?? r.qty ?? 0) > 0)) {
      withCrates = s.id;
      break;
    }
  }
}

let failed = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const writes = [];
p.on('request', (r) => {
  if (r.method() !== 'GET' && /rpc\/(settle|record|return|take_|void|amend)/.test(r.url())) writes.push(r.url());
});
await installNavDevtools(p);
await p.addInitScript(() => {
  localStorage.setItem('sm.auto-print', JSON.stringify({ on: true, wait: 3, thenTill: false }));
  window.__printed = 0;
  window.print = () => {
    window.__printed += 1;
  };
});
const printed = () => p.evaluate(() => window.__printed);

async function openFresh(id) {
  await navStack(p, 'sell-stack').push('receipt_page', { id, fresh: '1' });
  await p.getByText(/Sale recorded/).first().waitFor({ timeout: 30000 });
}

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(6000);

  // ── A walk-in: nothing to ask, so it counts down and prints. ──
  await openFresh(walkIn.id);
  const banner = p.getByRole('status').filter({ hasText: /Printing/ }).first();
  await banner.waitFor({ timeout: 20000 });
  check(/in [123] seconds?/.test(await banner.innerText()), `a countdown shows (${(await banner.innerText()).replace(/\s+/g, ' ')})`);
  check((await printed()) === 0, 'nothing printed while it counts');
  await p.waitForTimeout(4500);
  check((await printed()) === 1, 'it printed once the countdown ran out');
  await p.waitForTimeout(2000);
  check((await printed()) === 1, 'and only once');

  // ── The same, cancelled. ──
  await navStack(p, 'sell-stack').pop();
  await p.waitForTimeout(1500);
  await openFresh(walkIn.id);
  await p.getByRole('status').filter({ hasText: /Printing/ }).first().waitFor({ timeout: 20000 });
  await p.getByRole('button', { name: 'Cancel', exact: true }).locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  check((await printed()) === 1, 'Cancel stops it — nothing more printed');
  check((await p.getByRole('status').filter({ hasText: /Printing/ }).count()) === 0, 'and the countdown is gone');

  // ── Crates still out: it waits for the empties question, which comes before the receipt. ──
  if (withCrates) {
    await navStack(p, 'sell-stack').pop();
    await p.waitForTimeout(1500);
    const before = await printed();
    await openFresh(withCrates);
    const ask = p.getByRole('status').filter({ hasText: /Prints when the empties are answered/ }).first();
    await ask.waitFor({ timeout: 20000 });
    check(true, 'with crates out, it asks about the empties instead of counting down');
    const q = await p.getByText('Did they bring any empties back?').first().boundingBox();
    const r = await p.locator('[data-print-root]').first().boundingBox();
    check(Boolean(q && r && q.y < r.y), 'and the empties question comes before the receipt');
    await p.waitForTimeout(5000);
    check((await printed()) === before, 'nothing printed while the question is open');
    await p.getByRole('button', { name: /Don.t print/ }).first().click();
  } else {
    console.log('  (no recent sale with crates still out — the empties wait was not exercised)');
  }
} catch (e) {
  failed += 1;
  console.log('  stopped —', String(e).split('\n')[0]);
  await p.screenshot({ path: 'probe-auto-print.png' }).catch(() => {});
} finally {
  check(writes.length === 0, `nothing was recorded${writes.length ? ` — ${writes.join(', ')}` : ''}`);
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
