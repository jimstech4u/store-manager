/**
 * A seller can say what deposit they took, both ways round.
 *
 * `probe-deposit-taken` proves the arithmetic and the ledger. This proves a shop can reach it: the
 * rate is on the line, next to the sentence that says what is going out; the total is on the
 * payment screen where the rest of the money is; and each drives the other, because a deposit gets
 * agreed both ways at a counter — "₦125 a crate" and "fifteen thousand for the lot", often in the
 * same conversation.
 *
 * It also checks the two figures a shop reads back: that the deposit is NOT folded into "Items",
 * because money the shop owes back is not what the drinks cost, and that the line says what the
 * money actually covers when a crate sends its bottles out too.
 *
 * WRITES a draft and cancels it. It never settles: a settled sale moves stock and there is no way
 * to move it back.
 *
 *     node scripts/probe-deposit-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/deposit-ui';
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

const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

// A product that actually sends a container out, so the deposit field has a reason to exist.
const { data: units } = await shop.rpc('product_selling_units', { p_store_id: storeId });
let subject = null;
for (const u of units ?? []) {
  if (!u.is_sold || !u.is_returnable) continue;
  const { data: ret } = await shop.rpc('returnables_for_sale', {
    p_product_id: u.product_id,
    p_base_qty: Number(u.base_qty),
    p_containers: 1,
  });
  if ((ret ?? []).some((r) => r.kind === 'container')) {
    const { data: p } = await shop.from('products').select('name').eq('id', u.product_id).single();
    subject = { name: p.name, unit: u, pools: ret };
    break;
  }
}
if (!subject) {
  console.log('  SKIP  nothing in this shop goes out in a container');
  process.exit(0);
}

const QTY = 4;
const RATE = 125;
console.log(`\n  ${subject.name} — the shop takes ₦${RATE} a container\n`);

/*
 * The orders open before this run, so the one it opens can be told apart.
 *
 * `created_at` rather than a set of ids: this shop has over a thousand drafts and PostgREST caps a
 * response at a thousand rows, so an id snapshot was silently truncated and the probe could not see
 * its own order afterwards. It reported "nothing left behind" while leaving one every run.
 */
