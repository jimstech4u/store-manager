/**
 * THE FIRST PAGE OF EACH TAB, LOOKED AT AND USED.
 *
 * "This first pages in their respective stack could be better layouted … more professional, and
 * better to use." Money, Stock and Settings were redesigned: named tiles where bare header icons
 * were, Money opening on who OWES (not every customer A to Z), the shelf's worth first on Stock, a
 * row per product with no line starting on a dot, and Settings as headed groups of rows.
 *
 * Screenshots each at a phone's width, and clicks the doors that moved so they still open what
 * they opened.
 *
 *     node scripts/probe-first-pages-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const OUT = process.env.SHOTS ?? '.';
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

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const tab = (name) => p.getByRole('button', { name, exact: true }).last().click();
// The page on top: the stack keeps the pages under it mounted, so the FIRST h1 is the root's.
const onTop = async (re) => {
  for (let i = 0; i < 12; i += 1) {
    const names = await p.locator('h1').evaluateAll((hs) => hs.filter((h) => h.getBoundingClientRect().width > 0 && h.getBoundingClientRect().left >= 0 && h.getBoundingClientRect().left < 300).map((h) => h.textContent ?? ''));
    if (names.some((n) => re.test(n))) return true;
    await p.waitForTimeout(500);
  }
  return false;
};
const shot = (name, full = false) => p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(6000);

  // ── Money ──
  await tab('Money');
  await p.waitForTimeout(5000);
  await shot('first-money');
  check('Money names its doors', await p.getByRole('button', { name: 'All sales and receipts' }).isVisible());
  const owesOn = await p.getByRole('tab', { name: 'Owe you' }).getAttribute('aria-selected');
  check('Money opens on who owes', owesOn === 'true');
  const clearRows = await p.locator('ul li button').filter({ hasText: /Clear$/ }).count();
  check('… so nobody on it is clear', clearRows === 0, `${clearRows} clear`);
  await p.getByRole('tab', { name: 'Everyone' }).click();
  await p.waitForTimeout(3000);
  const everyone = await p.locator('ul li button').count();
  check('Everyone lists every customer', everyone > 0, `${everyone} rows`);
  await p.getByRole('tab', { name: 'Owe you' }).click();
  await p.waitForTimeout(1500);
  await p.getByRole('button', { name: 'All sales and receipts' }).click();
  await p.waitForTimeout(3000);
  check('Receipts opens the sales list', await onTop(/sale|receipt/i));
  await p.goBack();
  await p.waitForTimeout(2000);

  // ── Stock ──
  await tab('Stock');
  await p.waitForTimeout(6000);
  await shot('first-stock');
  check('Stock opens on what the shelf is worth', await p.getByText('Stock is worth').first().isVisible());
  for (const name of ['What is going off', 'When to be told stock is running low', 'Record a delivery', 'Suppliers and what you owe them']) {
    check(`Stock names "${name}"`, await p.getByRole('button', { name }).first().isVisible());
  }
  check('export and print sit on the filter row', (await p.getByRole('button', { name: 'Print', exact: true }).count()) === 1);
  const dotStarts = await p.locator('ul li p').evaluateAll((ps) => ps.filter((x) => /^\s*·/.test(x.textContent ?? '')).length);
  check('no line on a product starts with a dot', dotStarts === 0, `${dotStarts}`);
  await p.getByRole('button', { name: 'Suppliers and what you owe them' }).click();
  await p.waitForTimeout(3000);
  check('Suppliers opens', await onTop(/supplier/i));
  await p.goBack();
  await p.waitForTimeout(2000);

  // ── Settings ──
  await tab('More');
  await p.waitForTimeout(5000);
  await shot('first-settings');
  await shot('first-settings-full', true);
  check('Settings says who is signed in, first', await p.getByText(env.SAMPLE_EMAIL).first().isVisible());
  await p.getByRole('button', { name: /^Count gate$/ }).click();
  await p.waitForTimeout(3000);
  check('Count gate opens', await onTop(/count/i));
  await p.goBack();
  await p.waitForTimeout(2000);

  // ── Dark ──
  await p.emulateMedia({ colorScheme: 'dark' });
  await p.getByRole('button', { name: 'Follow phone' }).click().catch(() => {});
  await p.waitForTimeout(1000);
  await shot('first-settings-dark');
  // Scrolled, the bar folds into a menu button; back at the top it is a bar again.
  await p.evaluate(() => document.querySelectorAll('*').forEach((e) => { if (e.scrollTop > 0) e.scrollTop = 0; }));
  await p.waitForTimeout(1000);
  await tab('Money');
  await p.waitForTimeout(2500);
  await shot('first-money-dark');
  // Leave this device as it was found.
  await tab('More');
  await p.waitForTimeout(2000);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  await shot('first-crash').catch(() => {});
  failed += 1;
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
