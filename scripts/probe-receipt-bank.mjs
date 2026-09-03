/**
 * The receipt prints an account the shop actually banks into.
 *
 * «the receipt uses a stale account details that is in setting-page, but the design was to use the
 *  list of banks we add, that we can also add new banks or select»
 *
 * Two places held bank details and only one of them was real. This walks the settings screen and
 * checks the second one is GONE — not merely unused, which is the state that lets a shop keep
 * typing into a box that changes nothing — that the accounts list is what is offered, that adding
 * one is a PUSHED PAGE, that choosing one sticks across a save and a reload, and that the receipt
 * PREVIEW shows the same account the receipt will print rather than the retired columns.
 *
 * WRITES an account, and archives it again through `archive_bank_account` — the shop's own way of
 * retiring one, since a probe must not leave a bank account sitting in a real shop's list.
 *
 *     node scripts/probe-receipt-bank.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/receipt-bank';
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

const listAccounts = async () =>
  (await shop.rpc('list_bank_accounts', { p_store_id: storeId })).data ?? [];

const before = await listAccounts();
const BANK = 'Zenith Bank';
const NUMBER = String(2_000_000_000 + Math.floor(Math.random() * 899_999_999));
const HOLDER = 'Probe Receipt Account';

/** Restore whatever the settings screen said before this run touched it. */
const settingsBefore = (
  await shop
    .from('store_settings')
    .select('receipt_bank_account_id, show_transfer_details')
    .eq('store_id', storeId)
    .maybeSingle()
).data;

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

const openSettings = async () => {
  await p.locator('.nav-item').filter({ hasText: /^More$|^Settings$/ }).first().click();
  await p.waitForTimeout(3000);
  const entry = p.getByRole('button', { name: /Receipts?|Printing|Settings/i }).first();
  if ((await entry.count()) > 0) {
    await entry.click();
    await p.waitForTimeout(3000);
  }
};

const scrollToBank = async () => {
  for (let i = 0; i < 14; i += 1) {
    if (/Bank details on receipts/i.test(await body())) {
      await p.getByText('Bank details on receipts').first().scrollIntoViewIfNeeded();
      await p.waitForTimeout(600);
      return true;
    }
    await p.mouse.wheel(0, 700);
    await p.waitForTimeout(350);
  }
  return false;
};

