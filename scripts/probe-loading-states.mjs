/**
 * What a page shows WHILE it loads.
 *
 * «when loading in some pages, we have buttons showing like in count page … receipt page has like 4
 *  buttons showing when loading, and many other pages»
 *
 * A fresh browser has nothing cached, so every page is met for the first time. After signing in at
 * full speed, every database call is held for six seconds, and each page is photographed a moment
 * after it opens — which is exactly what a slow connection shows a shop. The body text at that
 * moment is printed too: a button label in it, before the page has anything to act on, is the bug.
 *
 *     node scripts/probe-loading-states.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/loading';
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

const HOLD_MS = 6000;
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

let slow = false;
await p.route('**/rest/v1/**', async (route) => {
  if (slow) await new Promise((r) => setTimeout(r, HOLD_MS));
  await route.continue().catch(() => {});
});

const visible = async () => {
  // Only the page on top: pushed-under pages stay mounted but hidden.
  return p.evaluate(() => {
    const cols = [...document.querySelectorAll('.navstack-page, [data-navstack-page]')];
    const shown = cols.filter((c) => {
      const r = c.getBoundingClientRect();
      const st = getComputedStyle(c);
      return r.width > 0 && r.left >= -1 && r.left < 50 && st.visibility !== 'hidden' && st.display !== 'none';
    });
    const top = shown[shown.length - 1] ?? document.body;
    const buttons = [...top.querySelectorAll('button')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return { text: top.innerText.replace(/\s+/g, ' ').slice(0, 220), buttons };
  });
};

let n = 0;
const snap = async (name) => {
  await p.waitForTimeout(1500);
  n += 1;
  const file = `${SHOTS}/${String(n).padStart(2, '0')}-${name}.png`;
  await p.screenshot({ path: file });
  const v = await visible();
  console.log(`\n[${name}]\n  text: ${v.text}\n  buttons: ${v.buttons.join(' | ')}`);
};
const settle = () => p.waitForTimeout(HOLD_MS + 2500);

const tab = async (label) => {
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(800);
};
const tapText = async (re) => {
  const el = p.getByText(re).locator('visible=true').first();
  await el.scrollIntoViewIfNeeded();
  await el.click();
};
const tapButton = async (re) => {
  const el = p.getByRole('button', { name: re }).locator('visible=true').first();
  await el.click();
};
const back = async () => {
  await p.goBack();
  await p.waitForTimeout(1200);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(14000);

  slow = true;
  console.log(`— every database call now held ${HOLD_MS}ms —`);

  // Stock → an item → its history
  await tab('Stock');
  await p.waitForTimeout(1000);
  await p.locator('[class*="stock-page_itemName"]').first().click();
  await snap('product-page');
  await settle();
  await tapText(/Stock history/i).catch(() => {});
  await snap('stock-history');
  await settle();
  await back();
  await back();

  // Count list → an item's count
  await tapButton(/^Count$/);
  await snap('count-page');
  await settle();
  await p.locator('[class*="count-page_row"]').first().click().catch(() => {});
  await snap('count-entry');
  await settle();
  await back();
  await back();

  // Going off
  await tapButton(/What is going off/i).catch(() => {});
  await snap('expiry-page');
  await settle();
  await back();

  // Money → sales → a receipt; a debtor's statement
  await tab('Money');
  await p.waitForTimeout(1500);
  await tapButton(/All sales and receipts/i).catch(() => {});
  await snap('sales-page');
  await settle();
  await p.locator('button[class*="sales-page_row"]').locator('visible=true').first().click().catch(() => {});
  await snap('receipt-page');
  await settle();
  await back();
  await back();

  // More → customers → an account → empties, deposit, statement
  await tab('More');
  await p.waitForTimeout(1200);
  await tapButton(/everyone you sell to/i).catch(() => {});
  await snap('people-page');
  await settle();
  await p.locator('li button[class*="people-page_row"]').locator('visible=true').first().click().catch(() => {});
  await snap('account-page');
  await settle();
  await tapButton(/^Empties$/).catch(() => {});
  await snap('empties-customer');
  await settle();
  await back();
  await tapButton(/^Deposit$/).catch(() => {});
  await snap('deposit-customer');
  await settle();
  await back();
  await tapButton(/Statement/).catch(() => {});
  await snap('statement-page');
  await settle();
  await back();
  await back();
  await back();

  // Settings pages
  for (const [re, name] of [
    [/your team|staff/i, 'staff-page'],
    [/waiting for you|to check/i, 'review-page'],
    [/this shop/i, 'shop-page'],
  ]) {
    await tapButton(re).catch(() => {});
    await snap(name);
    await settle();
    await back();
  }

  // ══ Back walks back through exactly what was followed — and survives a reload ══
  slow = false;
  console.log('\n— back button: push across records, reload, then walk back —');
  const heading = async () =>
    p.evaluate(() =>
      [...document.querySelectorAll('h1')]
        .filter((h) => h.offsetParent !== null)
        .map((h) => h.innerText.trim())
        .join(' / '),
    );
  const missing = async () => /Missing route/i.test(await p.locator('body').innerText());
  await tab('Money');
  await p.waitForTimeout(1500);
  await tapButton(/All sales and receipts/i);
  await p.waitForTimeout(5000);
  const trail = [await heading()];
  await p.locator('button[class*="sales-page_row"]').locator('visible=true').first().click();
  await p.waitForTimeout(6000);
  trail.push(await heading());
  // Receipt → its item (always there) → that item's stock history
  const item = p.locator('[class*="lineName"] button').locator('visible=true').first();
  if (await item.count()) {
    await item.click();
    await p.waitForTimeout(6000);
    trail.push(await heading());
  }
  console.log('  pushed:', trail.join('  →  '));
  console.log('  url:', decodeURIComponent(p.url()).slice(0, 200));

  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(9000);
  console.log('  after reload:', await heading(), (await missing()) ? '  ✗ MISSING ROUTE' : '  ✓ same page');

  for (let i = 0; i < trail.length; i += 1) {
    const backBtn = p.getByRole('button', { name: /go back/i }).locator('visible=true').first();
    if (!(await backBtn.count())) {
      console.log('  no back button on', await heading());
      break;
    }
    await backBtn.click();
    await p.waitForTimeout(3000);
    console.log('  back →', await heading(), (await missing()) ? '  ✗ MISSING ROUTE' : '');
  }
} catch (e) {
  console.log('STOPPED:', String(e).split('\n')[0]);
} finally {
  if (errors.length) console.log('\npage errors:', errors.slice(0, 5));
  await browser.close();
}