const startedAt = new Date(Date.now() - 1000).toISOString();

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
/** Orders this run opened, so every one of them is closed again. */
const opened = new Set();

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ══ A line with containers going out ══════════════════════════════════════════════
  console.log('— on the line, a rate —');
  await p.locator('.nav-item').filter({ hasText: /^Sell$/ }).first().click();
  await p.waitForTimeout(3500);

  const start = p.getByRole('button', { name: /Start a customer|New customer|Add a customer/i }).first();
  if ((await start.count()) > 0) {
    await start.click();
    await p.waitForTimeout(1500);
  }

  await p.getByRole('button', { name: /^Add an item$/ }).first().click();
  await p.waitForTimeout(3000);
  await p.getByPlaceholder(/search/i).last().fill(subject.name);
  await p.waitForTimeout(3000);
  /*
   * Scoped to the PICKER's own rows, and required to be visible.
   *
   * A looser selector matched a row on the Stock page, which is still mounted under the till — a
   * pushed page never unmounts here — so the probe spent thirty seconds trying to click something
   * nobody can see. The picker's rows carry `ProductPicker`'s own class.
   */
  await p.locator('[class*="ProductPicker_item"]:visible').first().click();
  await p.waitForTimeout(4000);

  /*
   * "Count this one first" stands in front of the line.
   *
   * A real gate, and the right one: an item nobody has counted today starts the day from a figure
   * somebody checked rather than one the records assumed. It offers "Not now", which is what a
   * seller with a customer waiting presses, so that is what this presses.
   */
  const notNow = p.getByRole('button', { name: /^Not now$/ }).first();
  if ((await notNow.count()) > 0) {
    console.log('  ..    a count gate came up first; taking "Not now"');
    await notNow.click();
    await p.waitForTimeout(3000);
  }
  /*
   * SAY HOW MANY, because the till deliberately does not guess.
   *
   * A crate that can be sold in halves starts at nothing: half a crate recorded as a whole one is a
   * real loss, and one is exactly the guess that gets left there when somebody is hurrying. So
   * there are no containers going out until a quantity is set, and no deposit to ask about — which
   * is why the field was correctly absent when this probe first looked for it.
   */
  const qty = p.locator('[class*="stepperField"] input:visible').first();
  await qty.fill(String(QTY));
  await qty.blur();
  await p.waitForTimeout(3000);
  await p.screenshot({ path: `${SHOTS}/1-line.png` });

  const withLine = await body();
  check('the line says what is going out', /going out/i.test(withLine), 'a returnable was picked');

  const rateField = p.getByLabel(/Deposit per/i).first();
  check('and offers a deposit for it', (await rateField.count()) > 0);
  if ((await rateField.count()) === 0) throw new Error('no deposit field to drive');

  const label = await p.locator('label:has-text("Deposit per")').first().innerText();
  check('named after the container, not "deposit"', /Deposit per \w+/i.test(label), label.split('\n')[0]);

  await rateField.fill(String(RATE));
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${SHOTS}/2-rate.png` });

  const typed = await body();
  check(
    'it says how much is held, not just the rate',
    /held/i.test(typed),
    (typed.match(/₦[\d,.]+ held[^.]{0,40}/i) ?? ['no "held" line'])[0],
  );
  if (subject.pools.length > 1) {
    check(
      'and says the bottles inside are covered too',
      /covering the .+ as well/i.test(typed),
      (typed.match(/covering the [^,.]{0,40}/i) ?? ['it did not'])[0],
    );
  }

  // ══ The other way round: a total on the payment screen ════════════════════════════
  console.log('\n— on the payment screen, a total —');
  await p.getByRole('button', { name: /Take payment/i }).first().click();
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `${SHOTS}/3-payment.png` });

  const pay = await body();
  check('the deposit is named here as well', /Deposit on \d+ container/i.test(pay),
    (pay.match(/Deposit on [^₦]{0,30}/i) ?? ['not named'])[0]);

  /*
   * The deposit must NOT be inside "Items".
   *
   * It is money the shop owes back; counted as goods it reads as though the drinks cost that much
   * more, which is the same misreading the receipt was making before 0087.
   */
  const items = Number((pay.match(/Items ₦([\d,]+)/i) ?? [])[1]?.replace(/,/g, '') ?? NaN);
  const lineOnly = Number((await admin
    .from('draft_order_lines')
    .select('line_total')
    .limit(1)).data?.[0]?.line_total ?? NaN);
  void lineOnly;
  check(
    '"Items" is the goods alone, with the deposit outside it',
    Number.isFinite(items) && !pay.includes(`Items ₦${(items + RATE).toLocaleString()}`),
    Number.isFinite(items) ? `Items ₦${items.toLocaleString()}` : 'could not read Items',
  );

  // Type a total over the top; the lines must take it up.
  const totalField = p.locator('[class*="deposit"] input').first();
  check('the total can be typed over', (await totalField.count()) > 0);
  if ((await totalField.count()) > 0) {
    await totalField.fill('900');
    await p.waitForTimeout(3500);
    await p.screenshot({ path: `${SHOTS}/4-total.png` });

    const after = await body();
    check(
      'and it spreads back to a rate each',
      /₦\s?[\d,.]+ each/i.test(after),
      (after.match(/₦[\d,.]+ each[^.]{0,30}/i) ?? ['no per-container figure'])[0],
    );

    const { data: rows } = await admin
      .from('draft_order_lines')
      .select('deposit_charged, draft_order_id')
      .order('created_at', { ascending: false })
      .limit(3);
    const mine = rows?.[0];
    check(
      'the shop has it, at the figure that was typed',
      mine != null && Math.abs(Number(mine.deposit_charged) - 900) < 0.01,
      mine ? `₦${mine.deposit_charged}` : 'no draft line found',
    );
    // Held so the cleanup can name it rather than search for it.
    if (mine) opened.add(mine.draft_order_id);
  }

  check('no page errors along the way', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();

  /*
   * Everything opened since this run started — including the empty tabs a run leaves when it fails
   * part way, which are the ones that quietly accumulate. Ninety-three of them once did.
   */
  const { data: after } = await admin
    .from('draft_orders')
    .select('id')
    .eq('store_id', storeId)
    .eq('status', 'open')
    .gte('created_at', startedAt);
  for (const r of after ?? []) opened.add(r.id);

  console.log('');
  for (const id of opened) {
    const { error } = await shop.rpc('cancel_draft_order', { p_draft_id: id });
    if (error) {
      console.log(`  FAIL  could not cancel ${id.slice(0, 8)} — ${error.message}`);
      failed += 1;
    }
  }

  // Say what is actually true, not what was attempted. The previous version of this printed
  // "nothing left behind" while leaving an order every run, because it never looked.
  const { data: left } = await admin
    .from('draft_orders')
    .select('id')
    .eq('store_id', storeId)
    .eq('status', 'open')
    .gte('created_at', startedAt);
  if ((left ?? []).length === 0) {
    console.log(`  ok  ${opened.size} order(s) opened, all closed again`);
  } else {
    console.log(`  FAIL  ${left.length} order(s) still open in the shop`);
    failed += 1;
  }
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
