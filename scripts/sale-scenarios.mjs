/**
 * Drive the sale screen the way a seller does — clicking and scrolling, not calling RPCs.
 *
 * The database suites prove the ledger is right. They cannot see a quantity field rendered at
 * zero width, a dialog that lets taps through to the page behind it, or a button that vanishes at
 * the moment it is needed. Every one of those shipped and was found by looking, so looking is now
 * part of the build.
 *
 * Each scenario asserts and screenshots. A scenario that cannot find its control FAILS rather
 * than skipping: a silent skip is how a suite reports success for a screen it never opened.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2];
const OUT = path.join(process.cwd(), 'shots', 'scenarios');
fs.mkdirSync(OUT, { recursive: true });

const raw = fs.readFileSync('.env.local', 'utf8');
const env = (k) => (raw.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]?.trim().replace(/^"|"$/g, '');

/**
 * Bring the tab bar back before reaching for it.
 *
 * The bar autohides on a downward scroll, so after working down a long page it is translated off
 * the bottom of the screen and Playwright reports the tab as "outside of the viewport". A person
 * scrolls up to get it back; so does this.
 *
 * Every visible scroll container is scrolled, not just the one that looks scrollable: the page in
 * front may not be the one that was scrolled, and the bar only re-reveals on an upward event from
 * whichever container it last heard from. Then it waits for the bar to actually return rather than
 * assuming a fixed delay covers the transition.
 */
async function revealTabs(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => {
      if (c.scrollTop > 0) c.scrollTop = 0;
    });
  });
  await page
    .waitForFunction(() => {
      const nav = document.querySelector('nav.navigation-bar');
      if (!nav) return true;
      const m = getComputedStyle(nav).transform;
      return m === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(m);
    }, undefined, { timeout: 5000 })
    .catch(() => {});
  await page.waitForTimeout(300);
}


const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
};

/** The money on a line, as a number, so totals can actually be asserted. */
const money = (text) => Number(String(text).replace(/[^0-9.]/g, ''));

/**
 * The quantity input, located structurally rather than by its label.
 *
 * `getByLabel('Quantity')` resolves through a `useId`-generated `for`/`id` pair, and that id is
 * regenerated when the line re-renders — so the locator went stale the moment a scenario changed
 * the line it was reading. The stepper wrapper is stable.
 */
const qtyInput = (page) => page.locator('[class*="stepperField"] input').first();

async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
  await page.locator('input[type="password"]').first().evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, env('SAMPLE_PASSWORD'));
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(6500);
}

async function openSell(page) {
  await revealTabs(page);
  await page.getByRole('button', { name: 'Sell' }).first().click();
  await page.waitForTimeout(1500);
  const start = page.getByRole('button', { name: 'Start a customer' }).first();
  if (await start.count()) {
    await start.click();
    await page.waitForTimeout(1200);
  }
}

