/**
 * A customer's history reads the ledgers the shop keeps now (0156), and each line opens its record.
 *
 * It read the retired pool tables, so deposits taken since 0109, containers brought back, charges
 * and opening debts were missing from "Everything that has happened". This opens a customer who has
 * deposits and returns, checks those lines are there, follows one to its ledger and comes back.
 *
 *     node scripts/probe-account-history.mjs [customer name] [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const NAME = process.argv[2] ?? 'Irekanmi 019481';
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const heading = () =>
  p.evaluate(() =>
    [...document.querySelectorAll('h1')]
      .filter((h) => h.offsetParent !== null)
      .map((h) => h.innerText.trim())
      .join(' / '),
  );
const topText = () =>
  p.evaluate(() => {
    const pages = [...document.querySelectorAll('.navstack-page')].filter((c) => c.offsetParent !== null);
    return (pages[pages.length - 1] ?? document.body).innerText.replace(/\s+/g, ' ');
  });

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(14000);

  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(1500);
  await p.getByRole('button', { name: /everyone you sell to/i }).locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  const row = p.getByRole("button", { name: new RegExp(NAME) }).locator("visible=true").first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await p.waitForTimeout(7000);
  check('the account opened', (await heading()).includes(NAME), await heading());

  const text = await topText();
  check('a deposit line is in the history', /Deposit (taken|given back|kept)/.test(text));
  check('containers brought back are in the history', /Containers (brought back|written off|taken)/.test(text));
  check('the account offers its statement', (await p.getByRole('button', { name: /Statement/ }).count()) > 0);

  const seeDeposit = p.getByRole('button', { name: /See the deposit/ }).locator('visible=true').first();
  check('a deposit line opens the deposit', (await seeDeposit.count()) > 0);
  if (await seeDeposit.count()) {
    await seeDeposit.scrollIntoViewIfNeeded();
    await seeDeposit.click();
    await p.waitForTimeout(5000);
    check('… and lands on it', /Deposit/.test(await heading()), await heading());
    const up = p.getByRole('button', { name: /Their account/ }).locator('visible=true').first();
    check('the deposit page points back up to the account', (await up.count()) > 0);
    await p.getByRole('button', { name: /go back/i }).locator('visible=true').first().click();
    await p.waitForTimeout(3000);
    check('back returns to the account', (await heading()).includes(NAME), await heading());
  }

  await p.getByRole('button', { name: /Statement/ }).locator('visible=true').first().click();
  await p.waitForTimeout(6000);
  const st = await topText();
  check('the statement lists the rest of the account', /Everything else on this account/.test(st));
} catch (e) {
  console.log('STOPPED:', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
