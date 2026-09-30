/**
 * A CUSTOMER'S ACCOUNT: ITS ACTIONS AS A GRID OF CARDS, AND "WHAT YOU OWE THEM" ONLY WHEN THERE IS SOME.
 *
 * "UI visible to settle what we owe the customer in empties or money or deposit, maybe only visible
 * when any exist ... instead of single-line buttons, a grid of cards."
 *
 *   A  Busayo Store as the shop has them (they owe the shop): the actions are cards two to a row,
 *      and there is no "What you owe them".
 *   B  The same account, read back as if the shop owed them N5,000 and held a N3,000 deposit — the
 *      read is answered by the probe, nothing is written: the two cards appear, with their figures,
 *      and each opens the screen that settles it.
 *
 *     node scripts/probe-account-cards-ui.mjs [http://localhost:3100]
 */

import { chromium, webkit } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad';
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

let pretend = false;
await p.route('**/rest/v1/rpc/customer_account*', async (route) => {
  const res = await route.fetch();
  if (!pretend) return route.fulfill({ response: res });
  const body = await res.json();
  const acc = Array.isArray(body) ? body[0] : body;
  const shaped = { ...acc, balance: -5000, deposits_held: 3000 };
  await route.fulfill({ response: res, json: Array.isArray(body) ? [shaped] : shaped });
});

const tileGroups = () =>
  p.evaluate(() => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    const pages = [...(active?.querySelectorAll('.navstack-page') ?? [])];
    const page = pages[pages.length - 1];
    return [...(page?.querySelectorAll('[class*="tiles"]') ?? [])].map((grid) => {
      const tiles = [...grid.querySelectorAll('button')];
      const tops = new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().top)));
      return {
        heading: (grid.previousElementSibling?.textContent ?? '').trim(),
        tiles: tiles.map((t) => (t.textContent ?? '').replace(/\s+/g, ' ').trim()),
        perRow: tiles.length / Math.max(1, tops.size),
      };
    });
  });

// The account page, from People (Money's list opens a statement instead).
const openBusayo = async () => {
  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /Everyone you sell to/ }).locator('visible=true').first().click();
  await p.waitForTimeout(3500);
  await p.getByText('Busayo Store').locator('visible=true').first().click();
  await p.waitForTimeout(5000);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(8000);

  console.log('A  as the shop has them');
  await openBusayo();
  let groups = await tileGroups();
  await p.screenshot({ path: `${SHOTS}/account-cards.png`, fullPage: false });
  const actions = groups.find((g) => /On this account/.test(g.heading));
  check('the actions are a grid of cards', Boolean(actions) && actions.tiles.length >= 5, JSON.stringify(actions?.tiles));
  check('… two to a row', actions?.perRow === 2, String(actions?.perRow));
  check('no "What you owe them" when the shop owes nothing', !groups.some((g) => /What you owe them/.test(g.heading)));

  console.log('B  if the shop owed them');
  pretend = true;
  await p.goBack({ waitUntil: 'commit' }).catch(() => {});
  await p.waitForTimeout(2000);
  await p.getByText('Busayo Store').locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  groups = await tileGroups();
  await p.screenshot({ path: `${SHOTS}/account-cards-owe.png`, fullPage: false });
  const owe = groups.find((g) => /What you owe them/.test(g.heading));
  check('"What you owe them" appears', Boolean(owe), JSON.stringify(groups.map((g) => g.heading)));
  check('… with the money to give back', Boolean(owe?.tiles.some((t) => /Money.*5,000.*Give it back/.test(t))), JSON.stringify(owe?.tiles));
  check('… and the deposit held', Boolean(owe?.tiles.some((t) => /Their deposit.*3,000/.test(t))), JSON.stringify(owe?.tiles));
  await p.getByRole('button', { name: /Their deposit/ }).first().click();
  await p.waitForTimeout(3500);
  const t = await p.evaluate(() => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    const pages = [...(active?.querySelectorAll('.navstack-page') ?? [])];
    return (pages[pages.length - 1]?.querySelector('h1')?.textContent ?? '').trim();
  });
  check('the deposit card opens the deposit screen', /Deposit/i.test(t), t);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/account-crash.png` }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
