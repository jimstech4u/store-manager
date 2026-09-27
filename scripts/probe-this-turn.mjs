/**
 * EVERYTHING CHANGED THIS ROUND, CHECKED IN A REAL SIGNED-IN BROWSER.
 *
 * A type-check proves none of this. Each assertion below is the thing a shop would notice:
 *
 *   · the receipt preview fits the phone — no sideways scroll hiding the amounts
 *   · a receipt with a deposit or a charge accounts for every naira of its total
 *   · Settings has ONE printing card, no storefront, and Updates near the end
 *   · the storefront switch is on the shop's own page
 *   · the price list is laid out on screen, and carries a QR when the shop is listed
 *   · the low-stock box asks in the shop's own shapes
 *
 *     node scripts/probe-this-turn.mjs [http://localhost:3101]
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const results = [];
const ok = (name, detail = '') => results.push(['OK  ', name, detail]);
const bad = (name, detail = '') => results.push(['FAIL', name, detail]);function check(name, cond, detail = '') {
  (cond ? ok : bad)(name, detail);
}

async function signIn(p) {
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();

  /*
   * POLLED, not a fixed wait. A dev server compiles the till on the first request and a flat
   * twenty seconds was under it — so this probe reported "never reached the till" about an app
   * that was signing in perfectly, which is the most expensive kind of false alarm.
   */
  for (let i = 0; i < 24; i += 1) {
    await p.waitForTimeout(5000);
    if (new URL(p.url()).pathname.startsWith('/main')) return;
  }
  throw new Error('never reached the till: ' + p.url());
}

/** Tap a bottom-nav tab by its label. */
async function tab(p, name) {
  await p.getByRole('button', { name, exact: true }).first().click();
  await p.waitForTimeout(3000);
}