async function addProduct(page, term, name) {
  await page.getByRole('button', { name: /Add an item/i }).first().click();
  await page.waitForTimeout(900);
  await page.getByLabel('Search products').first().fill(term);
  await page.waitForTimeout(1500);
  /*
   * Scoped to the picker rows. A by-name lookup matches the line's own "Remove Coca-Cola PET
   * 60cl" button too, and that button comes FIRST in the DOM — so `.first()` was deleting the
   * line it was supposed to be adding to, and the scenario blamed the app for it.
   */
  await page.locator('[class*="pickItem"]').filter({ hasText: new RegExp(name) }).first().click();
  await page.waitForTimeout(1200);
}

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  await signIn(page);
  await openSell(page);

  // ── 1 · A full pack ─────────────────────────────────────────────────────────────
  console.log('\n1. full pack');
  await addProduct(page, 'coca', 'Coca-Cola');

  const qty = qtyInput(page);
  const qtyBox = await qty.evaluate((el) => {
    const cs = getComputedStyle(el);
    return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  });
  check('quantity field has room to draw its value', qtyBox > 20, `${Math.round(qtyBox)}px content box`);
  check('quantity shows 1', (await qty.inputValue()) === '1', await qty.inputValue());

  let lineTotal = money(await page.locator('[class*="lineTotalValue"]').first().innerText());
  check('full pack line total is 4500', lineTotal === 4500, String(lineTotal));
  await shot(page, '01-full-pack');

  // ── 2 · Adding the same item again bumps the line ───────────────────────────────
  console.log('\n2. same item twice');
  await addProduct(page, 'coca', 'Coca-Cola');
  await shot(page, '02-merged-line');
  // `lineName` is also used by the product PICKER rows, so counting it alone cannot tell a
  // merged line from a still-open picker. Scope to the line editor.
  const lineCount = await page.locator('[class*="sell-page_line__"]').count();
  console.log('   picker still open:', await page.getByLabel('Search products').count());
  check('still one line, not two', lineCount === 1, `${lineCount} lines`);
  check('quantity went to 2', (await qtyInput(page).inputValue()) === '2');
  lineTotal = money(await page.locator('[class*="lineTotalValue"]').first().innerText());
  check('two packs total 9000', lineTotal === 9000, String(lineTotal));

  // ── 3 · Quick fractions ─────────────────────────────────────────────────────────
  console.log('\n3. quick fractions');
  const half = page.getByRole('button', { name: '½' }).first();
  check('half button offered on a 12-piece pack', (await half.count()) > 0);
  if (await half.count()) {
    // ADDITIVE, and toggleable: the quantity is 2, so tapping ½ makes it 2.5 rather than
    // replacing it with 0.5. Two and a half crates is the request a seller actually gets.
    await half.click();
    await page.waitForTimeout(800);
    check('half is added to the whole number', (await qtyInput(page).inputValue()) === '2.5');
    lineTotal = money(await page.locator('[class*="lineTotalValue"]').first().innerText());
    check('2.5 packs at 4,500 is 11,250', lineTotal === 11250, String(lineTotal));

    // Tapping it again takes the part back off and leaves the whole number.
    await half.click();
    await page.waitForTimeout(800);
    check('tapping it again returns to 2', (await qtyInput(page).inputValue()) === '2');
  }
  await shot(page, '03-fraction-half');

  // ── 4 · Half pack must not read as below cost ───────────────────────────────────
  console.log('\n4. below-cost warning');
  const halfUnit = page.getByRole('button', { name: 'Half pack', exact: true }).first();
  if (await halfUnit.count()) {
    await halfUnit.click();
    await page.waitForTimeout(900);
    const warned = await page.getByText('Below what this cost you').count();
    check('half pack at its own price is NOT flagged below cost', warned === 0, `${warned} warnings`);
  } else {
    check('half pack sale unit present', false, 'not found');
  }
  await shot(page, '04-half-pack-no-warning');

  // ── 5 · A dialog must block the page behind it ──────────────────────────────────
  console.log('\n5. dialog blocks the page');
  await page.locator('[class*="customerChip"]').first().click();
  await page.waitForTimeout(1200);
  const dialog = page.locator('[role="dialog"]').first();
  check('customer dialog opened', (await dialog.count()) > 0);
  if (await dialog.count()) {
    const covers = await page.evaluate(() => {
      const back = document.querySelector('[class*="Sheet_backdrop"]');
      if (!back) return null;
      const r = back.getBoundingClientRect();
      return {
        full: Math.round(r.height) >= window.innerHeight - 1 && Math.round(r.width) >= window.innerWidth - 1,
        inBody: back.parentElement === document.body,
      };
    });
    check('backdrop covers the whole viewport', covers?.full === true, JSON.stringify(covers));
    check('sheet is portalled to <body>, not trapped in the page', covers?.inBody === true);

    /*
     * A tap where the tab bar sits must land INSIDE the dialog — on its backdrop or on its own
     * footer, either is correct. The first version of this asserted the backdrop specifically and
     * failed on a sheet whose footer button legitimately covered that point: the app was right and
     * the assertion was too narrow.
     */
    const hit = await page.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 30);
      const sheet = document.querySelector('[class*="Sheet_backdrop"]');
      return { inSheet: !!(el && sheet && (sheet === el || sheet.contains(el))),
               cls: el?.className?.toString?.().slice(0, 50) ?? '' };
    });
    check('tap over the tab bar is captured by the dialog', hit.inSheet === true, hit.cls);
  }
  await shot(page, '05-dialog-blocking');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  // ── 5b · A line with no quantity must not be sellable ───────────────────────────
  console.log('');
  console.log('5b. zero quantity is refused');
  {
    const qty = qtyInput(page);
    await qty.fill('0');
    await page.waitForTimeout(900);
    const flagged = await page.getByText(/Add a quantity, or remove this item/i).count();
    check('the line itself says what is wrong', flagged > 0, `${flagged} markers`);
    const pay = page.getByRole('button', { name: /Take payment/i }).first();
    check('taking payment is blocked', await pay.isDisabled());
    await qty.fill('1');
    await page.waitForTimeout(900);
    check('fixing the quantity unblocks it', !(await pay.isDisabled()));
  }

  // ── 6 · Emptying the receipt still leaves a way out ─────────────────────────────
  console.log('\n6. emptying the receipt');
  const remove = page.locator('[class*="lineRemove"]').first();
  if (await remove.count()) {
    await remove.click();
    await page.waitForTimeout(900);
  }
  check('close-this-tab is still offered with no items',
    (await page.getByRole('button', { name: /Close this tab/i }).count()) > 0);
  check('order code row is still shown',
    (await page.getByText('Order code').count()) > 0);
  await shot(page, '06-empty-receipt');

  // ── 7 · Nothing hides under the floating tab bar ────────────────────────────────
  console.log('\n7. tab bar clearance');
  await revealTabs(page);
  await page.getByRole('button', { name: 'Stock' }).first().click();
  await page.waitForTimeout(2500);
  /*
   * Scroll the STOCK stack's scroll container, not the first one on the page. All six tab stacks
   * stay mounted, so `querySelector('[class*="PageScaffold_body"]')` returns the sell tab's body —
   * the earlier version scrolled that, measured stock, and reported content buried under the tab
   * bar when it had simply never been scrolled to.
   */
  await page.evaluate(() => {
    const list = document.querySelector('[class*="stock-page_list"]');
    const b = list?.closest('[class*="PageScaffold_body"]');
    if (b) b.scrollTop = b.scrollHeight;
  });
  await page.waitForTimeout(1200);
  const clearance = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[class*="stock-page_item"]')];
    const last = items[items.length - 1];
    if (!last) return null;
    const r = last.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { bottom: Math.round(r.bottom), vh: window.innerHeight, reachable: last.contains(el) || last === el };
  });
  check('last stock row is not buried under the tab bar',
    clearance?.reachable === true, JSON.stringify(clearance));
  await shot(page, '07-stock-bottom');

  // ── 8 · Back button on a pushed page ────────────────────────────────────────────
  console.log('\n8. back button');
  await page.getByRole('button', { name: /Coca-Cola/ }).first().click();
  await page.waitForTimeout(2500);
  const back = page.getByRole('button', { name: /Go back|Back/i }).first();
  check('pushed page shows a back button', (await back.count()) > 0);
  await shot(page, '08-product-page');
  if (await back.count()) {
    await back.click();
    await page.waitForTimeout(1500);
    check('back returns to the stock list',
      (await page.getByLabel('Search your stock').count()) > 0);
  }

  check('no uncaught page errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('failing:');
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    process.exit(1);
  }
};

run().catch((e) => {
  console.error('HARNESS ERROR:', e.message);
  process.exit(2);
});