let createdId = null;

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ══ The second copy is gone ═══════════════════════════════════════════════════════
  console.log('— the settings screen —');
  await openSettings();
  const reached = await scrollToBank();
  check('the receipt settings are reachable', reached, p.url().slice(0, 80));
  await p.screenshot({ path: `${SHOTS}/1-settings.png` });

  const settings = await body();
  /*
   * By PLACEHOLDER, not by label text. The section still has the words "Bank" and "Account name" in
   * it — they are what the list shows — so asserting on visible text would pass with the boxes
   * still there. The placeholders belonged to the inputs and to nothing else.
   */
  const typedBank = await p.getByPlaceholder('Access Bank').count();
  const typedNo = await p.getByPlaceholder('0123456789').count();
  check(
    'no second set of bank boxes to type into',
    typedBank === 0 && typedNo === 0,
    `${typedBank + typedNo} field(s) still there`,
  );
  check(
    'it says where the details come from instead',
    /No accounts yet|Add another account|Add a bank account/i.test(settings),
    settings.slice(0, 60),
  );

  // ══ Adding one is a pushed page ═══════════════════════════════════════════════════
  console.log('\n— adding an account —');
  const addBtn = p
    .getByRole('button', { name: /^Add a bank account$|^Add another account$/ })
    .first();
  check('the screen offers to add one', (await addBtn.count()) > 0);
  await addBtn.click();
  await p.waitForTimeout(3500);
  await p.screenshot({ path: `${SHOTS}/2-form.png` });

  check(
    'the form is a PAGE, not a sheet',
    (await p.getByRole('button', { name: 'Go back' }).count()) > 0 &&
      (await p.getByPlaceholder('0123456789').count()) > 0,
    'a form that records where money goes has to survive a rotation',
  );

  await p.getByPlaceholder('0123456789').first().fill(NUMBER);
  await p.getByPlaceholder('Access Bank').first().fill(BANK);
  await p.getByPlaceholder('The name the bank shows').first().fill(HOLDER);
  await p.waitForTimeout(500);
  await p.getByRole('button', { name: /^Save|^Add/ }).first().click();
  await p.waitForTimeout(5000);
  await p.screenshot({ path: `${SHOTS}/3-saved.png` });

  const after = await listAccounts();
  const made = after.find((a) => !before.some((b) => b.id === a.id));
  check('the account was saved', Boolean(made), made ? `${made.bank_name} ${made.account_number}` : '');
  if (made) createdId = made.id;

  // ══ It is offered, and choosing it sticks ═════════════════════════════════════════
  console.log('\n— choosing which one prints —');
  await scrollToBank();
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${SHOTS}/4-listed.png` });

  const listed = await body();
  check('the new account is listed to choose from', listed.includes(NUMBER), NUMBER);

  const row = p.getByRole('button', { name: new RegExp(NUMBER) }).first();
  if ((await row.count()) > 0) {
    await row.click();
    await p.waitForTimeout(1200);
    check('choosing it marks it chosen', (await row.getAttribute('aria-pressed')) === 'true');
  } else {
    check('choosing it marks it chosen', false, 'no row to press');
  }

  // ══ The preview shows what will actually print ════════════════════════════════════
  console.log('\n— what the receipt will say —');
  for (let i = 0; i < 10; i += 1) {
    if (/Bank details on receipts/i.test(await body())) break;
    await p.mouse.wheel(0, -600);
    await p.waitForTimeout(250);
  }
  await p.mouse.wheel(0, -900);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${SHOTS}/5-preview.png` });

  const previewText = await body();
  check(
    'the preview prints the chosen account, not a blank',
    previewText.includes(NUMBER),
    'it read the retired text columns before, so it showed nothing',
  );

  // ══ Saved, and still there after a reload ═════════════════════════════════════════
  console.log('\n— and it stays chosen —');
  const saveAction = p.getByRole('button', { name: /Save settings/i }).first();
  check('there is a way to save', (await saveAction.count()) > 0);
  await saveAction.click();
  await p.waitForTimeout(5000);

  const stored = (
    await shop
      .from('store_settings')
      .select('receipt_bank_account_id')
      .eq('store_id', storeId)
      .maybeSingle()
  ).data;
  check(
    'the shop’s choice reached the database',
    stored?.receipt_bank_account_id === createdId,
    `${stored?.receipt_bank_account_id ?? 'null'}`,
  );

  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(9000);
  await openSettings();
  await scrollToBank();
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${SHOTS}/6-after-reload.png` });
  const reloaded = await body();
  check('and survives a reload', reloaded.includes(NUMBER));

  check('no page errors along the way', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();

  // ══ Put the shop back ═════════════════════════════════════════════════════════════
  console.log('\n— tidying up —');
  const restore = await shop
    .from('store_settings')
    .update({
      receipt_bank_account_id: settingsBefore?.receipt_bank_account_id ?? null,
      show_transfer_details: settingsBefore?.show_transfer_details ?? true,
    })
    .eq('store_id', storeId);
  console.log(`  ${restore.error ? 'FAIL' : 'ok'}  settings restored${restore.error ? ` — ${restore.error.message}` : ''}`);

  if (createdId) {
    const { error } = await shop.rpc('archive_bank_account', { p_id: createdId });
    console.log(`  ${error ? 'FAIL' : 'ok'}  probe account retired${error ? ` — ${error.message}` : ''}`);
    if (error) failed += 1;
    const left = await listAccounts();
    if (left.some((a) => a.id === createdId)) {
      console.log('  FAIL  it is still in the shop’s list');
      failed += 1;
    }
  }
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
