/**
 * From a record to the records behind it.
 *
 * A shop reads "Sold, 3" on an item and asks "to whom, on what receipt?". It reads "owes ₦21,500"
 * on a customer and asks "what for?". Both answers were one join away — the database has returned
 * `ref_table` and `ref_id` on every history row since those screens were built — and neither
 * screen would take you there. One of them used the pair only to build a React key.
 *
 * This walks both: item → its history → the receipt, and customer → their account → the receipt.
 *
 *     node scripts/probe-joined-records.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/joined';
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
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

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

const bodyText = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

try {
  // ══ Which records actually have a sale behind them ════════════════════════════════
  const { data: products } = await shop.rpc('list_products', {
    p_store_id: storeId,
    p_after_name: null,
    p_after_id: null,
    p_limit: 100,
  });

  let soldProduct = null;
  for (const prod of products ?? []) {
    const { data: hist } = await shop.rpc('product_history', {
      p_product_id: prod.id,
      p_limit: 20,
    });
    if ((hist ?? []).some((h) => h.ref_table === 'sales' && h.ref_id)) {
      soldProduct = prod;
      break;
    }
  }
  check('the shop has an item that has been sold', Boolean(soldProduct), soldProduct?.name ?? 'none');

  const { data: customers } = await shop.rpc('list_customers', {
    p_store_id: storeId,
    p_query: null,
    p_after_name: null,
    p_after_id: null,
    p_limit: 50,
  });

  let buyer = null;
  for (const c of customers ?? []) {
    const { data: hist } = await shop.rpc('customer_history', {
      p_store_customer_id: c.id,
      p_limit: 20,
    });
    if ((hist ?? []).some((h) => h.ref_table === 'sales' && h.ref_id)) {
      buyer = c;
      break;
    }
  }
  check('and a customer who has bought', Boolean(buyer), buyer?.display_name ?? 'none');

  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ══ 1. Item → history → receipt ═══════════════════════════════════════════════════
  console.log('\n— from an item to the receipt it was sold on —');
  await tab('Stock');
  const row = p
    .locator('[class*="stock-page_itemName"]')
    .filter({ hasText: soldProduct.name })
    .first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await p.waitForTimeout(4000);

  const historyCard = p.getByText(/What happened|History|Recent/i).first();
  if (await historyCard.count()) {
    await historyCard.scrollIntoViewIfNeeded();
    await historyCard.click();
    await p.waitForTimeout(4000);
  }
  await p.screenshot({ path: `${SHOTS}/1-item-history.png` });

  const seeReceipt = p.getByRole('button', { name: /See the receipt/i }).first();
  check('a sold row offers its receipt', (await seeReceipt.count()) > 0, await bodyText().then((t) => t.slice(0, 90)));

  if (await seeReceipt.count()) {
    await seeReceipt.scrollIntoViewIfNeeded();
    await seeReceipt.click();
    await p.waitForTimeout(5000);
    await p.screenshot({ path: `${SHOTS}/2-receipt.png` });

    const receipt = await bodyText();
    check('and the receipt opens', /receipt|sold|total/i.test(receipt), receipt.slice(0, 90));
    check('naming the item that led here', receipt.includes(soldProduct.name), soldProduct.name);
  }

  // ══ 2. Customer → account → receipt ═══════════════════════════════════════════════
  console.log('\n— from a customer to what they were charged for —');
  await tab('People');
  /*
   * Searched for, not scrolled to.
   *
   * The shop has hundreds of customers and the list pages; the one this probe wants may simply not
   * be loaded, and a probe that scrolls until it finds them is testing the scrollbar.
   */
  const peopleSearch = p.getByPlaceholder(/Search by name or phone/i).first();
  if (await peopleSearch.count()) {
    await peopleSearch.click();
    await peopleSearch.fill(buyer.display_name);
    await p.waitForTimeout(3500);
  }

  const person = p
    .locator('[class*="money-page_rowName"]:visible')
    .filter({ hasText: buyer.display_name })
    .first();
  check('the customer can be found', (await person.count()) > 0, buyer.display_name);
  if (await person.count()) {
    await person.scrollIntoViewIfNeeded();
    await person.click();
    await p.waitForTimeout(5000);
  }
  await p.screenshot({ path: `${SHOTS}/3-account.png` });

  const accountReceipt = p.getByRole('button', { name: /See the receipt/i }).first();
  check(
    'a charge on the account offers its receipt',
    (await accountReceipt.count()) > 0,
    await bodyText().then((t) => t.slice(0, 90)),
  );

  if (await accountReceipt.count()) {
    await accountReceipt.scrollIntoViewIfNeeded();
    await accountReceipt.click();
    await p.waitForTimeout(5000);
    await p.screenshot({ path: `${SHOTS}/4-account-receipt.png` });
    const receipt = await bodyText();
    check('and it opens', /receipt|sold|total/i.test(receipt), receipt.slice(0, 90));
  }

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
