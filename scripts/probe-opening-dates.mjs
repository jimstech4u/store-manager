/**
 * ADDING AN ITEM YOU ALREADY HAVE, WITH THE DATES IT GOES OFF ON — AND MORE THAN ONE.
 *
 * Asked for as «product form cannot add expiry dates, we can have multiple stock with different
 * expiry, one form multi line».
 *
 * Expiry lives on `stock_layers.expires_on`, and until 0170 only a PURCHASE ever made a layer. So a
 * shop entering what was already on its shelf could say how many and what they cost and had no way
 * to say when any of it goes off — which for a shop of drinks and food is the fact the whole
 * exercise was for.
 *
 * And it is rarely one date. A shelf is routinely two deliveries deep: some going off in March and
 * some in June. So the form takes LINES, and this walks the form the way a shop does — two lines,
 * two dates — and then reads the layers to see whether the two dates are actually there.
 *
 *     node scripts/probe-opening-dates.mjs [http://localhost:3101]
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

const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const { error: inErr } = await shop.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
if (inErr) throw inErr;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: memberships } = await shop.rpc('my_membership');
const storeId = memberships[0].store_id;

const NAME = 'Probe Dated Item ' + Date.now().toString().slice(-6);
const EARLY = '2027-03-01';
const LATE = '2027-09-01';

let productId = null;

/*
 * THE SERVER FIRST, because if it will not take two dates nothing the form does can help, and a
 * form walk that fails would not say which half was wrong.
 */
console.log('\n— the server takes a count and the dates within it —');
{
  const { data: made, error } = await admin
    .from('products')
    .insert({ store_id: storeId, name: NAME, base_unit: 'piece', status: 'active' })
    .select('id')
    .single();
  if (error) throw error;
  productId = made.id;

  const { error: openErr } = await shop.rpc('open_stock_by_count', {
    p_store_id: storeId,
    p_product_id: productId,
    p_qty: 52,
    p_unit_cost: 100,
    p_note: 'probe',
    p_batches: [
      { qty: 40, expires_on: EARLY },
      { qty: 12, expires_on: LATE },
    ],
  });
  check('two dated batches are accepted', !openErr, openErr?.message ?? '');

  const { data: layers } = await admin
    .from('stock_layers')
    .select('qty_base,remaining_base,expires_on')
    .eq('product_id', productId)
    .order('expires_on');
  check('both dates became layers', (layers ?? []).length === 2, JSON.stringify(layers));
  check(
    'and they carry the quantities they were given',
    layers?.[0]?.expires_on === EARLY && Number(layers[0].qty_base) === 40 &&
      layers?.[1]?.expires_on === LATE && Number(layers[1].qty_base) === 12,
    JSON.stringify(layers),
  );

  const { data: onHand } = await admin
    .from('stock_movements')
    .select('qty_delta')
    .eq('product_id', productId);
  check(
    'the count itself is one movement of 52, not two',
    (onHand ?? []).reduce((t, m) => t + Number(m.qty_delta), 0) === 52,
    JSON.stringify(onHand),
  );
}

/*
 * AND THE DISAGREEMENT IS REFUSED.
 *
 * The count and the dated lines are two descriptions of one shelf. A shop that has said both and
 * got them wrong should be told, not have one of the two silently win — which is the version of
 * this that loses stock quietly.
 */
console.log('\n— and a set that does not add up is refused —');
{
  const { data: other, error } = await admin
    .from('products')
    .insert({ store_id: storeId, name: NAME + ' B', base_unit: 'piece', status: 'active' })
    .select('id')
    .single();
  if (error) throw error;

  const { error: badErr } = await shop.rpc('open_stock_by_count', {
    p_store_id: storeId,
    p_product_id: other.id,
    p_qty: 50,
    p_unit_cost: 100,
    p_note: 'probe',
    p_batches: [{ qty: 40, expires_on: EARLY }],
  });
  check('40 dated against a count of 50 is refused', Boolean(badErr), badErr?.message ?? 'accepted');

  const { data: layers } = await admin
    .from('stock_layers')
    .select('id')
    .eq('product_id', other.id);
  check('and nothing was written', (layers ?? []).length === 0, `${(layers ?? []).length} layers`);
  const { data: moves } = await admin
    .from('stock_movements')
    .select('id')
    .eq('product_id', other.id);
  check('not even the count', (moves ?? []).length === 0, `${(moves ?? []).length} movements`);

  await admin.from('products').update({ status: 'archived' }).eq('id', other.id);
}