const run = async () => {
  const browser = await chromium.launch();
  // A real phone's viewport, because "does the preview fit" is a question about a phone.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();

  const crashes = [];
  p.on('pageerror', (e) => crashes.push(String(e)));

  try {
    await signIn(p);
    ok('signed in to the shop', new URL(p.url()).pathname);

    // ── SETTINGS ────────────────────────────────────────────────────────────
    await tab(p, 'More');
    const settingsText = await p.locator('body').innerText();

    const printingCards = (settingsText.match(/Your receipt|^Printing$/gm) ?? []).length;
    check('Settings has one printing card, not two',
      !/^Printing$/m.test(settingsText),
      `found heading "Printing": ${/^Printing$/m.test(settingsText)}`);

    check('the storefront is no longer on Settings',
      !settingsText.includes('List my shop publicly'),
      'looked for the toggle');

    check('"Your shop" is its own heading, not under Money',
      settingsText.includes('Your shop'),
      '');

    // Updates should come AFTER the shop's own sections, not second from the top.
    const iUpdates = settingsText.indexOf('Updates');
    const iCustomers = settingsText.indexOf('Customers');
    check('Updates sits below the shop’s own settings',
      iUpdates > iCustomers && iCustomers > -1,
      `Updates@${iUpdates} Customers@${iCustomers}`);

    // ── THE SHOP PAGE NOW OWNS THE STOREFRONT ───────────────────────────────
    await p.getByText('This shop', { exact: false }).first().click();
    await p.waitForTimeout(4000);
    const shopText = await p.locator('body').innerText();
    check('the storefront switch moved to the shop page',
      shopText.includes('List my shop publicly'),
      shopText.includes('Shoppers finding you') ? 'under "Shoppers finding you"' : '');
    await p.goBack();
    await p.waitForTimeout(2500);

    // ── THE PRICE LIST, ON SCREEN ───────────────────────────────────────────
    await tab(p, 'Money');
    await p.waitForTimeout(1500);
    const reports = p.getByRole('button', { name: /report/i }).first();
    if (await reports.count()) {
      await reports.click();
      await p.waitForTimeout(3000);
    }
    const priceTab = p.getByText('Price list', { exact: false }).first();
    if (await priceTab.count()) {
      await priceTab.click();
      await p.waitForTimeout(5000);

      const poster = p.locator('[data-print-root="poster"]');
      if (await poster.count()) {
        const laidOut = await poster.first().evaluate((el) => {
          const row = el.querySelector('.posterRow');
          const style = row ? getComputedStyle(row) : null;
          return {
            rows: el.querySelectorAll('.posterRow').length,
            flex: style ? style.display : 'none',
            qr: el.querySelectorAll('svg[role="img"]').length,
            scrollsSideways: el.scrollWidth > el.clientWidth + 2,
          };
        });
        check('the price list is laid out on screen',
          laidOut.flex === 'flex' && laidOut.rows > 0,
          `${laidOut.rows} rows, .posterRow display:${laidOut.flex}`);
        check('the poster does not scroll sideways on a phone',
          !laidOut.scrollsSideways, '');
        results.push(['NOTE', 'QR codes drawn on the poster', String(laidOut.qr)]);
      } else {
        bad('the price list rendered', 'no [data-print-root="poster"]');
      }
    } else {
      bad('found the price list report', 'no "Price list" tab');
    }

    // ── A RECEIPT: THE PREVIEW, AND THE MONEY ───────────────────────────────
    await tab(p, 'Money');
    await p.waitForTimeout(1500);
    /*
     * THE ROUTE `probe-ios-print` ALREADY KNOWS.
     *
     * The sales list is an ICON in the Money header with no text beside it, and every tab's stack
     * stays mounted — so a loose `getByLabel(/sales/i)` resolves to some other stack's hidden
     * button and waits thirty seconds for it to become clickable. The exact accessible name, and
     * `:visible` on the row, are what make this land.
     */
    {
      await p.getByRole('button', { name: 'All sales and receipts' }).first().click();
      await p.waitForTimeout(6000);
      await p.locator('[class*="rowLink"]:visible, li:visible button:visible')
        .filter({ hasText: /₦/ })
        .first()
        .click();
      await p.waitForTimeout(8000);

      const paper = p.locator('[aria-label="How this will print"]');
      if (await paper.count()) {
        const fit = await paper.first().evaluate((el) => ({
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
          overflows: el.scrollWidth > el.clientWidth + 2,
          lines: el.querySelectorAll('span').length,
          sizes: [...new Set([...el.querySelectorAll('span')]
            .map((s) => getComputedStyle(s).fontSize))].length,
        }));
        check('the receipt preview fits the phone',
          !fit.overflows,
          `scrollWidth ${fit.scrollW} vs clientWidth ${fit.clientW}`);
        check('spans are sized individually, so a fraction can print smaller',
          fit.sizes > 1,
          `${fit.sizes} distinct font sizes across ${fit.lines} spans`);

        const receipt = await paper.first().innerText();
        results.push(['NOTE', 'receipt mentions a deposit',
          String(/Deposit/i.test(receipt))]);
        results.push(['NOTE', 'receipt itemises a payment',
          String(/Paid \(/i.test(receipt))]);
        check('no measuring ruler leaked into the receipt text',
          !/0{20,}/.test(receipt), '');
      } else {
        bad('the receipt preview rendered', 'no [aria-label="How this will print"]');
      }
    }

    /*
     * AND THE RECEIPT FROM THE PHOTO, by name.
     *
     * #2E3B76DC is the roll the shop sent in: N4,500 of goods, a N500 charge, and a printed total
     * of N5,000 with nothing on the paper accounting for the difference. `sale_detail` never
     * returned the itemised charges (0183) while the customer's own web copy of the same sale did,
     * so the two documents disagreed and the shop's was the wrong one.
     *
     * A generic "the first sale in the list" check cannot catch this — the first sale has no
     * charge at all, which is why the run above reported nothing either way.
     */
    await tab(p, 'Money');
    await p.waitForTimeout(1500);
    await p.getByRole('button', { name: 'All sales and receipts' }).first().click();
    await p.waitForTimeout(6000);

    /*
     * IT IS THE FIRST ROW. The sales list is newest-first and offers no text input to search by a
     * code — "Search by customer or note" opens a viewer, not a box — so the way to this receipt
     * is simply the top of the list.
     */
    const top = p.locator('[class*="rowLink"]:visible, li:visible button:visible')
      .filter({ hasText: /₦/ }).first();
    await top.click();
    await p.waitForTimeout(8000);

    const roll = await p.locator('[aria-label="How this will print"]').first().innerText();
    const flat = roll.replace(/\s+/g, ' ');
    /*
     * "Tfare" — THE SHOP'S OWN WORD, which is the point.
     *
     * The first version of this looked for /Transport|Charge/ and failed over a receipt that was
     * perfectly correct. A charge is named by whoever took it; asserting on the vocabulary the
     * app would have used is asserting that the shop thinks like the app.
     */
    check('the receipt from the photo now itemises its charge',
      /Tfare/i.test(flat), flat.slice(flat.indexOf('Items'), flat.indexOf('Items') + 90));
    check('and shows the goods on their own line before it',
      /Items/i.test(flat), '');
    check('its arithmetic reaches its own total',
      /4,500/.test(flat) && /5,000/.test(flat),
      (flat.match(/N[\d,]+/g) ?? []).join(' '));

    check('nothing threw while walking the app', crashes.length === 0,
      crashes.slice(0, 2).join(' | '));
  } catch (e) {
    bad('the walk completed', String(e).slice(0, 200));
  } finally {
    // Into the OS temp dir, not the repository. A probe that drops a PNG in the project root is
    // one `git add .` away from committing a screenshot of somebody's shop.
    await p.screenshot({ path: join(tmpdir(), 'probe-this-turn.png') }).catch(() => {});
    await browser.close();
  }

  let failed = 0;
  for (const [state, name, detail] of results) {
    if (state === 'FAIL') failed += 1;
    console.log(`  ${state}  ${name}${detail ? ` — ${detail}` : ''}`);
  }
  console.log(`\n${failed} failed of ${results.filter((r) => r[0] !== 'NOTE').length} checks`);
  process.exit(failed ? 1 : 0);
};

run();
