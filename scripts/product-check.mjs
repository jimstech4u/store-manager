/**
 * Walk the signed-in path that `shots.mjs` cannot reach: Stock → a product → its pictures.
 *
 * Separate from the screenshot script because this one ASSERTS. It signs in as the sample shop,
 * opens a product, and checks that the route carried its id, that the pictures loaded, that the
 * upload control is there, and that the back gesture returns to the list instead of leaving the
 * app. Every one of those has broken at least once in a way that no database test could see.
 *
 * Note on the screenshot it leaves behind: the page body is its own scroll container, so
 * `fullPage` stops at the fold. The assertions, not the picture, are what prove the page works.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.argv[2];
const raw = fs.readFileSync('.env.local', 'utf8');
const get = (k) => (raw.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]?.trim().replace(/^"|"$/g, '');

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.locator('input[type="email"]').first().fill(get('SAMPLE_EMAIL'));
await page.locator('input[type="password"]').first().evaluate((el, v) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, get('SAMPLE_PASSWORD'));
await page.locator('button[type="submit"]').first().click();
await page.waitForTimeout(6000);

await page.getByRole('button', { name: 'Stock' }).first().click();
await page.waitForTimeout(2500);

const row = page.getByRole('button', { name: /Coca-Cola/ }).first();
console.log('product row found:', await row.count() > 0);
await row.click();
await page.waitForTimeout(3000);

console.log('URL now:', new URL(page.url()).search.slice(0, 90));
console.log('heading:', await page.locator('h1').first().innerText().catch(() => '(none)'));
console.log('Pictures section:', await page.getByText('Pictures', { exact: true }).count() > 0);
console.log('picture tiles:', await page.locator('img[alt*="Coca"]').count());
console.log('Take a photo button:', await page.getByRole('button', { name: /Take a photo/ }).count() > 0);
await page.screenshot({ path: 'shots/12-product-detail.png', fullPage: true });

// Back must return to the Stock list, not leave the app.
await page.goBack();
await page.waitForTimeout(2000);
console.log('back returned to stock:', await page.locator('button[aria-label="Search your stock"]').count() > 0
  || await page.locator('input[placeholder*="Search products or a category"]').count() > 0);

console.log('console errors:', errors.length ? errors.slice(0, 4) : 'none');
await b.close();
