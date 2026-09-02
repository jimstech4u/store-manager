/**
 * The counter, clicked through: a customer asks for something the shop has never entered.
 *
 * The seller adds it without leaving the receipt, is asked what is on the shelf because nothing
 * has counted it today, and the sale carries on. Neither question blocks; both are recorded.
 *
 *     node scripts/probe-mid-sale-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/mid-sale';
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

const stamp = Date.now().toString().slice(-6);
const NAME = `ZZ Counter ${stamp}`;
const UNIT = `CTin${stamp}`;

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

let productId = null;

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  if (await plus.count()) {
    await plus.scrollIntoViewIfNeeded();
    await plus.click();
    await p.waitForTimeout(5000);
  }

  console.log('\n— a customer asks for something not on file —');
  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(3000);

  // Typed until it sticks: a just-opened picker re-renders and drops what was typed.
  const search = p.locator('[role="dialog"] input').first();
  for (let i = 0; i < 6; i += 1) {
    await search.click();
    await search.fill(NAME);
    await p.waitForTimeout(1000);
    if ((await search.inputValue()) === NAME) break;
  }
  await p.waitForTimeout(3000);
  await p.screenshot({ path: `${SHOTS}/1-not-found.png` });

  const addNew = p.getByRole('button', { name: new RegExp(`Add ["“]?${NAME}|Add a new item|Add an item you sell`, 'i') }).first();
  check('the picker offers to add it', (await addNew.count()) > 0);
  await addNew.click();
  await p.waitForTimeout(3000);
  await p.screenshot({ path: `${SHOTS}/2-quick-add.png` });

  console.log('\n— three questions, not eleven —');
  const sheetText = await p.locator('body').innerText();
  check('it asks what it is called', /What is it called/i.test(sheetText));
  check('what it is sold in', /What are you selling it in/i.test(sheetText));
  check('and what it costs', /Price for one/i.test(sheetText));
  check('and says somebody will check it', /Somebody will check it/i.test(sheetText));

  await p.getByLabel(/What are you selling it in/i).fill(UNIT);
  await p.getByLabel(/Price for one/i).fill('3500');
  await p.waitForTimeout(600);
  await p.getByRole('button', { name: /Add to this sale/i }).click();
  await p.waitForTimeout(8000);
  await p.screenshot({ path: `${SHOTS}/3-on-the-receipt.png`, fullPage: true });

  const { data: made } = await admin
    .from('products')
    .select('id, name')
    .eq('name', NAME)
    .maybeSingle();
  productId = made?.id ?? null;
  check('it exists in the shop', Boolean(productId));

  const onReceipt = await p.locator('body').innerText();
  check('and it is on the receipt', onReceipt.includes(NAME));
  check('priced as the seller said', onReceipt.includes('3,500'), 'expected ₦3,500');

  console.log('\n— and nothing has counted it today —');
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${SHOTS}/4-count-gate.png` });
  const gateText = await p.locator('body').innerText();
  check('the till asks what is on the shelf', /not been counted today/i.test(gateText), gateText.replace(/\s+/g, ' ').slice(0, 120));
  check('and says why it asks now', /Why now and not this morning/i.test(gateText));

  const countBox = p.locator('[class*="CountGate"] input').first();
  if (await countBox.count()) {
    await countBox.fill('12');
    await p.waitForTimeout(600);
    await p.getByRole('button', { name: /Save the count|Save \d+ counts/i }).click();
    await p.waitForTimeout(6000);
  }
  await p.screenshot({ path: `${SHOTS}/5-counted.png` });

  const { data: period } = await admin
    .from('stock_periods')
    .select('actual_closing_qty')
    .eq('product_id', productId)
    .maybeSingle();
  check('the count reached the record', Number(period?.actual_closing_qty) === 12, JSON.stringify(period));

  const after = await p.locator('body').innerText();
  check('the receipt survived all of it', after.includes(NAME));
  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  if (productId) {
    await admin.from('stock_periods').delete().eq('product_id', productId);
    await admin.from('product_units').delete().eq('product_id', productId);
    await admin.from('product_sale_units').delete().eq('product_id', productId);
    const gone = await admin.from('products').delete().eq('id', productId);
    if (gone.error) await admin.from('products').update({ status: 'archived' }).eq('id', productId);
  }
  const storeId = (await admin.from('stores').select('id').limit(1).single()).data.id;
  await admin.from('store_units').delete().eq('store_id', storeId).eq('name', UNIT);
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
