/**
 * QUANTITIES SAID IN SHAPES — stock history and the low-stock page. Looks only.
 *
 *     node scripts/probe-shapes-said-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const MALTA = 'cba8c191-102a-4fc5-a4f5-045bf7bfaa91';
const SHOTS = 'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/shapes-said';
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

  await p.evaluate((id) => window.__NAV_STACK__.push('sell-stack', 'stock_history_page', { id }), MALTA);
  await p.waitForTimeout(6000);
  await p.screenshot({ path: `${SHOTS}/1-history.png`, fullPage: true });
  const t = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('the opening reads in cans and pieces', /133 cans 12 pieces/i.test(t), (t.match(/\+[^·]{0,30}/) ?? [''])[0]);
  check('no 3,204 pieces anywhere', !/3,?204/.test(t));

  await p.evaluate(() => window.__NAV_STACK__.push('sell-stack', 'low_stock_page'));
  await p.waitForTimeout(5000);
  await p.screenshot({ path: `${SHOTS}/2-low-stock.png`, fullPage: true });
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}
console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
