/**
 * EACH DAY IN MONEY, AND WHAT WENT BACK ON A DELIVERY AS ONE COMPOSER.
 *
 *   Money: under the period, "Each day" — a row per day with its net total and its cash, transfer,
 *   POS and other (`takings_by_day`, 0275).
 *   Delivery: "Empties that went back" is one choice and one count with an Add button, the added
 *   rows listed above — not a box for every returnable shape on the load. The delivery is NEVER
 *   recorded: the probe adds a line and an empties row, reads the screen, and leaves.
 *
 *     node scripts/probe-days-and-went-back-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const OUT = process.env.SHOTS ?? 'shots';
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
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const recorded = [];
p.on('request', (r) => { if (/rpc\/(record_purchase|record_supplier_empties)/.test(r.url())) recorded.push(r.url()); });
const tab = (name) => p.locator('.nav-item').filter({ hasText: new RegExp(`^${name}$`) }).first().click();

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(6000);

  // ── Money: each day ──
  await tab('Money');
  await p.waitForTimeout(5000);
  const days = p.locator('section[aria-label="Each day, by how it was paid"]').locator('visible=true').first();
  await days.waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
  check('Money shows each day', (await days.count()) > 0);
  await days.scrollIntoViewIfNeeded();
  await p.waitForTimeout(800);
  const rows = await days.locator('li').count();
  const first = (await days.locator('li').first().innerText()).replace(/\s+/g, ' ');
  check('… a row per day, with how it was paid', rows > 0 && /Cash|Transfer|POS|Other/.test(first), `${rows} rows; "${first}"`);
  await p.screenshot({ path: `${OUT}/money-days.png` });

  // ── Delivery: what went back ──
  await tab('Stock');
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: 'Record a delivery' }).locator('visible=true').first().click();
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: /Add (an )?item|Add what came/i }).locator('visible=true').first().click();
  await p.waitForTimeout(1800);
  await p.keyboard.type('33 Bottle');
  await p.waitForTimeout(3000);
  await p.locator('.react-modal-sheet-container').getByText(/^33 Bottle/).locator('visible=true').first().click();
  await p.waitForTimeout(3000);
  // On the load: a quantity, then "Put it on the load" (still nothing recorded).
  await p.getByLabel('How many').locator('visible=true').first().fill('1');
  await p.getByRole('button', { name: /Put it on the load/ }).locator('visible=true').first().click();
  await p.waitForTimeout(2000);
  const section = p.locator('section').filter({ hasText: 'Empties that went back' }).last();
  check('the delivery offers what went back', (await section.count()) > 0);
  const boxes = await section.locator('input').count();
  check('… as ONE count box, not one per shape', boxes === 1, `${boxes} input(s)`);
  const options = await section.locator('select option').count();
  await section.locator('select').selectOption({ index: 1 });
  await section.locator('input').fill('5');
  await section.getByRole('button', { name: /Add what went back/ }).click();
  await p.waitForTimeout(600);
  const added = (await section.locator('ul li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
  check('… the added row is listed above the composer', added.length === 1 && /5/.test(added[0]), JSON.stringify(added));
  check('… and the composer is empty again for the next', (await section.locator('input').inputValue()) === '');
  console.log(`      choices offered: ${options - 1}`);
  await section.scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${OUT}/went-back.png` });

  check('nothing was recorded', recorded.length === 0, recorded.join(', '));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  await p.screenshot({ path: `${OUT}/days-went-back-crash.png` }).catch(() => {});
  failed += 1;
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
