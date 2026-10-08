/**
 * A CORRECTED RECEIPT'S HISTORY PRINTS THE WHOLE RECEIPT.
 *
 * "Correct receipt does not carry everything we have on a receipt, like still with you and all."
 * Receipt history drew each version from its stored lines and money only. Now "what it says now"
 * is the receipt itself — Still with you, the balance, the deposit — and every version a correction
 * replaces from 0257 on keeps the whole receipt it was.
 *
 * Mrs Adeola's #C74E799F (corrected once): its history, now, must say what the receipt says.
 *
 *     node scripts/probe-receipt-history-paper-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
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
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e.stack ?? e).split('\n').slice(0, 3).join(' ')));
const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const paperOf = async () =>
  ((await top().locator('[aria-label="How this will print"]').last().innerText().catch(() => '')) ?? '')
    .replace(/₦/g, 'N')
    .replace(/\s+/g, ' ');

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(8000);
  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /everyone you sell to/i }).locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  const row = p.getByRole('button', { name: /Mrs Adeola/ }).locator('visible=true').first();
  await row.waitFor({ state: 'visible', timeout: 60000 });
  await row.click();
  await p.waitForTimeout(7000);
  await top().getByRole('button', { name: /32,150/ }).filter({ hasText: /items? ·/ }).first().evaluate((el) => el.click());
  await p.waitForTimeout(7000);
  const receipt = await paperOf();
  await top().getByRole('button', { name: /What this receipt has said/ }).click();
  await p.waitForTimeout(7000);
  const now = await paperOf();
  check('history opens on what it says now', /N32,150/.test(now), now.slice(0, 120));
  check('with the deposit held, as the receipt has it', /Deposit, held for you\s*N6,000/.test(now), (now.match(/Deposit.{0,30}/) ?? ['none'])[0]);
  check('with Still with you, as the receipt has it', /Still with you/.test(receipt) === /Still with you/.test(now));
  check('and the balance lines the receipt has', /Total owed|Balance|Owed before/.test(receipt) === /Total owed|Balance|Owed before/.test(now));
  await p.screenshot({ path: `${SHOTS}/history-now.png`, fullPage: true });
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/history-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  console.log('  page errors:', errors.slice(0, 3).join(' || '));
  failed += 1;
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
