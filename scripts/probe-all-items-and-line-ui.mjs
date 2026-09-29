/**
 * ALL ITEMS, AND A LINE CHANGED FROM TAKE PAYMENT — clicked through.
 *
 * "A button under Scan a barcode called All items … shows all items alone with share on WhatsApp,
 * normal share, PDF and print … a large indicator this is not a receipt … also in Take payment under
 * 'What they are buying'. Each line there clickable to push a sales line page … and add more and
 * scan pushes the sales line with the product."
 *
 * Uses items counted today and priced, so the till's gates let it through to Take payment. Nothing
 * is settled, shared or printed; the probe's draft is taken back off the till at the end.
 *
 *     node scripts/probe-all-items-and-line-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const FIRST = { search: 'Chivita Active', match: /Chivita Active \(1L\)/i, name: 'Chivita Active (1L)' };
const SECOND = { search: 'La Qua', match: /La Qua PET \(75cl\)/i, name: 'La Qua PET (75cl)' };
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/all-items';
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const startedAt = new Date().toISOString();
const sweep = async () => {
  const { data: mine } = await admin
    .from('draft_orders')
    .select('id')
    .eq('status', 'open')
    .gte('created_at', startedAt);
  const ids = (mine ?? []).map((d) => d.id);
  if (ids.length === 0) return;
  await admin.from('draft_order_lines').delete().in('draft_order_id', ids);
  await admin.from('draft_orders').delete().in('id', ids);
  console.log(`  (took ${ids.length} probe draft(s) back off the till)`);
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const pick = async (item) => {
  const search = p.locator('[role="dialog"] input').first();
  for (let i = 0; i < 4; i += 1) {
    await search.fill(item.search);
    await p.waitForTimeout(900);
    if ((await search.inputValue()) === item.search) break;
  }
  const hit = p.locator('[role="dialog"]').getByText(item.match).first();
  await hit.waitFor({ state: 'visible', timeout: 30000 });
  await hit.click();
};
const text = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

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
    await p.waitForTimeout(4000);
  }

  console.log('\n— the till: an item, then All items —');
  const addItem = p.getByRole('button', { name: /Add an item/i }).first();
  await addItem.waitFor({ state: 'visible', timeout: 120000 });
  await addItem.click();
  await p.waitForTimeout(2000);
  await pick(FIRST);
  await p.waitForTimeout(5000);

  const all = p.getByRole('button', { name: /All items/ }).first();
  check('All items sits under the scan button', (await all.count()) > 0);
  await all.click();
  await p.waitForTimeout(6000);
  await p.screenshot({ path: `${SHOTS}/1-all-items.png`, fullPage: true });
  let t = await text();
  check('the page says NOT A RECEIPT, large', /Not a receipt/i.test(t));
  check('and so does the paper', /NOT A RECEIPT/.test(t));
  check('with the item on it', t.includes(FIRST.name));
  check('with the order code', /Order [A-Z0-9]{4,}/.test(t), (t.match(/Order [A-Z0-9]{4,}/) ?? [''])[0]);
  for (const b of ['Share on WhatsApp', 'Share', 'Save as PDF', 'Print']) {
    check(`offers ${b}`, (await p.getByRole('button', { name: new RegExp(`^\\s*${b}\\s*$`) }).count()) > 0);
  }

  await p.goBack();
  await p.waitForTimeout(4000);

  console.log('\n— Take payment: open the line, change it —');
  const pay = p.getByRole('button', { name: /Take payment/ }).first();
  await pay.waitFor({ state: 'visible', timeout: 30000 });
  await pay.click();
  await p.waitForTimeout(7000);
  await p.screenshot({ path: `${SHOTS}/2-take-payment.png`, fullPage: true });
  t = await text();
  check('Take payment opens', /Recording for/.test(t));
  check('with All items, Add an item and Scan under what they are buying',
    (await p.getByRole('button', { name: /All items/ }).count()) > 0 &&
      (await p.getByRole('button', { name: /Add an item/ }).count()) > 0 &&
      (await p.getByRole('button', { name: /^\s*Scan\s*$/ }).count()) > 0);

  const lineBtn = p.getByRole('button', { name: `Change ${FIRST.name}` }).first();
  check('the line is a button', (await lineBtn.count()) > 0);
  await lineBtn.click();
  await p.waitForTimeout(5000);
  t = await text();
  check('it opens the sale-line page', /Change this line/.test(t));
  const more = p.getByRole('button', { name: `One more ${FIRST.name}` }).first();
  check("with the till's own stepper", (await more.count()) > 0);
  await more.click();
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${SHOTS}/3-line-page.png`, fullPage: true });
  await p.getByRole('button', { name: /^\s*Done\s*$/ }).first().click();
  await p.waitForTimeout(4000);
  t = await text();
  check('back on Take payment, the line says two', new RegExp(`${FIRST.name.replace(/[()]/g, '.')} 2 `).test(t),
    (t.match(/Chivita Active \(1L\) [^₦]*/) ?? [''])[0]);

  console.log('\n— Take payment: add another item —');
  await p.getByRole('button', { name: /Add an item/ }).first().click();
  await p.waitForTimeout(2000);
  await pick(SECOND);
  await p.waitForTimeout(6000);
  t = await text();
  check('picking pushes the sale-line page to add it', /Add to the sale/.test(t));
  await p.screenshot({ path: `${SHOTS}/4-add-line.png`, fullPage: true });
  await p.getByRole('button', { name: /^\s*Add to sale\s*$/ }).first().click();
  await p.waitForTimeout(4000);
  t = await text();
  check('back on Take payment, it is on the sale', t.includes(SECOND.name));
  await p.screenshot({ path: `${SHOTS}/5-after-add.png`, fullPage: true });

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await p.screenshot({ path: `${SHOTS}/last.png`, fullPage: true }).catch(() => {});
  await browser.close();
  await sweep().catch((e) => console.log('  could not sweep the drafts:', e.message));
  console.log(`\n  shots in ${SHOTS}`);
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
