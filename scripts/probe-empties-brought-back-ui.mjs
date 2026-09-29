/**
 * EMPTIES BROUGHT BACK, settled from the line — clicked through on an account.
 *
 * Every line a customer holds offers "All back" (confirmed in a dialog) and "Part" (the empties
 * page, with that line already chosen). Looks only: the dialog is opened and cancelled, and the
 * page is opened and left, so nothing is recorded against a real customer.
 *
 *     node scripts/probe-empties-brought-back-ui.mjs [http://localhost:3100] [customer name]
 */

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const NAME = process.argv[3] ?? 'Funke mama stores';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/empties-back';
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /everyone you sell to/i }).locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  const row = p.getByRole('button', { name: new RegExp(NAME, 'i') }).locator('visible=true').first();
  await row.waitFor({ state: 'visible', timeout: 60000 });
  await row.click();
  await p.waitForTimeout(6000);

  const head = p.getByText('Empties still out', { exact: true }).locator('visible=true').first();
  await head.scrollIntoViewIfNeeded().catch(() => {});
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${SHOTS}/1-account.png` });
  const allBack = p.getByRole('button', { name: 'All back', exact: true }).locator('visible=true');
  const part = p.getByRole('button', { name: 'Part', exact: true }).locator('visible=true');
  check('each line offers All back', (await allBack.count()) > 0, `${await allBack.count()} line(s)`);
  check('and Part', (await part.count()) === (await allBack.count()));

  await allBack.first().click();
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${SHOTS}/2-confirm.png` });
  const t = await p.locator('body').innerText();
  check('All back asks first', /back\?/.test(t) && /Yes, they are back/.test(t));
  await p.getByRole('button', { name: 'Cancel', exact: true }).locator('visible=true').first().click();
  await p.waitForTimeout(1200);

  await part.first().click();
  await p.waitForTimeout(5000);
  await p.screenshot({ path: `${SHOTS}/3-part.png`, fullPage: true });
  const t2 = await p.locator('body').innerText();
  check('Part opens the empties page', /Empties brought back/.test(t2));

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await p.screenshot({ path: `${SHOTS}/last.png`, fullPage: true }).catch(() => {});
  await browser.close();
  console.log(`\n  shots in ${SHOTS}`);
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
