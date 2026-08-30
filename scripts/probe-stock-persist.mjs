/**
 * A list must survive being left, and come back DRAWN.
 *
 * A stack page unmounts when another is pushed on top, so a list held anywhere but state-stack
 * comes back EMPTY — the page flashes zero rows, refetches from page one, and loses however far
 * somebody had scrolled. That is what `usePaginatedList` exists to prevent, and this checks it is
 * actually happening on the screen a shop uses most.
 *
 *     node scripts/probe-stock-persist.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/stock-persist';
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

const tab = async (label) => {
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(1000);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(4500);
};

const rows = () => p.locator('[class*="stock-page_itemName"]').count();

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  await tab('Stock');
  const before = await rows();
  check('the stock list loads', before > 0, `${before} rows`);
  await p.screenshot({ path: `${SHOTS}/1-list.png` });

  console.log('\n— push a product, then come straight back —');
  await p.locator('[class*="stock-page_itemName"]').first().click();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/2-product.png` });

  await p.locator('button[aria-label*="back" i]:visible').first().click();
  /*
   * Measured IMMEDIATELY, before any refetch could paper over it.
   *
   * The bug is a blank on the way back: the list eventually refills from the server, so waiting
   * politely for a few seconds is exactly how it goes unnoticed.
   */
  await p.waitForTimeout(400);
  const straightAway = await rows();
  await p.screenshot({ path: `${SHOTS}/3-back-immediately.png` });
  check(
    'it is still drawn the moment the page comes back',
    straightAway > 0,
    `${straightAway} rows, ${400}ms after Back`,
  );

  await p.waitForTimeout(5000);
  const settled = await rows();
  check('and still there once it settles', settled > 0, `${settled} rows`);
  check('with nothing lost', settled >= before, `had ${before}, now ${settled}`);

  console.log('\n— and after a screen that WRITES to the catalogue —');
  /*
   * `catalogChanged()` used to call clearScope, which DELETES every cached value in the scope —
   * and the products list lived in it. So saving anything about a product deleted the list, and
   * coming back gave a full-screen "Loading your stock" with the reader's place gone. It now says
   * the catalogue moved and the list re-reads the span it already had.
   */
  await p.locator('[class*="stock-page_itemName"]').first().click();
  await p.waitForTimeout(4000);

  const opener = p.getByText('How you buy and sell it').first();
  if ((await opener.count()) === 0) {
    console.log('  (no units screen on this item — cannot exercise the write path)');
  } else {
    await opener.click();
    await p.waitForTimeout(4500);

    // Any unanswered "one X is [ ] Y" is filled with 1 so the form will save. The point of this
    // step is the WRITE, not what is written.
    for (const box of await p.locator('[class*="UnitsEditor_sentence"] input').all()) {
      if ((await box.inputValue()).trim() === '') {
        await box.fill('1');
        await p.waitForTimeout(300);
      }
    }
    await p.waitForTimeout(800);

    const save = p.getByRole('button', { name: 'Save' }).first();
    if (await save.isDisabled()) {
      check('the units screen can be saved', false, 'Save disabled');
      await p.locator('button[aria-label*="back" i]:visible').first().click();
      await p.waitForTimeout(3000);
    } else {
      await save.click();
      await p.waitForTimeout(6000);
    }

    await p.locator('button[aria-label*="back" i]:visible').first().click();
    await p.waitForTimeout(400);

    const afterWrite = await rows();
    const blanked = (await p.getByText(/Loading your stock/i).count()) > 0;
    await p.screenshot({ path: `${SHOTS}/4-after-write.png` });

    check(
      'the stock list is still drawn after a catalogue write',
      afterWrite > 0 && !blanked,
      blanked ? 'full-page "Loading your stock"' : `${afterWrite} rows`,
    );
  }

  // ── The same fault, on People ─────────────────────────────────────────────────────
  console.log('\n— People, coming back from somebody\'s account —');
  /*
   * The account page cleared `customer_flow` ON EXIT, and the People list and the customer picker
   * both live in that scope. Nothing was even written: LEAVING a page deleted a list belonging to
   * another page.
   */
  await tab('People');
  const people = () => p.locator(// The People page reuses money-page.module.css, so its rows carry that prefix.
    '[class*="money-page_rowName"]:visible').count();

  const peopleBefore = await people();
  check('the People list loads', peopleBefore > 0, `${peopleBefore} rows`);
  await p.screenshot({ path: `${SHOTS}/5-people.png` });

  await p
    .locator(// The People page reuses money-page.module.css, so its rows carry that prefix.
    '[class*="money-page_rowName"]:visible')
    .first()
    .click();
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `${SHOTS}/6-account.png` });

  await p.locator('button[aria-label*="back" i]:visible').first().click();
  await p.waitForTimeout(400);
  const peopleAfter = await people();
  await p.screenshot({ path: `${SHOTS}/7-people-back.png` });

  check(
    'and is still drawn the moment it comes back',
    peopleAfter > 0,
    `${peopleAfter} rows, 400ms after Back`,
  );
  check('with nothing lost', peopleAfter >= peopleBefore, `had ${peopleBefore}, now ${peopleAfter}`);
} finally {
  await browser.close();
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
