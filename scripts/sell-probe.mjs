import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE = process.argv[2];
const W = Number(process.argv[3] ?? 390);
const raw = fs.readFileSync('.env.local', 'utf8');
const get = (k) => (raw.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]?.trim().replace(/^"|"$/g, '');

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: W, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.locator('input[type="email"]').first().fill(get('SAMPLE_EMAIL'));
await page.locator('input[type="password"]').first().evaluate((el, v) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, get('SAMPLE_PASSWORD'));
await page.locator('button[type="submit"]').first().click();
await page.waitForTimeout(6000);

await page.getByRole('button', { name: 'Sell' }).first().click();
await page.waitForTimeout(1500);

// Add a product to the order.
const start = page.getByRole('button', { name: 'Start a customer' }).first();
if (await start.count()) { await start.click(); await page.waitForTimeout(1200); }
const add = page.getByRole('button', { name: /Add an item/i }).first();
console.log('add button:', await add.count());
await add.click(); await page.waitForTimeout(1200);
const search = page.getByLabel('Search products').first();
await search.fill('coca');
await page.waitForTimeout(1500);
const hit = page.getByRole('button', { name: /Coca-Cola/ }).first();
console.log('search hit:', await hit.count());
await hit.click();
await page.waitForTimeout(1500);

const probe = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input')];
  const q = inputs.find((i) => (i.getAttribute('aria-label') || i.id || '').length >= 0 &&
    i.closest('div')?.parentElement?.textContent?.includes('Quantity'));
  const labels = [...document.querySelectorAll('label')];
  const qLabel = labels.find((l) => l.textContent.trim() === 'Quantity');
  const qInput = qLabel ? document.getElementById(qLabel.getAttribute('for')) : q;
  if (!qInput) return { found: false, labels: labels.map((l) => l.textContent.trim()) };
  const wrap = qInput.parentElement;
  const affix = [...wrap.children].find((c) => c !== qInput);
  const cs = getComputedStyle(qInput);
  return {
    found: true,
    value: qInput.value,
    inputW: qInput.getBoundingClientRect().width,
    contentW: qInput.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    paddingX: cs.paddingLeft + '/' + cs.paddingRight,
    cssWidth: cs.width, flex: cs.flex, minWidth: cs.minWidth,
    wrapW: wrap.getBoundingClientRect().width,
    affixText: affix?.textContent, affixW: affix?.getBoundingClientRect().width,
  };
});
console.log(JSON.stringify(probe, null, 2));
await page.screenshot({ path: `shots/probe-sell-${W}.png`, fullPage: true });
await b.close();
