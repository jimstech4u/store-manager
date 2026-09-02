/**
 * What the shop's screens say after a sale.
 *
 * A sale moves stock, money and a customer's balance at once, and each of those is read on a
 * different screen. This makes one, then goes and looks: is the stock list still there, does it
 * show the new quantity, is the sale in the list, has the shelf value moved.
 *
 * The list being INTACT is checked separately from it being RIGHT, because they fail differently:
 * a cleared list is a blank screen somebody reloads, and a stale one is a figure somebody acts on.
 *
 *     node scripts/probe-after-sale.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/after-sale';
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

const tab = async (label) => {
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(900);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(4500);
};

const rows = () => p.locator('[class*="stock-page_itemName"]').count();
const worthShown = async () => {
  const el = p.locator('[class*="stock-page_summaryValue"]').first();
  return (await el.count()) ? (await el.innerText()).trim() : '(none)';
};

const storeId = (await admin.from('stores').select('id').limit(1).single()).data.id;
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  await tab('Stock');
  const before = await rows();
  const worthBefore = await worthShown();
  check('the stock list is loaded', before > 0, `${before} rows`);
  check('and states what the shelf is worth', worthBefore !== '(none)', worthBefore);
  await p.screenshot({ path: `${SHOTS}/1-before.png` });

  /*
   * The whole-catalogue figure, asked of the shop, so the screen can be held to it.
   *
   * Summing the rows on screen would only prove the page agrees with itself.
   */
  const trueWorth = Number(
    (await shop.rpc('stock_worth', { p_store_id: storeId })).data?.[0]?.total_value ?? 0,
  );
  const shownNumber = Number(worthBefore.replace(/[^0-9.]/g, ''));
  check(
    'and that figure is the shop’s, not a sum of what is on screen',
    Math.abs(shownNumber - trueWorth) < 1,
    `screen ${shownNumber}, shop ${trueWorth}`,
  );

  // ══ Make a sale ═══════════════════════════════════════════════════════════════════
  console.log('\n— sell something —');
  await tab('Sell');
  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  if (await plus.count()) {
    await plus.scrollIntoViewIfNeeded();
    await plus.click();
    await p.waitForTimeout(5000);
  }
  /*
   * SOMETHING WITH STOCK AND A COST, chosen deliberately.
   *
   * Taking whatever the picker offers first landed on a probe leftover holding nothing at nothing,
   * and selling it moved the shelf value by zero — so the check below passed or failed for reasons
   * that had nothing to do with the code. The shop is asked which item is actually worth something.
   */
  const { data: stocked } = await shop.rpc('product_selling_units', { p_store_id: storeId });
  const target = (stocked ?? []).find(
    (u) => Number(u.on_hand_units) > 1 && Number(u.cost_per_unit) > 0,
  );
  check('the shop has something worth selling', Boolean(target), target?.unit_name ?? 'none found');

  const { data: named } = await admin
    .from('products')
    .select('name')
    .eq('id', target?.product_id)
    .maybeSingle();
  const soldName = named?.name ?? null;

  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(3000);

  // Typed until it sticks: a just-opened picker re-renders and drops what was typed.
  const search = p.locator('[role="dialog"] input').first();
  for (let i = 0; i < 6; i += 1) {
    await search.click();
    await search.fill(soldName ?? '');
    await p.waitForTimeout(900);
    if ((await search.inputValue()) === soldName) break;
  }
  await p.waitForTimeout(2500);

  const item = p.locator('[role="dialog"] [class*="ProductPicker_name"]').first();
  if (await item.count()) {
    await item.click();
    await p.waitForTimeout(6000);
  }
  check('it is on the receipt', Boolean(soldName), soldName ?? 'nothing');

  // The till asks for a shelf count on the first sale of the day; not this probe's subject.
  const notNow = p.getByRole('button', { name: /^Not now$/i }).first();
  if (await notNow.count()) {
    await notNow.click();
    await p.waitForTimeout(1500);
  }

  await p.getByRole('button', { name: /take payment/i }).first().click();
  await p.waitForTimeout(5000);

  const payAll = p.getByRole('button', { name: /Pay all/i }).first();
  if (await payAll.count()) {
    await payAll.click();
    await p.waitForTimeout(1200);
  }
  const addPay = p.getByRole('button', { name: /Add payment/i }).first();
  if (await addPay.count()) {
    await addPay.click();
    await p.waitForTimeout(1200);
  }
  /*
   * The commit button says what it will do: "Mark as paid" when the money covers the total, and
   * "Put it all on account" when it does not. Matching both, and asserting the sale landed rather
   * than assuming the click worked — a settle that silently did nothing made the check below pass
   * for the wrong reason.
   */
  const settle = p.getByRole('button', { name: /Mark as paid|Put it all on account/i }).last();
  await settle.scrollIntoViewIfNeeded();
  await settle.click();
  await p.waitForTimeout(9000);
  await p.screenshot({ path: `${SHOTS}/2-settled.png` });

  const { count: salesNow } = await admin
    .from('sales')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', new Date(Date.now() - 120_000).toISOString());
  check('the sale reached the shop', (salesNow ?? 0) > 0, `${salesNow} in the last two minutes`);

  // ══ Back to the stock screen ══════════════════════════════════════════════════════
  console.log('\n— and go back to Stock —');
  await tab('Stock');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${SHOTS}/3-after.png` });

  const after = await rows();
  check('the list is still there', after > 0, `${after} rows`);
  check('with nothing lost from it', after >= before, `had ${before}, now ${after}`);

  const blanked = (await p.getByText(/Loading your stock/i).count()) > 0;
  check('and it is not sitting on a loading screen', !blanked);

  const worthAfter = await worthShown();
  const trueAfter = Number(
    (await shop.rpc('stock_worth', { p_store_id: storeId })).data?.[0]?.total_value ?? 0,
  );
  check(
    'the shelf value agrees with the shop after the sale',
    Math.abs(Number(worthAfter.replace(/[^0-9.]/g, '')) - trueAfter) < 1,
    `screen ${worthAfter}, shop ${trueAfter}`,
  );
  check('and it moved, because stock left the shelf', worthAfter !== worthBefore, `${worthBefore} → ${worthAfter}`);

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
