/**
 * A CUSTOMER'S ACCOUNT AND STATEMENT, photographed on a phone and a desktop (10 Nov redesign).
 *
 * The account's two growing lists — Receipts, and everything that has happened — are one at a time
 * behind a switch on a phone and side by side on a desktop; the statement's controls and ways out
 * come before its paper. Read-only.
 *
 *     SHOTS=<dir> node scripts/shots-account.mjs [http://localhost:3100] [customer name]
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const WHO = process.argv[3] ?? 'Lucky';
const SHOTS = process.env.SHOTS ?? 'probe-shots/account';
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
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
for (const [label, viewport, mobile] of [
  ['phone', { width: 390, height: 844 }, true],
  ['desktop', { width: 1440, height: 900 }, false],
]) {
  const p = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
  const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
  const shot = (n) => p.screenshot({ path: `${SHOTS}/${n}-${label}.png` });
  try {
    await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
    await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
    await p.locator('button[type="submit"]').first().click();
    await p.waitForURL(/\/main/, { timeout: 90000 });
    await p.waitForTimeout(7000);
    await p.evaluate(() => {
      const all = [...document.querySelectorAll('.nav-item, aside *, nav *, [class*="idebar"] *')];
      const hit = all.find((n) => n.textContent.trim() === 'More' && n.offsetParent !== null);
      (hit?.closest('button, a, [role="button"], .nav-item') ?? hit)?.click();
    });
    await p.waitForTimeout(2500);
    await top().getByRole('button', { name: /everyone you sell to/i }).first().evaluate((el) => el.click());
    await p.waitForTimeout(4000);
    await top().getByRole('button', { name: new RegExp(WHO) }).first().evaluate((el) => el.click());
    await p.waitForTimeout(6000);

    const lists = top().locator('[data-show]');
    await lists.scrollIntoViewIfNeeded();
    await p.waitForTimeout(800);
    await shot('1-account');
    const shown = async (which) => top().locator(`[data-list="${which}"]`).isVisible();
    if (label === 'phone') {
      check((await shown('receipts')) && !(await shown('history')), 'phone: receipts shown, history behind the switch');
      await top().getByRole('tab', { name: /Everything/ }).click();
      await p.waitForTimeout(600);
      check(!(await shown('receipts')) && (await shown('history')), 'phone: the switch shows everything that has happened');
      await shot('2-account-history');
    } else {
      check((await shown('receipts')) && (await shown('history')), 'desktop: both lists side by side');
    }

    await top().getByRole('button', { name: 'Print or send their statement' }).first().evaluate((el) => el.click());
    await p.waitForTimeout(6000);
    await shot('3-statement');
    const order = await top().evaluate((page) => {
      const y = (el) => (el ? el.getBoundingClientRect().top : -1);
      const share = [...page.querySelectorAll('button')].find((b) => /WhatsApp|Share|PDF|Print/.test(b.textContent ?? ''));
      const paper = page.querySelector('[data-print-root]');
      const x = (el) => (el ? el.getBoundingClientRect().left : -1);
      return { share: y(share), paper: y(paper), shareX: x(share), paperX: x(paper) };
    });
    check(
      order.share >= 0 && order.paper >= 0 && (order.share < order.paper || order.shareX < order.paperX),
      `${label}: the ways out come before the paper (${JSON.stringify(order)})`,
    );
  } catch (e) {
    check(false, `${label} ran — ${e.message.split('\n')[0]}`);
    await shot('error').catch(() => {});
  }
  await p.close();
}
await browser.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
