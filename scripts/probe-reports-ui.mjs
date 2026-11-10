/**
 * THE REPORTS PAGE, REBUILT (10 Nov) — every report opens, lines tick in and out, stock is said in
 * its shapes.
 *
 *   1. Each of the four groups (Money, Stock, People, Team) lists its reports, and every report
 *      either shows lines or says nothing matches — never "Could not build that report".
 *   2. Columns tick on and off (remembered); a column off takes its total with it. Lines have no box.
 *   3. Stock is said in shapes ("300 packs 10 pieces"), not one base-unit number.
 *   4. The ways out are there: PDF / picture / printer (DocumentActions) and CSV.
 *
 * Read-only. Screenshots go to SHOTS. (Lines are never ticked out; columns are, since 10 Nov.)
 *
 *     node scripts/probe-reports-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  process.env.SHOTS ??
  'C:/Users/ajibe/AppData/Local/Temp/claude/05612c5dd4a9e57e/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/reports';
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
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const shot = (name, full = false) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
const page = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const tap = (loc) => loc.first().evaluate((el) => el.click());

/** Waits for a report to settle: lines, an empty sheet, or a failure. */
async function settled() {
  for (let i = 0; i < 60; i++) {
    const state = await page().evaluate((el) => {
      if (document.body.innerText.includes('Could not build that report')) return 'failed';
      if (el.querySelector('table tbody tr')) return 'lines';
      if (el.innerText.includes('Nothing matches these filters')) return 'empty';
      return null;
    });
    if (state) return state;
    await p.waitForTimeout(500);
  }
  return 'timeout';
}

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(7000);

  await p.evaluate(() => [...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === 'Money')?.click());
  await p.waitForTimeout(3000);
  await tap(page().getByRole('button', { name: 'Reports to print, share or save' }).or(page().getByRole('button', { name: /Reports you can print/ })));
  await page().getByRole('tablist', { name: 'Kind of report' }).waitFor({ timeout: 20000 });
  await p.waitForTimeout(1500);
  await shot('0-reports-open');

  // ── 1. Every report, every group ──
  for (const group of ['Money', 'Stock', 'People', 'Team']) {
    await tap(page().getByRole('tab', { name: group, exact: true }));
    await p.waitForTimeout(400);
    const names = await page().locator('[aria-pressed]').evaluateAll((els) =>
      els.map((e) => e.querySelector('span')?.textContent ?? ''),
    ).then((all) => all.filter(Boolean));
    for (const name of names) {
      await tap(page().locator('[aria-pressed]').filter({ hasText: name }));
      await p.waitForTimeout(600);
      const state = await settled();
      const rows = await page().locator('table tbody tr').count();
      check(state === 'lines' || state === 'empty', `${group} › ${name}: ${state}${state === 'lines' ? ` (${rows} lines)` : ''}`);
      if (state === 'failed') {
        await p.keyboard.press('Escape');
        await p.waitForTimeout(400);
      }
      await shot(`1-${group}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, true);
    }
  }

  // ── 2 & 3. Everything in stock: shapes, and a column ticked out ──
  await tap(page().getByRole('tab', { name: 'Stock', exact: true }));
  await tap(page().locator('[aria-pressed]').filter({ hasText: 'Everything in stock' }));
  await p.waitForTimeout(600);
  check((await settled()) === 'lines', 'Everything in stock has lines');
  const shelf = await page().locator('table tbody tr td:nth-child(3)').allInnerTexts();
  console.log('     on the shelf, first few:', shelf.slice(0, 6).join(' | '));
  check(shelf.some((t) => /\d+ \D+ \d+ /.test(t)), 'some stock is said in two shapes ("5 crates 6 bottles")');

  // Rows are never ticked out: every line the question matches is on the report.
  check((await page().locator('table tbody input[type="checkbox"]').count()) === 0, 'no tick box on any line');

  const heads = () => page().locator('table thead th').allInnerTexts();
  const figures = () => page().getByLabel('What it comes to').innerText();
  check((await heads()).includes('Worth'), 'Worth is a column to begin with');
  await tap(page().locator('label').filter({ hasText: /^Worth$/ }).locator('input'));
  await p.waitForTimeout(400);
  check(!(await heads()).includes('Worth'), 'unticking Worth takes the column off the report');
  check(!/WORTH AT COST/i.test(await figures()), 'and its total with it');
  await shot('2-worth-off');
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(6000);
  await p.evaluate(() => [...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === 'Money')?.click());
  await p.waitForTimeout(2500);
  if (!(await page().getByRole('tablist', { name: 'Kind of report' }).count())) {
    await tap(page().getByRole('button', { name: 'Reports to print, share or save' }));
    await page().getByRole('tablist', { name: 'Kind of report' }).waitFor({ timeout: 20000 });
  }
  await tap(page().getByRole('tab', { name: 'Stock', exact: true }));
  await tap(page().locator('[aria-pressed]').filter({ hasText: 'Everything in stock' }));
  await p.waitForTimeout(600);
  await settled();
  check(!(await heads()).includes('Worth'), 'the choice is remembered on this phone');
  await tap(page().locator('label').filter({ hasText: /^Worth$/ }).locator('input'));
  await p.waitForTimeout(400);
  check((await heads()).includes('Worth'), 'and ticking it puts it back')

  // ── 4. The ways out ──
  check(await page().getByRole('button', { name: /CSV/ }).count() > 0, 'CSV is offered');
  check(await page().getByRole('button', { name: /PDF/ }).count() > 0, 'PDF is offered');
  await page().getByRole('button', { name: /CSV/ }).first().scrollIntoViewIfNeeded();
  await shot('3-ways-out');

  // The price list keeps its wall poster.
  await tap(page().locator('[aria-pressed]').filter({ hasText: 'Price list' }));
  await p.waitForTimeout(600);
  await settled();
  check(await page().getByRole('button', { name: /poster/ }).count() > 0, 'the price list offers the poster');
  await shot('4-price-list', true);

  check(errors.length === 0, `no page errors ${errors.slice(0, 2).join(' | ')}`);
} catch (e) {
  check(false, `ran — ${e.message.split('\n')[0]}`);
  await shot('error').catch(() => {});
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
