/**
 * THE KEYBOARD FLAG FOLLOWS THE KEYBOARD (12 Nov, navigation-stack 1.12.1) — looked at, nothing typed.
 *
 * After an item was added, the till's box was focused again from code; iOS raised no keyboard, but
 * the flag opened for the focus and the tab bar and floating buttons stayed hidden. On a phone-sized
 * page with touch:
 *   1. the box focused from code: the flag stays closed and the tab bar shows;
 *   2. the box tapped: the flag opens at once (the keyboard is on its way);
 *   3. no keyboard comes (a headless browser has none): it closes again within the head start.
 *
 *     node scripts/probe-keyboard-flag.mjs [http://localhost:3100]
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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const p = await ctx.newPage();
const flag = () => p.evaluate(() => document.documentElement.getAttribute('data-ax-keyboard'));
const box = () => p.locator('input[placeholder^="Type to add"]').locator('visible=true').first();
try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(6000);
  // On a phone the tab bar's Sell, not the sidebar's.
  await p.getByText('Sell', { exact: true }).locator('visible=true').first().click();
  await box().waitFor({ timeout: 60000 });
  await p.waitForTimeout(1500);
  // The box blurred, as after a tap on a result.
  await p.evaluate(() => (document.activeElement)?.blur?.());
  await p.waitForTimeout(300);
  check('nothing focused: closed', (await flag()) === null);

  // 1. Focused from code, as QuickAdd does after an item is added.
  await box().evaluate((el) => el.focus());
  await p.waitForTimeout(300);
  const focused = await p.evaluate(() => document.activeElement?.getAttribute('placeholder') ?? '');
  check('the box is focused', /^Type to add/.test(focused));
  check('focused from code: the flag stays closed', (await flag()) === null, String(await flag()));
  await p.waitForTimeout(1300);
  check('and is still closed a moment later', (await flag()) === null);
  await p.evaluate(() => (document.activeElement)?.blur?.());
  await p.waitForTimeout(300);

  // 2. Tapped: the keyboard is on its way, so it opens at once.
  await box().tap();
  await p.waitForTimeout(150);
  check('tapped: the flag opens at once', (await flag()) === 'open', String(await flag()));
  // 3. No keyboard ever measures here: the head start runs out.
  await p.waitForTimeout(1400);
  check('no keyboard came: closed again', (await flag()) === null, String(await flag()));
  await p.evaluate(() => (document.activeElement)?.blur?.());
} catch (e) {
  console.log('ERROR', e?.message ?? e);
  failed += 1;
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : '\nAll passed');
process.exit(failed ? 1 : 0);
