/**
 * Back walks back through exactly what was followed — across tabs' pages, and through a reload.
 *
 * «back button presses on some header is broken … sometimes we go to empty page in stack … and the
 *  back button sometimes jump to another stack» / «I could see i pushed aH route name»
 *
 * Every record page is now registered in every tab (`record-pages.tsx`), most of them through
 * navigation-stack's `additionalNavLinks`. Before navigation-stack 0.18.1 a route registered that
 * way was pushed fine but came back from the URL as its raw position code ("aH") on a reload or a
 * browser Back. This follows a chain that crosses from Money into Stock's pages, reloads in the
 * middle, and walks back with the header's own arrow and then the browser's.
 *
 *     node scripts/probe-back-walk.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
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
const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');
const broken = async () => /Missing route/i.test(await body());
const waitFor = async (re, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (re.test(await body())) return true;
    await p.waitForTimeout(300);
  }
  return false;
};
const tab = async (label) => {
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(1500);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(14000);

  // Money → Sales → a receipt → an item on it (a Stock page, pushed onto Money) → its history.
  await tab('Money');
  await p.getByRole('button', { name: /All sales and receipts/i }).locator('visible=true').first().click();
  await waitFor(/Every receipt you have issued/i);
  await p.waitForTimeout(3000);
  const trail = [await heading()];

  await p.locator('button[class*="sales-page_row"]').locator('visible=true').first().click();
  await waitFor(/Receipt/);
  await p.waitForTimeout(4000);
  trail.push(await heading());

  const item = p.locator('[class*="lineName"] button').locator('visible=true').first();
  check('the receipt names its items as links', (await item.count()) > 0);
  await item.click();
  await p.waitForTimeout(5000);
  trail.push(await heading());
  check('an item opens from a receipt in the Money tab', !(await broken()), trail.at(-1));

  const history = p.getByText(/Stock history/i).locator('visible=true').first();
  if (await history.count()) {
    await history.click();
    await p.waitForTimeout(5000);
    trail.push(await heading());
  }
  console.log('  followed:', trail.join('  →  '));
  console.log('  url:', decodeURIComponent(p.url()).slice(0, 220));

  // A reload in the middle: the stack is rebuilt from the URL alone. (NORELOAD=1 skips it.)
  if (!process.env.NORELOAD) {
    const top = await heading();
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(10000);
    check('a reload comes back on the same page', (await heading()) === top && !(await broken()), await heading());
  }

  // The header's own back arrow, one level at a time.
  for (let i = trail.length - 2; i >= 0; i -= 1) {
    const backBtn = p.getByRole('button', { name: /go back/i }).locator('visible=true').first();
    if (!(await backBtn.count())) {
      check(`a back arrow to reach "${trail[i]}"`, false, `none on ${await heading()}`);
      break;
    }
    await backBtn.click();
    await p.waitForTimeout(3000);
    const now = await heading();
    check(`back lands on "${trail[i]}"`, now === trail[i] && !(await broken()), now);
  }

  // And forward again with the browser, then back with the browser.
  await p.goForward();
  await p.waitForTimeout(3000);
  const fwd = await heading();
  await p.goBack();
  await p.waitForTimeout(3000);
  check('browser back after forward returns', (await heading()) === trail[0] && !(await broken()), `${fwd} → ${await heading()}`);
} catch (e) {
  console.log('STOPPED:', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
