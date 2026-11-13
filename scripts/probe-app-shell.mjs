/**
 * THE SHOP IN app-shell (13 Nov) — looked at, nothing recorded.
 *
 * On a phone (WebKit, iPhone): the tab bar with the four tabs, no sidebar; tabs switch; a tab keeps
 * its page; tapping the open tab goes back to its first page; the floating total sits above the bar.
 * Dark theme: the bar takes the theme's surface. On a laptop: the sidebar, no bar. Screenshots to SHOTS.
 *
 *     node scripts/probe-app-shell.mjs [http://localhost:3100]
 */
import { webkit, devices } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  process.env.SHOTS ??
  'C:/Users/ajibe/AppData/Local/Temp/claude/05612c5dd4a9e57e/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/app-shell';
mkdirSync(SHOTS, { recursive: true });
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);
let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

async function signIn(p) {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 120000 });
  await p.locator('[data-ax-shell="main"]').waitFor({ timeout: 60000 });
  await p.waitForTimeout(5000);
}
const visibleHeadings = (p) =>
  p.evaluate(() => [...document.querySelectorAll('h1,h2')].filter((h) => h.getBoundingClientRect().width > 0).map((h) => h.textContent.trim()).slice(0, 4).join(' | '));

const browser = await webkit.launch();
try {
  console.log('\n— phone —');
  const ctx = await browser.newContext(devices['iPhone 14']);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  pageerror:', String(e).split('\n')[0]));
  await signIn(p);
  const bar = p.locator('[data-ax-shell="main"] .ax-shell__bar');
  const tabs = await bar.locator('text=/^(Sell|Stock|Money|More)$/').allInnerTexts();
  check('the tab bar has the four tabs', tabs.length === 4, tabs.join(', '));
  check('no sidebar on a phone', !(await p.locator('[data-ax-shell="main"] .ax-shell__side').isVisible()));
  await p.screenshot({ path: `${SHOTS}/1-phone-sell.png` });

  await bar.getByText('Stock', { exact: true }).click();
  await p.waitForTimeout(2500);
  const onStock = await visibleHeadings(p);
  check('Stock opens', /Stock/i.test(onStock), onStock);
  await p.screenshot({ path: `${SHOTS}/2-phone-stock.png` });

  await bar.getByText('More', { exact: true }).click();
  await p.waitForTimeout(2000);
  const row = p.getByRole('button', { name: /Receipt and printer|Printing/ }).first();
  if (await row.count()) {
    await row.click();
    await p.waitForTimeout(2500);
    const deep = await visibleHeadings(p);
    await bar.getByText('Sell', { exact: true }).click();
    await p.waitForTimeout(1500);
    await bar.getByText('More', { exact: true }).click();
    await p.waitForTimeout(1500);
    const back = await visibleHeadings(p);
    check('More kept its page across a tab change', back === deep, `${deep} → ${back}`);
    await bar.getByText('More', { exact: true }).click();
    await p.waitForTimeout(1500);
    const root = await visibleHeadings(p);
    check('tapping More again goes to its first page', root !== deep, root);
  } else {
    check('a More row to open', false, 'not found');
  }

  // The floating total sits above the bar, on the Sell page with something on the order — or the
  // bar state at least reached the pills (FloatingAction on Stock).
  await bar.getByText('Stock', { exact: true }).click();
  await p.waitForTimeout(1500);
  const fab = await p.evaluate(() => {
    const barBox = document.querySelector('[data-ax-shell="main"] .ax-shell__bar nav, [data-ax-shell="main"] .ax-shell__bar > *')?.getBoundingClientRect();
    const pills = [...document.querySelectorAll('button, a')].filter((b) => getComputedStyle(b).position === 'fixed' && b.getBoundingClientRect().width > 0)
      .map((b) => ({ text: b.textContent.trim().slice(0, 20), bottom: Math.round(b.getBoundingClientRect().bottom) }));
    return { barTop: barBox ? Math.round(barBox.top) : null, pills };
  });
  console.log('  floating:', JSON.stringify(fab));

  // Dark theme: the bar takes the theme's surface.
  await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await p.waitForTimeout(500);
  const bg = await p.evaluate(() => {
    const el = document.querySelector('[data-ax-shell="main"] .ax-shell__bar');
    return { wrap: getComputedStyle(el).backgroundColor, shell: getComputedStyle(document.querySelector('[data-ax-shell="main"]')).backgroundColor };
  });
  check('dark theme reaches the shell', /23, 29, 28|15, 20, 19/.test(JSON.stringify(bg)), JSON.stringify(bg));
  await p.screenshot({ path: `${SHOTS}/3-phone-dark.png` });
  await ctx.close();

  console.log('\n— laptop —');
  const wide = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const w = await wide.newPage();
  await signIn(w);
  check('the sidebar on a laptop', await w.locator('[data-ax-shell="main"] .ax-shell__side').isVisible());
  check('no tab bar on a laptop', !(await w.locator('[data-ax-shell="main"] .ax-shell__bar').getByText('Stock', { exact: true }).isVisible()));
  await w.locator('[data-ax-shell="main"] .ax-shell__side').getByText('Money', { exact: true }).click();
  await w.waitForTimeout(2500);
  check('the sidebar switches tabs', /Money|Accounts|Cash|Reports/i.test(await visibleHeadings(w)), await visibleHeadings(w));
  await w.screenshot({ path: `${SHOTS}/4-laptop.png` });
  await wide.close();
} catch (e) {
  console.log('ERROR', e?.message ?? e);
  failed += 1;
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : '\nAll passed');
process.exit(failed ? 1 : 0);
