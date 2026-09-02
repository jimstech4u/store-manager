/**
 * Reloading with a sheet open.
 *
 * navigation-stack keeps the overlay's NAME in the fragment across a reload and stops there —
 * whether a sheet reopens is the consumer's decision. So this asks the shop's own screens what
 * they decided, rather than assuming, and checks the three things that must hold either way:
 *
 *   - the page underneath comes back, not a blank or a root;
 *   - Back does something honest, whichever way the sheet went;
 *   - the URL does not keep naming a sheet that is not on screen.
 *
 *     node scripts/probe-reload-overlay.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/reload-overlay';
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

const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');
const frag = async () => p.evaluate(() => window.location.hash || '');
const nav = async () =>
  p.evaluate(() => new URL(window.location.href).searchParams.get('nav'));

const tab = async (label) => {
  await p.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll('div')) {
      if (el.scrollHeight > el.clientHeight + 40) el.scrollTop = 0;
    }
  });
  await p.waitForTimeout(700);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(3500);
};

/** Is a sheet actually on screen? Asked of the DOM, not of the URL — the URL is what is in doubt. */
const sheetOpen = async () =>
  (await p.locator('[class*="modal-sheet"]:visible, [role="dialog"]:visible').count()) > 0;

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ── One page deep, with a picker open over it ────────────────────────────────
  console.log('\n— a picker, open on a pushed page —');
  await tab('Stock');
  await p.getByRole('button', { name: /Record a delivery|Receive/i }).first().click();
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: /^Add an item$/ }).first().click();
  await p.waitForTimeout(3000);

  check('the picker is open', await sheetOpen());
  const beforeFrag = await frag();
  const beforeNav = await nav();
  check('and it is named in the fragment', beforeFrag.includes('ax='), beforeFrag || '(none)');
  check('with the delivery in the nav param', /stock-stack:1\.a1\./.test(beforeNav ?? ''), beforeNav ?? '');
  await p.screenshot({ path: `${SHOTS}/1-picker-open.png` });

  // ── Reload ──────────────────────────────────────────────────────────────────
  console.log('\n— reloaded —');
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(9000);
  await p.screenshot({ path: `${SHOTS}/2-after-reload.png` });

  const afterText = await body();
  const afterFrag = await frag();
  const reopened = await sheetOpen();

  check(
    'the page underneath came back, not a blank or the tab root',
    afterText.includes('Record a delivery'),
    afterText.slice(0, 80),
  );
  console.log(`    the sheet ${reopened ? 'REOPENED' : 'did not reopen'}; fragment is ${afterFrag || '(none)'}`);

  /*
   * Either answer is defensible — reopening restores where you were, not reopening is a clean
   * slate. What is NOT defensible is the URL naming a sheet that is not on screen: the next thing
   * to read that fragment concludes something is open when nothing is, and a Back press then goes
   * somewhere the shop cannot predict.
   */
  check(
    'the URL and the screen agree about whether a sheet is open',
    reopened === afterFrag.includes('ax='),
    `screen says ${reopened ? 'open' : 'closed'}, URL says ${afterFrag.includes('ax=') ? 'open' : 'closed'}`,
  );

  // ── Back, whichever way it went ─────────────────────────────────────────────
  console.log('\n— and Back —');
  await p.goBack();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/3-after-back.png` });

  const backText = await body();
  check(
    'Back leaves the shop somewhere real',
    backText.replace(/Sell|Stock|Count|Money|People|More/g, '').trim().length > 20,
    backText.slice(0, 80) || '(blank)',
  );
  check('and no sheet is left named in the URL', !(await frag()).includes('ax='), (await frag()) || '(none)');

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
