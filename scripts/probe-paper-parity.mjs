/**
 * THE SAME PAPER FROM THE APP AND FROM THE AGENT.
 *
 * "Why is the PDF and image different to what the app does? Can we reuse the same?" Opens a real
 * receipt, presses "Send as picture" and "Save as PDF" as a seller would, and keeps the files the app
 * makes. `parity-render` then draws the same receipt with the agent's renderer, and the two pictures
 * are compared: the same size, the same lines, differing only where a phone's font and the server's do.
 * Reads only.
 *
 *     node scripts/probe-paper-parity.mjs <out-dir> [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2];
const BASE = process.argv[3] ?? 'http://localhost:3100';
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const browser = await chromium.launch();
const ctxt = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
const p = await ctxt.newPage();
// No share sheet in a test browser: the app downloads the file instead, which is what is kept.
await p.addInitScript(() => {
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
});
const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();

await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
await p.locator('button[type="submit"]').first().click();
await p.waitForURL(/\/main/, { timeout: 90000 });
await p.waitForTimeout(8000);
await p.locator('button[aria-label="All sales and receipts"]').locator('visible=true').first().click();
await p.waitForTimeout(5000);
await top().getByRole('tab', { name: 'Paid', exact: true }).click();
await p.waitForTimeout(3500);
await top().getByText(/ items?$/).first().click();
await p.waitForTimeout(7000);

const number = ((await top().innerText()).match(/#([0-9A-F]{8})/) ?? [])[1];
const keep = async (button, file) => {
  const [download] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), top().getByRole('button', { name: button }).last().click()]);
  await download.saveAs(`${OUT}/${file}`);
};
await keep(/^Send as picture/, 'app-receipt.png');
await p.waitForTimeout(1500);
await keep(/^Save as PDF/, 'app-receipt.pdf');
console.log(JSON.stringify({ number }));
await browser.close();
