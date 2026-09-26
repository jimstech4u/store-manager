/**
 * THE LOW-STOCK RULE AND ITS EXCEPTIONS, ON A PAGE A SHOP CAN ACTUALLY USE.
 *
 * Reported as «i could not see where we could set individual stock threshold and … we should not set
 * threshold in settings page, but it should have it own page to manage stock threshold and also we
 * can also even set that in stock items as well in each indivaduil product page».
 *
 * Both halves of that are fair. The general level was one box in Settings, and the exceptions were
 * invisible: an item's own level only ever appeared inside that item's own form, so a shop that had
 * set five of them over three months had no way to find out which five. A setting nobody can list is
 * a setting nobody trusts, and an untrusted warning gets ignored — which is the whole feature gone.
 *
 * What this proves, by walking it:
 *
 *   · the page exists, is reachable from Stock, and shows the shop's level
 *   · a level typed there is kept, and the stock list marks items low because of it
 *   · an item's own level is settable from the ITEM'S page, and beats the shop's
 *   · that exception then appears on the page as a listed exception
 *   · and Settings no longer holds the field, only the way to it
 *
 *     node scripts/probe-low-stock-page.mjs [http://localhost:3101]
 */
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
await db.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await db.rpc('my_membership')).data[0].store_id;

/* Put the shop back exactly as it was found, whatever happens. */
const wasRule = (await db.rpc('low_stock_rule', { p_store_id: storeId })).data ?? null;
const { data: products } = await db.rpc('list_products', { p_store_id: storeId, p_limit: 40 });
const subject = (products ?? []).find((r) => Number(r.on_hand) > 5);
if (!subject) throw new Error('no item with stock to test against');
const { data: before } = await db.rpc('get_product', { p_product_id: subject.id });
const wasOwn = before?.[0]?.own_low_stock_level ?? null;
const onHand = Number(subject.on_hand);
console.log(`  item: ${subject.name}, ${onHand} on hand; shop rule was ${wasRule}`);

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

  // ── Reachable from Stock, which is where the thought occurs ─────────────────
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(6000);
  const wayIn = p.getByRole('button', { name: /When to be told stock is running low/i }).first();
  check('Stock offers a way into the warnings', (await wayIn.count()) > 0);
  await wayIn.click();
  await p.waitForTimeout(5000);

  const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('the page opened', /Running low|When to be told/i.test(await body()), (await body()).slice(0, 90));
  check(
    'and it explains that one level covers everything and any item can differ',
    /Everything you sell/i.test(await body()) && /Items that are different/i.test(await body()),
  );

  // ── A general level, typed and kept ────────────────────────────────────────
  const general = p.getByLabel(/Tell me when an item gets down to/i).first();
  check('the general level is on this page', (await general.count()) > 0);
  await general.fill(String(onHand + 7));
  await p.waitForTimeout(800);
  await p.getByRole('button', { name: /Save this level/i }).first().click();
  await p.waitForTimeout(6000);

  const nowRule = (await db.rpc('low_stock_rule', { p_store_id: storeId })).data;
  check('what was typed reached the shop', Number(nowRule) === onHand + 7, String(nowRule));

  /*
   * AND THE STOCK LIST ACTS ON IT. A level saved that changes nothing on screen is a setting with no
   * consequence, which is the version of this feature that gets reported as broken.
   */
  /*
   * Tapping the ACTIVE tab goes to that stack's root — the reselect gesture — which is the stock list.
   * Waited out generously, because the list genuinely re-reads when a level changes: the rule alters a
   * derived figure on every row and no row-patch describes it.
   */
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(9000);
  check(
    'the stock list now marks items as running low',
    /running low/i.test(await body()),
    (await body()).slice(0, 160),
  );

  // ── An item's own level, set on the item's own page ────────────────────────
  /*
   * ── AN ITEM'S OWN LEVEL, REACHED THE WAY THE PAGE INTENDS ──────────────────
   *
   * Back to the warnings page and through its own "Add an item", which opens the product picker and
   * lands on the item's page. That is the path the page offers, so it is the path worth testing — and
   * the stock list has no inline search box to type into anyway: it uses the search VIEWER like the
   * rest of the app, which is a launcher button rather than a field.
   */
  await p.getByRole('button', { name: /When to be told stock is running low/i }).first().click();
  await p.waitForTimeout(5000);
  await p.getByRole('button', { name: /^Add an item$/i }).first().click();
  await p.waitForTimeout(3500);
  await p.getByPlaceholder(/Search/i).first().fill(subject.name);
  await p.waitForTimeout(3500);
  await p.locator('[class*="ProductPicker_item__"]:visible').first().click();
  await p.waitForTimeout(8000);

  const ownField = p.getByLabel(/Warn me at this many/i).first();
  check("the item's own page can set its level", (await ownField.count()) > 0, (await body()).slice(0, 100));
  await ownField.fill('1');
  await p.waitForTimeout(800);
  await p.getByRole('button', { name: /Save this level/i }).first().click();
  await p.waitForTimeout(7000);

  const { data: after } = await db.rpc('get_product', { p_product_id: subject.id });
  check("the item's own level was saved", Number(after?.[0]?.own_low_stock_level) === 1, String(after?.[0]?.own_low_stock_level));
  check(
    "and it beats the shop's",
    Number(after?.[0]?.low_stock_level) === 1,
    `resolved ${after?.[0]?.low_stock_level}, shop ${nowRule}`,
  );

  // ── And it is now a LISTED exception, which is the whole point ─────────────
  const { data: exceptions } = await db.rpc('products_with_own_low_stock', { p_store_id: storeId });
  check(
    'the exception is listable, not hidden inside the item',
    (exceptions ?? []).some((r) => r.product_id === subject.id),
    `${(exceptions ?? []).length} exception(s)`,
  );

  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(5000);
  await p.getByRole('button', { name: /When to be told stock is running low/i }).first().click();
  await p.waitForTimeout(6000);
  const shown = await body();
  check('and the page lists it', new RegExp(subject.name.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(shown), shown.slice(0, 200));
  check(
    'saying what it means against the general rule',
    /everything else at/i.test(shown),
    shown.slice(0, 220),
  );
  await p.screenshot({ path: 'shots/probe-low-stock-page.png', fullPage: true });

  // ── And Settings points at it rather than holding it ──────────────────────
  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(3000);
  const settingsLink = p.locator('[class*="rowLink"]:visible, button:visible').filter({ hasText: /Settings|Your shop/i }).first();
  if (await settingsLink.count()) {
    await settingsLink.click();
    await p.waitForTimeout(7000);
  }
  const settingsText = await body();
  check(
    'Settings offers the way in',
    /When to be told stock is running out/i.test(settingsText),
  );
  /*
   * VISIBLE ones only. Every tab's stack stays mounted, so the warnings page — sitting in the Stock
   * stack behind this one — still has its field in the DOM while Settings is on screen. Counting
   * every match failed this check against a field nobody could see, which is a test of the DOM rather
   * than of the screen.
   */
  check(
    'and no longer holds the field itself',
    (await p.getByLabel(/Tell me when an item gets down to/i).locator('visible=true').count()) === 0,
  );
} catch (e) {
  check('the probe ran to the end', false, String(e).split('\n')[0]);
  await p.screenshot({ path: 'shots/probe-low-stock-page-stopped.png', fullPage: true }).catch(() => {});
} finally {
  await b.close();
  // Exactly as it was found. A probe that leaves a live shop's warnings changed is one nobody can run
  // twice, and worse, one that changes what a real shop is told tomorrow morning.
  await db.rpc('set_low_stock_threshold', { p_store_id: storeId, p_level: wasRule });
  await db.rpc('set_product_low_stock', { p_product_id: subject.id, p_level: wasOwn });
  const restored = (await db.rpc('low_stock_rule', { p_store_id: storeId })).data ?? null;
  const { data: back } = await db.rpc('get_product', { p_product_id: subject.id });
  check(
    'the shop is left exactly as it was found',
    String(restored) === String(wasRule) && String(back?.[0]?.own_low_stock_level) === String(wasOwn),
    `rule ${restored} (was ${wasRule}), item ${back?.[0]?.own_low_stock_level} (was ${wasOwn})`,
  );
  console.log(failed === 0 ? '\n  all good' : '\n  ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