/*
 * NOW THE FORM. The server being right is not evidence a seller can reach it — the point of the
 * request was that the form had nowhere to type a date.
 */
console.log('\n— and a shop can type them into the form —');
const FORM_NAME = 'Probe Form Dates ' + Date.now().toString().slice(-6);
let formProductId = null;
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

  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(5000);
  await p.getByRole('button', { name: 'Add an item you sell' }).first().click();
  await p.waitForTimeout(4000);

  await p.getByLabel(/What is it called/i).first().fill(FORM_NAME);
  await p.waitForTimeout(600);

  /*
   * NOTHING ABOUT STOCK EXISTS UNTIL THERE IS A SHAPE, by design — "how many on the shelf" is a
   * number in one of them, and twelve means nothing until the form knows twelve of what. So the
   * walk has to name a shape before there is anywhere to type a date, and the form saying so is
   * the first thing worth checking.
   */
  check(
    'the form says the dates wait for a shape',
    /they will appear here once there is one/i.test(await p.locator('body').innerText()),
  );

  await p.getByRole('button', { name: /Add a shape/i }).first().click();
  await p.waitForTimeout(2000);
  const shapeBox = p.getByPlaceholder(/Crate, Bag, Litre/i).first();
  await shapeBox.click();
  await shapeBox.pressSequentially('bottle', { delay: 40 });
  await p.waitForTimeout(3000);
  await p.locator('[class*="UnitPicker_row"]').filter({ hasText: /bottle/i }).first().click();
  await p.waitForTimeout(2000);

  /*
   * "Customers buy this" is the only role that has to be ticked. Counting is no longer a question —
   * a shape is on an item because the shop has a word for it, and anything it has a word for it can
   * count, so 0138 forces every shape counted and the box was removed.
   */
  await p.locator('label').filter({ hasText: /Customers buy this/i }).first().locator('input').check();
  await p.waitForTimeout(1200);
  // A price is not what the dates depend on, so it is filled if it is there and skipped if not.
  const price = p.getByLabel(/Price for one bottle/i).first();
  if (await price.count()) {
    await price.fill('250');
    await p.waitForTimeout(1200);
  }

  /*
   * The count is labelled with the SHAPE — "Bottles" — not "how many on the shelf". The question is
   * already under a heading that says what it is asking; repeating it in the label would be the
   * form talking to itself.
   */
  /*
   * Found by WHERE IT IS, not by its words. The label is the shape's own plural — whatever the shop
   * typed, capitalised by a stylesheet — so matching on "Bottles" would make this a test of the
   * shop's vocabulary. "What you have now" renders one box per counted shape in its own container,
   * and that is the stable fact.
   */
  const onShelf = p.locator('[class*="shapeBoxes"] input').first();
  if ((await onShelf.count()) === 0) {
    // Say what IS on screen. A probe that only reports "not found" sends the next hour to guesswork.
    const labels = [];
    for (const el of await p.locator('input:visible').all()) {
      const id = await el.getAttribute('id');
      let l = '';
      if (id) {
        const lab = p.locator(`label[for="${id}"]`);
        if (await lab.count()) l = (await lab.first().innerText()).replace(/\s+/g, ' ').trim();
      }
      labels.push(l || '(unlabelled ' + (await el.getAttribute('type')) + ')');
    }
    console.log('    on screen:', labels.join(' | '));
    await p.screenshot({ path: 'shots/probe-opening-dates-nocount.png', fullPage: true });
  }
  check('the count appears once there is a shape', (await onShelf.count()) > 0);
  if (await onShelf.count()) {
    await onShelf.fill('52');
    await p.waitForTimeout(2500);
  }

  const askedDates = /When does it go off\?/i.test(await p.locator('body').innerText());
  check('and the form then asks when it goes off', askedDates);

  if (askedDates) {
    const addDate = p.getByRole('button', { name: /Add a date/i }).first();
    const dates = p.locator('input[type="date"]:visible');
    await addDate.click();
    await p.waitForTimeout(900);
    check('a dated line appeared', (await dates.count()) >= 1, `${await dates.count()} date inputs`);
    await addDate.click();
    await p.waitForTimeout(900);
    check('and a second, because a shelf is often two deliveries deep',
      (await dates.count()) >= 2, `${await dates.count()} date inputs`);

    /*
     * FILLED IN AND SAVED, because a form that shows two boxes and drops what is typed into them
     * is the same bug wearing a better shirt.
     */
    const qtys = p.locator('input[inputmode="decimal"]:visible');
    const rows = await dates.count();
    await dates.nth(0).fill(EARLY);
    await dates.nth(1).fill(LATE);
    // The two quantity boxes belonging to the dated rows, found through the rows themselves so a
    // count of every decimal input on the page cannot pick up the shelf figure or the low level.
    const batchQtys = p.locator('[class*="batchRow"]:visible').locator('input[inputmode="decimal"]');
    await batchQtys.nth(0).fill('40');
    await batchQtys.nth(1).fill('12');
    await p.waitForTimeout(1200);
    check('the two lines add up to the count', !/do not add up|come to/i.test(
      await p.locator('body').innerText()), 'form is not warning');

    await p.getByRole('button', { name: /^Add it$/ }).first().click();
    await p.waitForTimeout(12000);

    const { data: saved } = await admin
      .from('products')
      .select('id')
      .eq('store_id', storeId)
      .eq('name', FORM_NAME)
      .maybeSingle();
    check('the item saved', Boolean(saved), saved?.id ?? 'not found');
    if (saved) {
      formProductId = saved.id;
      const { data: madeLayers } = await admin
        .from('stock_layers')
        .select('qty_base,expires_on')
        .eq('product_id', saved.id)
        .order('expires_on');
      check('and the two dates the shop typed are on it',
        (madeLayers ?? []).length === 2 &&
          madeLayers[0].expires_on === EARLY && Number(madeLayers[0].qty_base) === 40 &&
          madeLayers[1].expires_on === LATE && Number(madeLayers[1].qty_base) === 12,
        JSON.stringify(madeLayers));
    }
    await p.screenshot({ path: 'shots/probe-opening-dates.png', fullPage: true });
  }
} catch (e) {
  check('the form walk ran to the end', false, String(e).split('\n')[0]);
  await p.screenshot({ path: 'shots/probe-opening-dates-stopped.png', fullPage: true }).catch(() => {});
} finally {
  await b.close();

  /*
   * `stock_movements` refuses deletes, so anything that received stock is ARCHIVED rather than
   * removed — and what is left behind is said out loud rather than glossed over.
   */
  for (const id of [productId, formProductId]) {
    if (id) await admin.from('products').update({ status: 'archived' }).eq('id', id);
  }
  const { data: leftovers } = await admin
    .from('products')
    .select('id,name,status')
    .eq('store_id', storeId)
    .or('name.like.Probe Dated Item%,name.like.Probe Form Dates%');
  const live = (leftovers ?? []).filter((r) => r.status === 'active');
  for (const r of live) await admin.from('products').update({ status: 'archived' }).eq('id', r.id);
  console.log(`\n  left behind: ${(leftovers ?? []).length} probe item(s), all archived`);
  console.log(failed === 0 ? '  all good' : '  ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
