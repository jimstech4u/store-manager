/**
 * BACK STAYS IN ITS TAB, AND NO TAB GOES BLANK — the phone's Back and the app's arrow.
 *
 * "Money stack just went blank … the navigation is breaking on the PWA, I pop on one page, I am on
 * another group." Walked the way a shop does, with interleaved tabs:
 *
 *   A  Stock → a product (deep), Money → Sales (deep), back to Stock, PHONE Back
 *      → still Stock, on its first page; Money still on Sales.
 *   B  Money → Sales, the app's Back arrow tapped twice fast → Money's first page, not blank.
 *   C  Money → Sales, PHONE Back → Money's first page.
 *   D  Stock → a product, the app's arrow → Stock's first page; then PHONE Back does not blank it.
 *
 *     node scripts/probe-tab-back-ui.mjs [http://localhost:3100]
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
/*
 * The till starts a customer by itself when it opens with none, so even a probe that never
 * touches Sell can leave an empty tab on the shop's till. Only what THIS browser saved is closed.
 */
const PROBE_DRAFTS = trackDrafts(p);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

/** The tab on screen, its depth, and whether it is drawing anything. */
const state = () =>
  p.evaluate(() => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    const tab = active?.getAttribute('data-stack-id') ?? '(none)';
    const pages = active ? [...active.querySelectorAll('.navstack-page')] : [];
    const text = (active?.textContent ?? '').trim();
    const h1 = [...(active?.querySelectorAll('h1') ?? [])]
      .filter((h) => h.getBoundingClientRect().width > 0)
      .map((h) => h.textContent?.trim())
      .pop() ?? '?';
    return { tab, pages: pages.length, blank: text.length === 0, h1 };
  });
const depthOf = (stackId) =>
  p.evaluate((id) => {
    const el = document.querySelector(`.group-stack-container[data-stack-id="${id}"]`);
    return el ? el.querySelectorAll('.navstack-page').length : -1;
  }, stackId);

const tab = async (label) => {
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(2500);
};
const phoneBack = async () => {
  await p.goBack({ waitUntil: 'commit' }).catch(() => {});
  await p.waitForTimeout(2500);
};
const arrow = () => p.locator('button[aria-label*="back" i]').locator('visible=true').first();

const openAProduct = async () => {
  await tab('Stock');
  const item = p.getByText(/Goldberg Bottle|Chivita Active|Coca-Cola/).locator('visible=true').first();
  await item.waitFor({ state: 'visible', timeout: 60000 });
  await item.click();
  await p.waitForTimeout(3500);
};
const openSales = async () => {
  await tab('Money');
  await p.locator('button[aria-label="All sales and receipts"]').locator('visible=true').first().click();
  await p.waitForTimeout(3500);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(8000);

  console.log('A  interleaved tabs, phone Back');
  await openAProduct();
  const stockDeep = await state();
  check('Stock opened a product', stockDeep.tab === 'stock-stack' && stockDeep.pages >= 2, JSON.stringify(stockDeep));
  await openSales();
  const moneyDeep = await state();
  check('Money opened Sales', moneyDeep.tab === 'money-stack' && moneyDeep.pages >= 2, JSON.stringify(moneyDeep));
  await tab('Stock');
  await phoneBack();
  const a = await state();
  check('phone Back on Stock’s product stays on Stock', a.tab === 'stock-stack', JSON.stringify(a));
  check('… on Stock’s first page', a.pages === 1 && !a.blank, JSON.stringify(a));
  check('Money still has Sales open', (await depthOf('money-stack')) >= 2);

  console.log('B  Money → Sales, the arrow twice fast');
  await openSales();
  await arrow().click();
  await arrow().click({ timeout: 800 }).catch(() => {});
  await p.waitForTimeout(3000);
  const b = await state();
  check('Money is on its first page and drawing', b.tab === 'money-stack' && b.pages === 1 && !b.blank, JSON.stringify(b));

  console.log('C  Money → Sales, phone Back');
  await openSales();
  await phoneBack();
  const c = await state();
  check('phone Back from Sales is Money’s first page', c.tab === 'money-stack' && c.pages === 1 && !c.blank, JSON.stringify(c));

  console.log('D  Stock → a product, the arrow, then the phone Back');
  await openAProduct();
  await arrow().click();
  await p.waitForTimeout(3000);
  const d1 = await state();
  check('the arrow returns to Stock’s first page', d1.tab === 'stock-stack' && d1.pages === 1, JSON.stringify(d1));
  await phoneBack();
  const d2 = await state();
  check('a further phone Back never leaves a tab blank', !d2.blank && d2.pages >= 1, JSON.stringify(d2));

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
