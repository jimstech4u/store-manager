/**
 * Tapping the tab you are already on.
 *
 * The gesture is "take me to the top of this stack" — the shop's way out of a pushed page without
 * hunting for a back arrow. A probe hit a BLANK Stock tab doing it from a half-entered delivery,
 * which is the worst possible outcome: no page, no way back, and the delivery gone.
 *
 *     node scripts/probe-tab-reselect.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/reselect';
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
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

// Scroll reset first: this app scrolls an inner pane, and a tab tapped mid-scroll fails as
// "outside the viewport" about one run in three.
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

const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ── One page deep, from the root of a tab ────────────────────────────────────
  await tab('Stock');
  await p.getByRole('button', { name: /Record a delivery|Receive/i }).first().click();
  await p.waitForTimeout(4000);
  check('a delivery is open', (await body()).includes('Record a delivery'));
  await p.screenshot({ path: `${SHOTS}/1-pushed.png` });

  // ── The gesture ─────────────────────────────────────────────────────────────
  await tab('Stock');
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${SHOTS}/2-reselected.png` });

  const after = await body();
  check(
    'reselecting the tab lands on a page, not a blank',
    after.replace(/Sell|Stock|Count|Money|People|More/g, '').trim().length > 20,
    after.slice(0, 140) || '(blank)',
  );
  check('and that page is the top of the stack', /What you have|Stock is worth|Record a delivery/i.test(after), after.slice(0, 90));

  // ── Twice more, because the second is where it broke ────────────────────────
  await tab('Stock');
  await p.waitForTimeout(2000);
  const again = await body();
  check(
    'and again, from the root, changes nothing',
    /What you have|Stock is worth/i.test(again),
    again.slice(0, 90) || '(blank)',
  );
  await p.screenshot({ path: `${SHOTS}/3-again.png` });


  // ── And the same gesture after visiting another tab that is ALSO deep ──────────
  /*
   * The sequence a probe actually hit: count something (which pushes a page in the Count stack),
   * come back to Stock (which is still holding a delivery), and reselect. The simple version of
   * this passes; this one is the one that failed.
   */
  console.log('\n— with another tab left deep as well —');
  await tab('Stock');
  await p.getByRole('button', { name: /Record a delivery|Receive/i }).first().click();
  await p.waitForTimeout(4000);
  check('the delivery is open again', (await body()).includes('Record a delivery'));

  await tab('Count');
  const first = p.locator('[class*="count-page_row"]').first();
  if (await first.count()) {
    await first.click();
    await p.waitForTimeout(4000);
  }
  check('and the count is one page deep', (await body()).includes('Check the shelf'), (await body()).slice(0, 70));
  await p.screenshot({ path: `${SHOTS}/4-count-deep.png` });

  await tab('Stock');
  const back = await body();
  check('tapping Stock returns to the Stock stack', back.includes('Record a delivery'), back.slice(0, 70));

  await tab('Stock');
  await p.waitForTimeout(2500);
  const rooted = await body();
  await p.screenshot({ path: `${SHOTS}/5-reselect-again.png` });
  check(
    'and tapping it again reaches the top of THAT stack, not another tab',
    /Stock is worth/i.test(rooted),
    rooted.slice(0, 70),
  );


  // ── The Back button on a page, after a trip to another tab ────────────────────
  /*
   * Reported in the same breath as the reselect, and the same fault underneath: be on the second
   * page of a stack, visit another tab, come back, press Back — and land in the OTHER tab. Both
   * the library test and this one exist because the arithmetic that answered "how far back" was
   * right about the number and wrong about whose entries it was counting.
   */
  console.log('\n— Back on a pushed page, after visiting another tab —');
  await tab('Stock');
  await p.getByRole('button', { name: /Record a delivery|Receive/i }).first().click();
  await p.waitForTimeout(4000);
  check('the delivery is open once more', (await body()).includes('Record a delivery'));

  await tab('Count');
  const row2 = p.locator('[class*="count-page_row"]').first();
  if (await row2.count()) {
    await row2.click();
    await p.waitForTimeout(4000);
  }
  await tab('Stock');
  check('and Stock still shows it', (await body()).includes('Record a delivery'), (await body()).slice(0, 60));

  await p.getByRole('button', { name: 'Go back' }).first().click();
  await p.waitForTimeout(3500);
  const popped = await body();
  await p.screenshot({ path: `${SHOTS}/6-after-back.png` });
  check(
    'Back lands on the Stock list, not on another tab',
    /Stock is worth/i.test(popped),
    popped.slice(0, 70),
  );

  // ── And the browser's own Back, which is the same journey by the other route ──
  console.log('\n— and the browser’s own Back —');
  await p.getByRole('button', { name: /Record a delivery|Receive/i }).first().click();
  await p.waitForTimeout(4000);
  await tab('Count');
  await tab('Stock');
  await p.goBack();
  await p.waitForTimeout(3500);
  const browserBack = await body();
  await p.screenshot({ path: `${SHOTS}/7-browser-back.png` });
  check(
    'the browser’s Back lands on the Stock list too',
    /Stock is worth/i.test(browserBack),
    browserBack.slice(0, 70),
  );

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
