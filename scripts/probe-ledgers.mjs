/**
 * Empties and deposits, apart at last — driven through the browser.
 *
 * The shop's own worked example: a customer owing 3 Goldberg crates and 4 bottles plus 2 dispenser
 * bottles, then buying 3.5 Goldberg and 2.5 Gulder, should read
 *
 *     8 NBL crates, ½ Goldberg crate, ½ Gulder crate, 4 Goldberg bottles, 2 Dispenser water bottles
 *
 * WHOLE PARTS ADD UP ACROSS THE MAKER, FRACTIONS STAY WITH THEIR PRODUCT. That is the arithmetic
 * everything else here is arranged around, and it is checked against the figures that land in the
 * database rather than against the screen alone.
 *
 *     node scripts/probe-ledgers.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const NL = String.fromCharCode(10);
const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS = 'shots/ledgers';
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

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const stamp = Date.now().toString().slice(-6);
const NAME = `ZZ Ledger ${stamp}`;
const PHONE = `0803${stamp}00`.slice(0, 11);

// ── The customer, and the shapes to owe against ──────────────────────────────────────
const { data: customerId, error: custErr } = await shop.rpc('upsert_customer', {
  p_store_id: storeId,
  p_phone: PHONE,
  p_display_name: NAME,
  p_business_name: 'Dans',
});
if (custErr) {
  console.log('could not make the customer:', custErr.message);
  process.exit(1);
}
const cid = typeof customerId === 'string' ? customerId : customerId?.id;

/** A product's returnable shape, by product name and unit name. */
const shapeOf = async (product, unit) => {
  const { data } = await admin
    .from('product_units')
    .select('id, products!inner(name, store_id), store_units!inner(name)')
    .eq('is_returnable', true)
    .eq('products.store_id', storeId);
  return (data ?? []).find(
    (r) =>
      r.products.name.toLowerCase().includes(product.toLowerCase()) &&
      r.store_units.name.toLowerCase() === unit.toLowerCase(),
  )?.id;
};

/*
 * THE SHAPES THIS SHOP ACTUALLY HAS, not the ones the worked example names.
 *
 * Goldberg has no bottle shape here — only Piece and Crate — so asking for one handed `undefined`
 * to the writer, supabase-js dropped the key, and the failure came back as "no function with these
 * arguments", which reads like a broken signature rather than a missing shape.
 *
 * The arithmetic is what is being tested, and it needs two products under one maker with a crate
 * each, plus a bottle somewhere to prove bottles do not roll into crates.
 */
const goldbergCrate = await shapeOf('Goldberg', 'Crate');
const gulderCrate = await shapeOf('Gulder', 'Crate');
const gulderBottle = await shapeOf('Gulder', 'Bottle');
const dispenser = await shapeOf('Dispenser', 'Bottle');

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

let step = 0;
const shot = async (name) => {
  step += 1;
  await p.screenshot({ path: `${SHOTS}/${String(step).padStart(2, '0')}-${name}.png` });
};

