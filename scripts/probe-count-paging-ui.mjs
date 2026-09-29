/**
 * DOES THE COUNT LIST REACH EVERY ITEM?
 *
 *     node scripts/probe-count-paging-ui.mjs [http://localhost:3100]
 *
 * Reported twice: "count page does not paginate to load other items". Counting is the one job
 * that has to reach the whole shelf, so a list that stops at the first page means the rest of the
 * catalogue can never be counted at all — and, since the till refuses to sell an item that has
 * not been counted today, cannot be sold either.
 *
 * Scrolling is the test. The rows are in the DOM or they are not, and no amount of reading the
 * hook settles which.
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
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(11000);

  const stockTab = p.getByRole('button', { name: 'Stock', exact: true }).first();
  await stockTab.waitFor({ state: 'visible', timeout: 120000 });
  await stockTab.click();
  await p.waitForTimeout(5000);

  const countBtn = p.getByRole('button', { name: /^Count$/ }).first();
  await countBtn.waitFor({ state: 'visible', timeout: 120000 });
  await countBtn.click();
  await p.waitForTimeout(5000);

  const rows = async () =>
    (await p.getByText(/records say|Counted today/).count());
  const first = await rows();
  console.log(`  the first page shows ${first} items`);
  check('the count list opens with items', first > 0, `${first}`);

  /*
   * SCROLLED THE COLUMN, not the window — the app scrolls `.navstack-column-body`, and a wheel
   * event at the pointer's position goes to whatever is under it, which at 0,0 is the header.
   */
  let last = first;
  for (let i = 0; i < 25; i += 1) {
    await p.evaluate(() => {
      /*
       * THE COLUMN THAT IS ACTUALLY SHOWING.
       *
       * navigation-stack keeps every page in the stack mounted, so there are several
       * `.navstack-column-body` elements and all but one have no height. `querySelector` returns
       * the first, which is one of the empty ones — so the first version of this probe scrolled
       * nothing and reported a pagination bug that was its own.
       */
      const col = [...document.querySelectorAll('.navstack-column-body')]
        .filter((c) => c.scrollHeight > c.clientHeight)
        .pop();
      if (col) col.scrollTop = col.scrollHeight;
    });
    await p.waitForTimeout(700);
    const now = await rows();
    if (now === last && i > 3) break;
    last = now;
  }
  console.log(`  after scrolling to the end: ${last} items`);

  check('the list loads past the first page', last > first, `${first} then ${last}`);

  /*
   * AND IT REACHES THE END OF THE ALPHABET. The shop has 105 active items; the reported symptom
   * was a list that stopped around the G's, so the last of them is the thing to look for.
   */
  const body = await p.locator('body').innerText();
  check('it reaches the far end of the catalogue', /Zetar|Vijn|Turbo King/.test(body),
    last >= 100 ? `${last} rows` : `only ${last} rows`);

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
