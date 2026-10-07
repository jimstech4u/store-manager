/**
 * ANY LIST, ON THE RECEIPT PRINTER OR SHARED.
 *
 * "In the bank account page we should have actions to print as well (even to the printer on
 * Bluetooth like receipt); and print histories, statements, reports to printer just like receipt,
 * not only PDF or CSV, and share as well, even with prices."
 *
 * Opens three of them and reads what `print_page` draws — the roll as it will print — and checks it
 * offers what a receipt offers. Prints nothing and shares nothing; it reads.
 *
 *     node scripts/probe-print-share-ui.mjs [http://localhost:3100]
 */
import { chromium, webkit } from '@playwright/test';
import { readFileSync } from 'node:fs';

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
p.on('pageerror', (e) => errors.push(String(e.stack ?? e).split('\n').slice(0, 4).join(' ')));
p.on('console', (m) => {
  // The CSP report-only notice is the browser describing the policy, not a fault on the page.
  if (m.type() === 'error' && !/Content Security Policy/.test(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`);
});
const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const paper = async () =>
  ((await top().locator('[data-print-root]').first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
const offersAll = async () => {
  const want = ['Share', 'Send on WhatsApp', 'Send as picture', 'Print', 'Save as PDF'];
  const has = [];
  for (const w of want) has.push((await top().getByRole('button', { name: new RegExp(`^${w}`) }).count()) > 0);
  return has.every(Boolean);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(8000);

  // ── Bank accounts ───────────────────────────────────────────────────────────────────────
  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(2500);
  await top().getByRole('button', { name: /Bank accounts/ }).first().click();
  await p.waitForTimeout(4000);
  await top().getByRole('button', { name: /^Print or share the .* account$/ }).first().click();
  await p.waitForTimeout(4000);
  let t = await paper();
  check('a bank account prints as "Pay into" with its number', /PAY INTO/.test(t) && /\d{10}/.test(t), t.slice(0, 120));
  check('with everything a receipt offers', await offersAll());
  await p.screenshot({ path: `${SHOTS}/print-bank.png`, fullPage: true });
  await p.goBack();
  await p.waitForTimeout(2500);
  await p.goBack();
  await p.waitForTimeout(2500);

  // ── Stock, with prices ──────────────────────────────────────────────────────────────────
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(4000);
  await top().getByRole('button', { name: /^Print$/ }).first().click();
  await p.waitForTimeout(12000);
  t = await paper();
  check('the stock list prints with what is left and the prices', /STOCK AND PRICES/.test(t) && /left/.test(t) && /Crate N[\d,]+/.test(t),
    (t.match(/.{0,40}left.{0,60}/) ?? [t.slice(0, 120)])[0]);
  check('and offers the same', await offersAll());
  await p.screenshot({ path: `${SHOTS}/print-stock.png`, fullPage: true });

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/print-share-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  console.log('  page errors:', errors.slice(0, 4).join(' || '));
  failed += 1;
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
