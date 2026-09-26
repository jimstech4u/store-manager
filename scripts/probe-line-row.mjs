/**
 * THE LINE ROW STILL BEHAVES, NOW THAT THE TILL AND THE CORRECTION SCREEN SHARE IT.
 *
 * ~300 lines came out of the sell page into `SaleLineRow` so that correcting a settled receipt could
 * work like the till instead of being a second, narrower screen. The row carries the shape chips,
 * the stepper, the on-blur snapping, the part buttons, the bulk-price explanation and the
 * tap-the-total-to-set-the-price behaviour — every one a decision somebody made for a reason, and
 * every one a thing a careless lift would quietly drop.
 *
 * A type-check proves none of it. It would pass just as happily with the stepper wired to the wrong
 * line or the total no longer dividing. So this drives the row on the real till:
 *
 *   · adding an item puts a row on screen
 *   · the stepper changes THAT row's quantity and the line total follows
 *   · a typed quantity is honoured, and the total follows that too
 *   · typing a TOTAL divides it back into a unit price
 *   · removing the row takes it away
 *
 *     node scripts/probe-line-row.mjs [http://localhost:3101]
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const money = (t) => Number(String(t).replace(/[^0-9.]/g, '')) || 0;

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
try {
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.locator('.nav-item').first().waitFor({ state: 'visible', timeout: 180000 });
  await p.waitForTimeout(4000);
  await p.locator('.nav-item').filter({ hasText: /^Sell$/ }).first().click();
  await p.waitForTimeout(6000);

  // ── An item onto the receipt ────────────────────────────────────────────────
  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(4000);
  /*
   * The FIRST product the picker offers, whatever it is — `ProductPicker_item`, which is the class
   * the picker actually gives its rows. Naming a product would make this a test of the sample
   * shop's catalogue, and the row does not care which item it is drawing.
   */
  const firstProduct = p.locator('[class*="ProductPicker_item__"]:visible').first();
  await firstProduct.waitFor({ state: 'visible', timeout: 20000 });
  await firstProduct.click();
  await p.waitForTimeout(5000);

  const row = p.locator('[class*="SaleLineRow_line__"]:visible').first();
  check('adding an item draws a row', (await row.count()) > 0);
  if ((await row.count()) === 0) throw new Error('no row to drive');

  const lineTotal = row.locator('[class*="lineTotalValue"]').first();
  const qtyBox = row.locator('[class*="stepperField"] input').first();
  const plus = row.locator('[class*="stepperButton"]').last();
  const minus = row.locator('[class*="stepperButton"]').first();

  const startQty = await qtyBox.inputValue();
  const startTotal = money(await lineTotal.innerText());
  check('the row shows a quantity and a total', startQty !== '' && startTotal > 0, `${startQty} → ${startTotal}`);

  // ── The stepper ─────────────────────────────────────────────────────────────
  await plus.click();
  await p.waitForTimeout(2500);
  const afterPlus = Number(await qtyBox.inputValue());
  const totalAfterPlus = money(await lineTotal.innerText());
  check('one more raises the quantity', afterPlus === Number(startQty) + 1, `${startQty} → ${afterPlus}`);
  check('and the line total follows it', totalAfterPlus > startTotal, `${startTotal} → ${totalAfterPlus}`);

  await minus.click();
  await p.waitForTimeout(2500);
  check('one less puts it back', Number(await qtyBox.inputValue()) === Number(startQty), await qtyBox.inputValue());

  // ── A typed quantity ────────────────────────────────────────────────────────
  await qtyBox.fill('4');
  await qtyBox.blur();
  await p.waitForTimeout(3000);
  const typedTotal = money(await lineTotal.innerText());
  check('a typed quantity is kept', Number(await qtyBox.inputValue()) === 4, await qtyBox.inputValue());
  check('and the total is four of them', typedTotal > 0 && typedTotal !== startTotal, String(typedTotal));

  /*
   * ── AND THE TOTAL DIVIDES ITSELF ───────────────────────────────────────────
   *
   * Haggling here happens on the total, not the unit price: "give me the four for thirty-five
   * thousand". The row divides it back. This is the behaviour most likely to be lost in a lift,
   * because nothing else on the screen depends on it.
   */
  await lineTotal.click();
  await p.waitForTimeout(1200);
  const totalField = row.locator('input').filter({ hasNot: p.locator('[type="checkbox"]') }).last();
  await totalField.fill('20000');
  await totalField.blur();
  await p.waitForTimeout(3000);

  const priceBox = row.locator('input[inputmode="decimal"]').nth(1);
  const priceNow = Number(await priceBox.inputValue());
  check(
    'a total typed in divides into a unit price',
    Math.abs(priceNow - 5000) < 1,
    `₦20,000 over 4 → ${priceNow}, expected 5000`,
  );
  check(
    'and the line total reads back as what was asked for',
    Math.abs(money(await lineTotal.innerText()) - 20000) < 1,
    await lineTotal.innerText(),
  );

  await p.screenshot({ path: 'shots/probe-line-row.png', fullPage: true });

  // ── And off again ───────────────────────────────────────────────────────────
  const before = await p.locator('[class*="SaleLineRow_line__"]:visible').count();
  await row.locator('[class*="lineRemove"]').first().click();
  await p.waitForTimeout(3000);
  const after = await p.locator('[class*="SaleLineRow_line__"]:visible').count();
  check('removing the row takes it off', after === before - 1, `${before} → ${after}`);
} catch (e) {
  check('the probe ran to the end', false, String(e).split('\n')[0]);
  await p.screenshot({ path: 'shots/probe-line-row-stopped.png', fullPage: true }).catch(() => {});
} finally {
  await b.close();
  console.log(failed === 0 ? '\n  all good' : '\n  ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
