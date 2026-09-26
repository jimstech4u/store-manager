/**
 * MONEY STILL REACHES THE SHOP, now that Take payment no longer does the writing.
 *
 * `TakePayment` was 1,163 lines and the last ninety were the commit: `settle_draft_with_deposit`, a
 * row pushed onto the sales list, a debtor's balance patched. All of that is about settling a DRAFT,
 * and none of it is true of correcting a settled receipt — which is the screen now being built on
 * the same component. So the commit moved out to the page that owns it, and Take payment composes
 * money and hands over the facts.
 *
 * That is a refactor of the one screen where cash is counted. A type-check proves nothing about it:
 * it would pass just as happily with the deposit dropped, the payment recorded against no sale, or
 * the sale recorded twice. So this drives a real sale end to end and then asks the database.
 *
 * DETERMINISTIC ON PURPOSE. The shop requires an item to be counted the same day before it can be
 * sold (0144), so the pill reads "Count an item first" rather than "Take payment" — which is what
 * makes the older probes here flaky rather than wrong. This counts the item it is about to sell,
 * through the same RPC the till uses, and reads the count off the movements rather than inventing
 * one.
 *
 *     node scripts/probe-settle-through-the-till.mjs [http://localhost:3101]
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

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

/* The item this probe will sell, counted first so the till lets it through. */
const { data: products } = await shop.rpc('list_products', { p_store_id: storeId, p_limit: 40 });
const subject = (products ?? []).find((r) => Number(r.on_hand) > 20);
if (!subject) throw new Error('no item with enough stock to sell');

const onHand = async () =>
  ((await admin.from('stock_movements').select('qty_delta').eq('product_id', subject.id)).data ?? [])
    .reduce((s, m) => s + Number(m.qty_delta), 0);

const shelfBefore = await onHand();
const { error: countErr } = await shop.rpc('count_from_till', {
  p_product_id: subject.id,
  p_counted: shelfBefore,
});
if (countErr && !/already/i.test(countErr.message)) throw new Error(countErr.message);
console.log(`  selling: ${subject.name}, ${shelfBefore} on hand`);

const since = new Date(Date.now() - 60_000).toISOString();
let saleId = null;

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

  // ── The item, by name, so the sale is the one that was counted ──────────────
  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(3000);
  await p.getByPlaceholder(/Search/i).first().fill(subject.name);
  await p.waitForTimeout(3500);
  await p.locator('[class*="ProductPicker_item__"]:visible').first().click();
  await p.waitForTimeout(5000);

  const row = p.locator('[class*="SaleLineRow_line__"]:visible').first();
  check('the item is on the receipt', (await row.count()) > 0);

  // One of them, at a price this probe chooses, so the arithmetic is known.
  await row.locator('[class*="stepperField"] input').first().fill('1');
  await p.waitForTimeout(1500);
  const priceBox = row.locator('input[inputmode="decimal"]').nth(1);
  await priceBox.fill('1500');
  await priceBox.blur();
  await p.waitForTimeout(2500);

  /*
   * THE PILL SAYS WHAT HAS TO HAPPEN NEXT, and it is not always payment: with something uncounted
   * it says so and going there is the fix. Counted above, so this should read "Take payment" — and
   * if it does not, that is worth failing on rather than working around.
   */
  const pill = p.locator('[class*="FloatingAmount_pill__"]:visible').first();
  const pillSays = (await pill.innerText()).replace(/\s+/g, ' ');
  check('the till offers payment', /Take payment/i.test(pillSays), pillSays);
  await pill.click();
  await p.waitForTimeout(6000);

  check('the payment screen opened', /Take payment|Cash, transfer/i.test(await p.locator('body').innerText()));

  /*
   * ── PAID IN FULL, IN CASH ───────────────────────────────────────────────────
   *
   * The amount goes in the payment box and nothing else is pressed. "Add payment" exists to start a
   * SECOND payment: a typed amount already counts towards the total and is sent when the sale
   * settles. That is deliberate — a seller who tapped "Pay all" and went straight to the commit
   * button used to settle a sale with no payments recorded at all, so this probe follows the path a
   * seller actually takes rather than the one that needs an extra press.
   *
   * Found inside the payment box, because "Amount" also labels the charge and deposit fields, and
   * `.first()` across the page picks whichever of those React rendered first.
   */
  const amount = p.locator('[class*="payBox"] input[inputmode="decimal"]').first();
  await amount.fill('1500');
  await amount.blur();
  await p.waitForTimeout(2500);

  const commit = p.locator('[class*="pageActions"] button:visible').first();
  const commitSays = (await commit.innerText()).replace(/\s+/g, ' ');
  check('the commit button says it is paid', /Mark as paid/i.test(commitSays), commitSays);
  await commit.click();
  await p.waitForTimeout(14000);

  check(
    'a receipt is shown',
    /Receipt|Sale recorded/i.test(await p.locator('body').innerText()),
    (await p.locator('body').innerText()).slice(0, 90),
  );
  await p.screenshot({ path: 'shots/probe-settle-through-the-till.png', fullPage: true });

  // ── And the shop actually has it ────────────────────────────────────────────
  const { data: made } = await admin
    .from('sales')
    .select('id,total,status')
    .eq('store_id', storeId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);
  const sale = (made ?? [])[0];
  check('the sale reached the shop', Boolean(sale), sale ? sale.id : 'nothing recorded');
  if (!sale) throw new Error('no sale to check');
  saleId = sale.id;

  check('for the amount that was keyed', Math.abs(Number(sale.total) - 1500) < 0.005, String(sale.total));
  check('and it is posted', sale.status === 'posted', sale.status);

  /*
   * THE PAYMENT IS ALLOCATED TO IT, which is the part a moved commit is most likely to drop: a
   * payment that exists but points at no receipt leaves the customer owing money they handed over.
   */
  const { data: allocated } = await admin
    .from('payment_allocations')
    .select('amount')
    .eq('sale_id', saleId);
  check(
    'the money is allocated to that receipt',
    Math.abs((allocated ?? []).reduce((s, a) => s + Number(a.amount), 0) - 1500) < 0.005,
    JSON.stringify(allocated),
  );

  // Recorded ONCE. A commit moved between components is exactly how a double-settle appears.
  const { data: all } = await admin
    .from('sales')
    .select('id')
    .eq('store_id', storeId)
    .gte('created_at', since);
  check('recorded once, not twice', (all ?? []).length === 1, `${(all ?? []).length} sales`);

  check('and the stock came off the shelf', (await onHand()) < shelfBefore, `${shelfBefore} → ${await onHand()}`);
} catch (e) {
  check('the probe ran to the end', false, String(e).split('\n')[0]);
  await p.screenshot({ path: 'shots/probe-settle-stopped.png', fullPage: true }).catch(() => {});
} finally {
  await b.close();
  /*
   * The probe's sale is VOIDED, not deleted: `stock_movements` refuses deletes, and voiding is the
   * sanctioned removal — it reverses the shelf and the account to net zero. The payment then stands
   * as a credit, so it is taken out too; a probe that leaves ₦1,500 of credit on a live shop shows
   * up on the dashboard as money held for nobody.
   */
  if (saleId) {
    await shop.rpc('void_sale', { p_sale_id: saleId, p_reason: 'probe cleanup' });
    const { data: allocs } = await admin.from('payment_allocations').select('payment_id').eq('sale_id', saleId);
    for (const a of allocs ?? []) {
      await admin.from('payment_allocations').delete().eq('payment_id', a.payment_id);
      await admin.from('payments').delete().eq('id', a.payment_id);
    }
  }
  console.log(failed === 0 ? '\n  all good' : '\n  ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