try {
  check(
    'the shapes exist to owe against',
    Boolean(goldbergCrate && gulderCrate && gulderBottle),
    `goldberg crate, gulder crate, gulder bottle, dispenser: ${[goldbergCrate, gulderCrate, gulderBottle, dispenser].map((x) => (x ? 'y' : 'n')).join('')}`,
  );
  if (!goldbergCrate || !gulderCrate) throw new Error('no shapes to test against');

  // ── The shop's own worked example, written straight to the ledger ──────────────────
  console.log(NL + '— what Daniel owes —');
  const owe = async (unitId, qty) => {
    const { error } = await shop.rpc('record_customer_empties', {
      p_store_id: storeId,
      p_customer_id: cid,
      p_product_unit_id: unitId,
      p_direction: 'out',
      p_qty: qty,
      p_reason: 'probe',
    });
    if (error) throw new Error(error.message);
  };

  await owe(goldbergCrate, 3); // what they already had
  await owe(gulderBottle, 4);
  if (dispenser) await owe(dispenser, 2);
  await owe(goldbergCrate, 3.5); // and what they just bought
  await owe(gulderCrate, 2.5);

  const { data: owed } = await shop.rpc('customer_empties_owed', { p_store_customer_id: cid });
  const byShape = Object.fromEntries(
    (owed ?? []).map((r) => [`${r.product_name}|${r.unit_name}`, Number(r.owed)]),
  );
  check('Goldberg crates add up', byShape['Goldberg 60cl|Crate'] === 6.5, `${byShape['Goldberg 60cl|Crate']}`);
  check('Gulder crates are their own', byShape['Gulder 60cl|Crate'] === 2.5, `${byShape['Gulder 60cl|Crate']}`);
  check('and the bottles did not mix into the crates', byShape['Gulder 60cl|Bottle'] === 4, `${byShape['Gulder 60cl|Bottle']}`);

  // ── The screen, and the sentence it says ───────────────────────────────────────────
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.locator('.nav-item').first().waitFor({ state: 'visible', timeout: 180000 });
  await p.waitForTimeout(3000);

  console.log(NL + '— the empties screen —');
  await p.locator('.nav-item').filter({ hasText: /^Sell$/ }).first().click();
  await p.waitForTimeout(3000);
  await p.getByLabel('Containers still to come back').first().click();
  await p.waitForTimeout(5000);
  await shot('empties-list');

  const listText = await p.locator('body').innerText();
  check('the empties screen lists CUSTOMERS, not receipts', /Who is holding your containers/i.test(listText));
  check('and this customer is on it', listText.includes(NAME), listText.replace(/\s+/g, ' ').slice(0, 90));

  await p.getByText(NAME, { exact: false }).first().click();
  await p.waitForTimeout(5000);
  await shot('empties-customer');

  const owedText = await p.locator('body').innerText();

  /*
   * THE ARITHMETIC THE WHOLE DESIGN TURNS ON.
   *
   * 3 + 3.5 Goldberg crates and 2.5 Gulder crates: the whole parts (3 + 3 + 2) add up to eight NBL
   * crates because a Goldberg crate settles a Gulder crate, and the two halves stay with their own
   * beer because half a Goldberg and half a Gulder are not one crate of anything.
   */
  check(
    'whole crates add up across the maker — 8 NBL',
    /8\s*Nigerian Breweries/i.test(owedText.replace(/\s+/g, ' ')),
    (owedText.replace(/\s+/g, ' ').match(/\d+ Nigerian Breweries[^,\n]*/) ?? ['(not found)'])[0],
  );
  check(
    'and the half-crates stay with their own beer',
    /½\s*Goldberg/i.test(owedText) && /½\s*Gulder/i.test(owedText),
    (owedText.replace(/\s+/g, ' ').match(/½[^,\n]{0,30}/g) ?? []).join(' | '),
  );
  check(
    'a shape with one product is named by the product, not the maker',
    /4\s*Gulder 60cl bottles/i.test(owedText.replace(/\s+/g, ' ')),
    (owedText.replace(/\s+/g, ' ').match(/4 [A-Za-z0-9 ]*bottles/) ?? ['(not found)'])[0],
  );

  // ── A partial return, and the trace of it ──────────────────────────────────────────
  console.log(NL + '— they bring three crates back —');
  /*
   * A PUSHED PAGE, not a sheet. The form moved off the bottom sheet because a form is a page here
   * — so the probe walks it the way a person does: press, land on a page, fill it, commit, come
   * back.
   */
  await p.getByRole('button', { name: /brought some back/i }).click();
  await p.getByText('Empties brought back').first().waitFor({ state: 'visible', timeout: 60000 });
  await p.waitForTimeout(2000);
  /*
   * CHOSEN BY NAME, not by position.
   *
   * `{ index: 1 }` landed on "Dispenser water — 2 Bottles owed" and typing three crates against it
   * correctly produced "They only owe 2." with the button disabled — the page's own guard working,
   * reported by the probe as a hung click.
   */
  const which = p.locator('select').first();
  // `selectOption` takes a literal label, not a pattern — so the option's own value is read off the
  // page and chosen by it.
  const optionValue = await which
    .locator('option', { hasText: 'Goldberg' })
    .first()
    .getAttribute('value');
  await which.selectOption(optionValue);
  await p.waitForTimeout(900);
  await p.getByLabel(/How many/i).first().fill('3');
  await p.waitForTimeout(500);
  await shot('return-composed');
  await p.getByRole('button', { name: 'Record it', exact: true }).click();
  await p.waitForTimeout(7000);
  await shot('after-return');

  const { data: after } = await shop.rpc('customer_empties_owed', { p_store_customer_id: cid });
  const stillGold = (after ?? []).find(
    (r) => r.product_name.includes('Goldberg') && r.unit_name === 'Crate',
  );
  check(
    'a partial return leaves the rest out',
    Number(stillGold?.owed) === 3.5,
    `${stillGold?.owed} crates still out`,
  );

  const { data: trace } = await shop.rpc('customer_empties_ledger', { p_store_customer_id: cid });
  check(
    'and every move is on the trace',
    (trace ?? []).filter((t) => t.direction === 'returned').length === 1,
    `${(trace ?? []).length} rows`,
  );

  // ── The deposit, which is money and nothing to do with crates ──────────────────────
  console.log(NL + '— the deposit —');
  await shop.rpc('take_customer_deposit', {
    p_store_id: storeId,
    p_customer_id: cid,
    p_amount: 20000,
    p_reason: 'Crates and bottles',
  });

  await p.locator('.nav-item').filter({ hasText: /^Sell$/ }).first().click();
  await p.waitForTimeout(3000);
  await p.getByLabel('Deposits you are holding').first().click();
  await p.waitForTimeout(5000);
  await shot('deposits-list');

  const depText = await p.locator('body').innerText();
  check('the deposits screen exists and lists customers', /Money you are holding/i.test(depText));
  check('and shows this one holding ₦20,000', /20,000/.test(depText), depText.replace(/\s+/g, ' ').slice(0, 80));

  await p.getByText(NAME, { exact: false }).first().click();
  await p.waitForTimeout(5000);
  await shot('deposit-customer');

  console.log(NL + '— giving part of it back —');
  await p.getByRole('button', { name: 'Give some back', exact: true }).click();
  await p.getByLabel(/How much/i).first().waitFor({ state: 'visible', timeout: 60000 });
  await p.waitForTimeout(1500);
  await p.getByLabel(/How much/i).first().fill('12000');
  await p.getByLabel(/^Why/i).first().fill('Settled up');
  await p.waitForTimeout(500);
  await shot('give-composed');
  await p.getByRole('button', { name: 'Record it', exact: true }).click();
  await p.waitForTimeout(7000);
  await shot('after-give');

  const { data: led } = await shop.rpc('customer_deposit_ledger', { p_store_customer_id: cid });
  check('a partial refund leaves the rest held', Number((led ?? [])[0]?.running) === 8000, `${(led ?? [])[0]?.running}`);
  check('and both moves are on the trace', (led ?? []).length === 2, `${(led ?? []).length} rows`);

  /*
   * AND IT REFUSES MORE THAN IS HELD.
   *
   * A deposit account that can go negative is one nobody can reconcile, and the figure it would go
   * negative against is somebody's money.
   */
  const { error: tooMuch } = await shop.rpc('settle_customer_deposit', {
    p_store_id: storeId,
    p_customer_id: cid,
    p_amount: 99999,
    p_keep: false,
    p_reason: 'probe',
  });
  check('giving back more than is held is refused', Boolean(tooMuch), tooMuch?.message?.slice(0, 60));

  // ── A charge that is not a sale ────────────────────────────────────────────────────
  console.log(NL + '— a charge, and money owed back —');
  const before = Number((await shop.rpc('customer_balance', { p_store_customer_id: cid })).data);
  await shop.rpc('record_customer_charge', {
    p_store_id: storeId,
    p_customer_id: cid,
    p_amount: 2500,
    p_reason: 'Delivery to Ikeja',
    p_owed_to_them: false,
  });
  const afterCharge = Number((await shop.rpc('customer_balance', { p_store_customer_id: cid })).data);
  check('a charge adds to what they owe', afterCharge - before === 2500, `${before} -> ${afterCharge}`);

  await shop.rpc('record_customer_charge', {
    p_store_id: storeId,
    p_customer_id: cid,
    p_amount: 1000,
    p_reason: 'Overpaid on Tuesday',
    p_owed_to_them: true,
  });
  const afterExcess = Number((await shop.rpc('customer_balance', { p_store_customer_id: cid })).data);
  check('and an excess comes off it', afterCharge - afterExcess === 1000, `${afterCharge} -> ${afterExcess}`);

  const { error: noReason } = await shop.rpc('record_customer_charge', {
    p_store_id: storeId,
    p_customer_id: cid,
    p_amount: 500,
    p_reason: '   ',
    p_owed_to_them: false,
  });
  check('a charge with no reason is refused', Boolean(noReason), noReason?.message?.slice(0, 50));

  // ── The crates-and-bottles page is gone ────────────────────────────────────────────
  console.log(NL + '— the old settings page —');
  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(5000);
  const settings = await p.locator('body').innerText();
  check('"Crates and bottles" is gone from settings', !/Crates and bottles/i.test(settings));

  console.log(NL + '— page errors —');
  check('no uncaught error', errors.length === 0, errors.join(' / '));
} catch (e) {
  console.log(`${NL}  FAIL  the walk did not finish — ${String(e).split('\n')[0]}`);
  await shot('where-it-stopped');
  failed += 1;
} finally {
  await browser.close();

  /*
   * The ledgers are APPEND-ONLY and refuse deletes through the app, so the probe's rows are removed
   * with the service key — the only way — and what is left is read back and said rather than
   * assumed.
   */
  /*
   * THE LEDGERS REFUSE A DELETE, service key included.
   *
   * `tg_append_only` fires for every role, which is the point of it — these are money and goods
   * somebody will dispute one day. So the probe's rows stay and the CUSTOMER is archived, which
   * takes them off every list. Claiming to have deleted them and then reporting success would be
   * the cleanup that lied about itself.
   */
  if (cid) {
    await admin.from('store_customers').update({ status: 'archived' }).eq('id', cid);
  }
  const { data: left } = await admin
    .from('customer_empties')
    .select('id')
    .eq('store_customer_id', cid ?? '00000000-0000-0000-0000-000000000000');
  const { data: who } = await admin
    .from('store_customers')
    .select('status')
    .eq('id', cid ?? '00000000-0000-0000-0000-000000000000')
    .maybeSingle();
  console.log(
    `${NL}left behind: ${(left ?? []).length} append-only row(s) on a customer now ` +
      `"${who?.status ?? 'gone'}" — off every list`,
  );
  console.log(`${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}
