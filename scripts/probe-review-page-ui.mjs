/**
 * "WAITING FOR YOU" DOES WHAT IT SAYS — looked at, nothing confirmed or undone.
 *
 *     node scripts/probe-review-page-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS = 'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/review';
mkdirSync(SHOTS, { recursive: true });
const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
let failed = 0;
const check = (what, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); if (!ok) failed += 1; };

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await p.addInitScript({ content: 'window.__NAV_STACK_DEVTOOLS__ = true;' });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);
  await p.evaluate(() => window.__NAV_STACK__.push('sell-stack', 'review_page'));
  await p.waitForTimeout(6000);

  const check1 = p.getByRole('button', { name: 'Check the details' }).locator('visible=true').first();
  check('a customer card offers Check the details', (await check1.count()) > 0);
  await check1.click();
  await p.waitForTimeout(5000);
  await p.screenshot({ path: `${SHOTS}/1-customer.png` });
  const nameBox = p.getByRole('textbox').first();
  const val = (await nameBox.count()) ? await nameBox.inputValue() : '';
  check('it opens the customer with their details loaded', val.trim().length > 0, `"${val}"`);
  await p.evaluate(() => window.__NAV_STACK__.pop('sell-stack'));
  await p.waitForTimeout(3000);

  const t = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('stock cards read in shapes, not pieces', !/→\s*\d{3,}\s*→/.test(t));
  const wrong = p.getByRole('button', { name: /Wrong/ }).locator('visible=true').first();
  if (await wrong.count()) {
    await wrong.scrollIntoViewIfNeeded();
    await wrong.click();
    await p.waitForTimeout(1500);
    await p.screenshot({ path: `${SHOTS}/2-wrong.png` });
    const t2 = await p.locator('body').innerText();
    check('Wrong asks first, and says what comes off the shelf', /Undo this/.test(t2) && /shelf/.test(t2));
    await p.getByRole('button', { name: 'Cancel', exact: true }).locator('visible=true').first().click();
    await p.waitForTimeout(1000);
    check('the card offers Open the item', (await p.getByRole('button', { name: 'Open the item' }).count()) > 0);
  }
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}
console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
