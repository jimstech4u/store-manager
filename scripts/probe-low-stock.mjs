/**
 * RUNNING LOW: ONE GENERAL RULE, AND THE EXCEPTIONS WIN.
 *
 * Asked for as «something in the stock card that we are low on stock, configurable in settings for
 * the amount to notify, and also we can general and still even have set of specific items that we
 * want to be different — so general apply and specific».
 *
 * Two facts, and the whole feature is in how they interact:
 *
 *   · the shop sets ONE level and it covers every item
 *   · an item may be given its OWN, which beats the general one wherever it is set
 *
 * And a third, less obvious and easier to get wrong: BLANK IS NOT ZERO. Blank means "follow the
 * shop"; 0 means "tell me only when there are none at all", which is the right answer for something
 * rare that gets ordered in. A feature that folded those together would silence the shop's rule on
 * every item somebody had ever opened.
 *
 * The probe reads with the same functions the app reads with, restores what it found, and then
 * checks the stock card actually says so on screen.
 *
 *     node scripts/probe-low-stock.mjs [http://localhost:3101]
 */
import { createClient } from '@supabase/supabase-js';
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const { error: signInErr } = await db.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
if (signInErr) throw signInErr;

const { data: memberships, error: storesErr } = await db.rpc('my_membership');
if (storesErr) throw storesErr;
const store = { id: memberships[0].store_id };
console.log('  shop:', store.id);

/* What was there before, so the shop is left as it was found. */
const { data: before } = await db
  .from('store_settings')
  .select('low_stock_threshold')
  .eq('store_id', store.id)
  .single();
const wasShopLevel = before?.low_stock_threshold ?? null;

/* An item with stock on it, so "low" and "out" are different states on it. */
const { data: products, error: pErr } = await db.rpc('list_products', {
  p_store_id: store.id,
  p_limit: 60,
});
if (pErr) throw pErr;
const subject = products.find((p) => Number(p.on_hand) > 2);
if (!subject) throw new Error('no item with stock on it to test against');
const onHand = Number(subject.on_hand);
console.log(`  item: ${subject.name} — ${onHand} on hand`);

const { data: sBefore } = await db
  .from('products')
  .select('low_stock_threshold')
  .eq('id', subject.id)
  .single();
const wasItemLevel = sBefore?.low_stock_threshold ?? null;

const levelOf = async (id) => {
  const { data, error } = await db.rpc('get_product', { p_product_id: id });
  if (error) throw error;
  return data[0];
};
const listLevelOf = async (id) => {
  const { data, error } = await db.rpc('list_products', { p_store_id: store.id, p_limit: 200 });
  if (error) throw error;
  return (data ?? []).find((r) => r.id === id);
};

