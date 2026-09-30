/**
 * THE TILL'S OWN TAB IS NOT THE SHOP'S UNTIL SOMETHING IS ON IT.
 *
 * "Something always creates a new customer behind." The till starts a customer by itself when it
 * opens with none; it used to save that empty tab to the shop at once, and tabs are shared, so every
 * phone, reload and browser that opened the till put another "Customer N ₦0" on every till. The
 * shop cleared thirty-seven of them.
 *
 * The shop's real open tab (A406 Hotel) must not be touched to test this, so the browser is told the
 * shop has NO open tabs — `my_open_drafts` answered with [] — which is exactly the state that starts
 * one. Then:
 *
 *   1  a customer tab is on the till, ready to scan into;
 *   2  and nothing was sent to the shop for it — no `save_draft_order` in 6 seconds;
 *   3  put an item on it → it IS saved, and gets its code (tracked, and closed at the end).
 *
 *     node scripts/probe-auto-tab-stays-local-ui.mjs [http://localhost:3100]
 */

import { chromium, webkit } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await (process.env.ENGINE === 'webkit' ? webkit : chromium).launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const PROBE_DRAFTS = trackDrafts(p);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// The shop, as far as this browser can tell, has no open tabs.
await p.route('**/rest/v1/rpc/my_open_drafts*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
);
const saves = [];
p.on('request', (r) => {
  if (r.url().includes('/rpc/save_draft_order')) saves.push(Date.now());
});

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(8000);

  const tabs = p.locator('[role="tablist"][aria-label="Customers being served"] [role="tab"]');
  const shown = await tabs.count();
  check('the till opened a customer by itself, ready to scan into', shown === 1, `${shown} tab(s)`);
  await p.waitForTimeout(6000);
  check('… and told the shop NOTHING about it', saves.length === 0, `${saves.length} save(s)`);
  const { data: fresh } = await admin
    .from('draft_orders')
    .select('code')
    .in('client_uuid', [...PROBE_DRAFTS].length ? [...PROBE_DRAFTS] : ['00000000-0000-0000-0000-000000000000']);
  check('… so no empty tab reached any other till', (fresh ?? []).length === 0, JSON.stringify(fresh));

  // Something on it → it is the shop's now.
  await p.getByRole('button', { name: /Add an item/ }).locator('visible=true').first().click();
  await p.waitForTimeout(1800);
  await p.keyboard.type('Chivita Active');
  await p.waitForTimeout(3000);
  // The product itself, by its full name — not the picker's "Add … to your shop" button.
  await p.locator('.react-modal-sheet-container').getByText('Chivita Active (1L)', { exact: true }).locator('visible=true').first().click();
  await p.waitForTimeout(6000);
  await p.screenshot({ path: 'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/auto-tab-after-item.png' });
  console.log('  tab now reads:', JSON.stringify(await tabs.first().textContent()));
  check('with an item on it, it is saved to the shop', saves.length > 0, `${saves.length} save(s)`);
  const code = await p.locator('button[aria-label^="Share order "]').first().getAttribute('aria-label').catch(() => null);
  check('… and gets its code', Boolean(code), code ?? 'no code');

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
