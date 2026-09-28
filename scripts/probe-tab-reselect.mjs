/**
 * TAPPING THE TAB YOU ARE ALREADY ON RETURNS THAT TAB TO ITS FIRST PAGE.
 *
 * Reported: two pages deep inside one stack, tapping that stack's own tab switched GROUP instead
 * of popping — and kept doing it on repeated taps.
 *
 * The wiring reads correct on paper, which is exactly why this exists: the bar fires `onChange`
 * AND `onReselect` on a reselect, the stack ids match the tab ids, and the registry is keyed by
 * the plain stack id. So the answer has to come from the running app rather than from the source.
 *
 *     node scripts/probe-tab-reselect.mjs [http://localhost:3101]
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
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
const check = (name, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** The group and stack the URL says we are in, which is the app's own answer. */
const where = (p) => {
  const u = new URL(p.url());
  return { group: u.searchParams.get('group'), nav: u.searchParams.get('nav') };
};

const b = await chromium.launch();
const p = await b.newContext({ viewport: { width: 390, height: 844 } }).then((c) => c.newPage());

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  for (let i = 0; i < 24; i += 1) {
    await p.waitForTimeout(5000);
    if (new URL(p.url()).pathname.startsWith('/main')) break;
  }

  // ── Into Stock, then two pages deep ─────────────────────────────────────
  await p.getByRole('button', { name: 'Stock', exact: true }).first().click();
  await p.waitForTimeout(3500);
  const atStockRoot = where(p);
  console.log(`\n  stock root: group=${atStockRoot.group} nav=${atStockRoot.nav}`);

  // One deep: the first product in the list.
  await p.locator('[class*="rowLink"]:visible, li:visible button:visible').first().click();
  await p.waitForTimeout(4000);
  const oneDeep = where(p);
  console.log(`  one deep  : group=${oneDeep.group} nav=${oneDeep.nav}`);

  // Two deep: whatever that page offers — stock history, or the edit form.
  const deeper = p.locator('button:visible').filter({ hasText: /history|edit|count|receive/i }).first();
  if (await deeper.count()) {
    await deeper.click();
    await p.waitForTimeout(4000);
  }
  const twoDeep = where(p);
  console.log(`  two deep  : group=${twoDeep.group} nav=${twoDeep.nav}`);

  check('going deeper stayed in the same group',
    twoDeep.group === atStockRoot.group,
    `${atStockRoot.group} -> ${twoDeep.group}`);
  check('and the stack actually went deeper',
    twoDeep.nav !== atStockRoot.nav,
    `${atStockRoot.nav} -> ${twoDeep.nav}`);

  // ── THE GESTURE: tap the tab we are already on ──────────────────────────
  await p.getByRole('button', { name: 'Stock', exact: true }).first().click();
  await p.waitForTimeout(3500);
  const afterOne = where(p);
  console.log(`  after tap : group=${afterOne.group} nav=${afterOne.nav}`);

  check('reselecting the active tab did NOT switch group',
    afterOne.group === atStockRoot.group,
    `${twoDeep.group} -> ${afterOne.group}`);
  check('reselecting returned the stack to its root',
    afterOne.nav === atStockRoot.nav,
    `expected ${atStockRoot.nav}, got ${afterOne.nav}`);

  // And again, because the report said repeated taps kept misbehaving.
  await p.getByRole('button', { name: 'Stock', exact: true }).first().click();
  await p.waitForTimeout(3000);
  const afterTwo = where(p);
  check('a second tap at the root changes nothing',
    afterTwo.group === atStockRoot.group && afterTwo.nav === atStockRoot.nav,
    `group=${afterTwo.group} nav=${afterTwo.nav}`);
} catch (e) {
  check('the walk completed', false, String(e).slice(0, 200));
} finally {
  await b.close();
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