try {
  // ── The general rule ────────────────────────────────────────────────────────
  console.log('\n— the shop sets one level —');
  await db.rpc('set_low_stock_threshold', { p_store_id: store.id, p_level: onHand + 5 });
  await db.rpc('set_product_low_stock', { p_product_id: subject.id, p_level: null });

  let row = await levelOf(subject.id);
  check('the general level reaches the item', Number(row.low_stock_level) === onHand + 5, String(row.low_stock_level));
  check(
    'and the item is not recorded as an exception',
    row.own_low_stock_level === null,
    String(row.own_low_stock_level),
  );
  let listed = await listLevelOf(subject.id);
  check('the stock list is told the same level', Number(listed.low_stock_level) === onHand + 5, String(listed?.low_stock_level));

  const { data: lowSet, error: lowErr } = await db.rpc('low_stock_items', { p_store_id: store.id });
  if (lowErr) throw lowErr;
  check(
    'the item counts as low under the general rule',
    lowSet.some((r) => r.product_id === subject.id),
    `${lowSet.length} low`,
  );

  // ── The exception ───────────────────────────────────────────────────────────
  console.log('\n— and one item is different —');
  await db.rpc('set_product_low_stock', { p_product_id: subject.id, p_level: 1 });
  row = await levelOf(subject.id);
  check("the item's own level wins over the shop's", Number(row.low_stock_level) === 1, String(row.low_stock_level));
  check('and is reported as the exception it is', Number(row.own_low_stock_level) === 1, String(row.own_low_stock_level));

  const { data: nowLow } = await db.rpc('low_stock_items', { p_store_id: store.id });
  check(
    'and it is no longer low, because its own level says so',
    !nowLow.some((r) => r.product_id === subject.id),
    `${nowLow.length} low`,
  );

  // ── Blank is not zero ───────────────────────────────────────────────────────
  console.log('\n— blank and zero are different answers —');
  await db.rpc('set_product_low_stock', { p_product_id: subject.id, p_level: 0 });
  row = await levelOf(subject.id);
  check('zero is kept as a real level', Number(row.own_low_stock_level) === 0, String(row.own_low_stock_level));
  check('and it is what the item is judged by', Number(row.low_stock_level) === 0, String(row.low_stock_level));

  await db.rpc('set_product_low_stock', { p_product_id: subject.id, p_level: null });
  row = await levelOf(subject.id);
  check(
    'and clearing it hands the item back to the shop\'s rule',
    row.own_low_stock_level === null && Number(row.low_stock_level) === onHand + 5,
    `own=${row.own_low_stock_level} resolved=${row.low_stock_level}`,
  );

  /*
   * Turning the shop's rule OFF must silence everything, not fall back to some built-in figure.
   * A shop that has not asked to be told anything should not be told anything.
   */
  await db.rpc('set_low_stock_threshold', { p_store_id: store.id, p_level: null });
  row = await levelOf(subject.id);
  check('with no rule anywhere, there is no level', row.low_stock_level === null, String(row.low_stock_level));
  const { data: noneLow } = await db.rpc('low_stock_items', { p_store_id: store.id });
  check('and nothing is reported low', noneLow.length === 0, `${noneLow.length} low`);

  // ── What the shop actually sees ─────────────────────────────────────────────
  console.log('\n— and the card says so —');
  await db.rpc('set_low_stock_threshold', { p_store_id: store.id, p_level: onHand + 5 });

  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2500);
    await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
    await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
    await p.locator('button[type="submit"]').first().click();
    await p.waitForTimeout(18000);

    await p.getByRole('button', { name: 'Stock', exact: true }).first().click();
    await p.waitForTimeout(8000);
    const text = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
    // IN WORDS, not only in colour: a colour alone is unreadable in sunlight at a counter, and
    // invisible to a fair number of people.
    check('the stock list marks something as running low', /running low/i.test(text), text.slice(0, 140));
    await p.screenshot({ path: 'shots/probe-low-stock.png', fullPage: true });

    /*
     * AND THE SHOP CAN SET IT WITHOUT A DEVELOPER.
     *
     * The rule being right in the database is not the feature: the request was for it to be
     * configurable in Settings. So the field is found, typed into, and the value read back off the
     * shop — the box existing is not evidence that what goes in it is kept.
     */
    await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
    await p.waitForTimeout(3000);
    const settingsLink = p.locator('[class*="rowLink"]:visible, button:visible')
      .filter({ hasText: /Settings|Your shop/i }).first();
    if (await settingsLink.count()) {
      await settingsLink.click();
      await p.waitForTimeout(6000);
    }
    const field = p.getByLabel(/Tell me when an item gets down to/i).first();
    check('Settings has the shop-wide level', (await field.count()) > 0);
    if (await field.count()) {
      await field.fill(String(onHand + 9));
      await p.waitForTimeout(1200);
      const save = p.getByRole('button', { name: /^Save/ }).first();
      if (await save.count()) await save.click();
      await p.waitForTimeout(6000);
      const { data: after } = await db
        .from('store_settings')
        .select('low_stock_threshold')
        .eq('store_id', store.id)
        .single();
      check(
        'and what the shop typed there is kept',
        Number(after?.low_stock_threshold) === onHand + 9,
        String(after?.low_stock_threshold),
      );
    }
    await p.screenshot({ path: 'shots/probe-low-stock-settings.png', fullPage: true });
  } finally {
    await b.close();
  }
} catch (e) {
  check('the probe ran to the end', false, e.message);
} finally {
  // Put the shop back exactly as it was. A probe that leaves a live shop changed is a probe nobody
  // can run twice.
  await db.rpc('set_low_stock_threshold', { p_store_id: store.id, p_level: wasShopLevel });
  await db.rpc('set_product_low_stock', { p_product_id: subject.id, p_level: wasItemLevel });
  const { data: restored } = await db
    .from('store_settings')
    .select('low_stock_threshold')
    .eq('store_id', store.id)
    .single();
  check(
    'the shop is left as it was found',
    (restored?.low_stock_threshold ?? null) === wasShopLevel,
    `was ${wasShopLevel}, now ${restored?.low_stock_threshold ?? null}`,
  );
  console.log(failed === 0 ? '\n  all good' : '\n  ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
