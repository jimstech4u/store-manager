/** Walk the settings tab and print every console error and page exception verbatim. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const raw = fs.readFileSync('.env.local', 'utf8');
const env = (k) => (raw.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]?.trim().replace(/^"|"$/g, '');

const b = await chromium.launch();
const p = await (
  await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
).newPage();

p.on('pageerror', (e) => console.log('PAGEERROR:', e.message.split('\n').slice(0, 6).join(' | ')));
p.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 400));
});

await p.goto(BASE + '/login', { waitUntil: 'networkidle' });
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p
  .locator('input[type="password"]')
  .first()
  .evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);

await p.evaluate(() => {
  document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 120; });
});
await p.waitForTimeout(400);
await p.evaluate(() => {
  document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { c.scrollTop = 0; });
});
await p.waitForTimeout(900);

console.log('--- opening More');
await p.getByRole('button', { name: 'More', exact: true }).first().click();
await p.waitForTimeout(2500);
console.log('  body:', (await p.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | '));

for (const label of [/bank|money is collected/i, /team|staff|who can/i, /waiting for you|approve/i]) {
  console.log('--- opening', String(label));
  const row = p.locator('button:visible').filter({ hasText: label }).first();
  if (!(await row.count())) {
    console.log('  (no row matched)');
    continue;
  }
  await row.click();
  await p.waitForTimeout(2500);
  console.log('  body:', (await p.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | '));
  await p.goBack();
  await p.waitForTimeout(1800);
}

await b.close();
