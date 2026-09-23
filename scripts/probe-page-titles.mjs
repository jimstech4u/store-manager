/**
 * Every screen says what it is.
 *
 * The app is one URL, so before this every screen was one name — the browser's title, the
 * back/forward list and anything reading the document title all said "Store Manager" whether
 * somebody was on the till or in a customer's account. `PageScaffold` already knows each page's
 * name, so no screen had to be changed: it names itself through `nav.title()`.
 *
 * What is checked is the part that can silently regress: the title FOLLOWS navigation — down into a
 * pushed page, back out on a pop, and across a change of tab, where five mounted stacks could each
 * think they own the title.
 *
 *     node scripts/probe-page-titles.mjs [http://localhost:3101]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const thrown = [];
p.on('pageerror', (e) => thrown.push(String(e).split('\n')[0]));

const title = () => p.title();

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(15000);

  const onTill = await title();
  check('the till says what it is', /sell/i.test(onTill), onTill);

  // ── Down into a pushed page ──────────────────────────────────────────────────────
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(6000);
  const onStock = await title();
  check('changing tab changes the name', /stock/i.test(onStock), onStock);
  check('and one tab does not keep another tab’s name', onStock !== onTill, `${onTill} → ${onStock}`);

  // Whatever opens a page: click candidates until the stack actually deepens. Naming a specific
  // row would tie this probe to the shop's data, which changes.
  const depth = () => p.evaluate(() => document.querySelectorAll('[data-nav-uid^="main-group:stock-stack:"]').length);
  const before = await depth();
  const candidates = p.locator('[data-nav-uid^="main-group:stock-stack:"] button:visible');
  const n = await candidates.count();
  let pushed = false;
  for (let i = 0; i < Math.min(n, 30) && !pushed; i += 1) {
    const label = ((await candidates.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (!label || /^go back$/i.test(label)) continue;
    await candidates.nth(i).click().catch(() => {});
    await p.waitForTimeout(3500);
    if ((await depth()) > before) { pushed = true; console.log(`  … pushed via "${label.slice(0, 30)}"`); }
  }
  check('something opened a page', pushed, `depth ${before} → ${await depth()}`);
  const onPushed = await title();
  check('a pushed page brings its own name', onPushed !== onStock, `${onStock} → ${onPushed}`);

  // ── And back out ─────────────────────────────────────────────────────────────────
  await p.goBack();
  await p.waitForTimeout(5000);
  const backOut = await title();
  check('popping restores the name underneath', backOut === onStock, `${onPushed} → ${backOut} (want ${onStock})`);

  // ── Across tabs, where five stacks are mounted at once ───────────────────────────
  await p.locator('.nav-item').filter({ hasText: /^Money$/ }).first().click();
  await p.waitForTimeout(6000);
  const onMoney = await title();
  check('a third tab names itself too', /money|sales|payment/i.test(onMoney) || onMoney !== onStock, onMoney);

  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(6000);
  check('and coming back gives the right one, not the last one to render', (await title()) === onStock, await title());

  check('nothing threw', thrown.length === 0, thrown.slice(0, 2).join(' | '));
} catch (e) {
  console.log('STOPPED:', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
