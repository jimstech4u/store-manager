/**
 * "Make a new group" — the press that did nothing.
 *
 * The handler behind it opened `if (!storeId || !typed.trim()) return;`, and the sheet OPENS with
 * an empty search box, so the commonest press of it — open the picker, press the one thing offering
 * to add something — returned immediately. No group, no page, no error, and an empty catch behind
 * it in case the call it never made had failed.
 *
 * It is a pushed form now, the way "Add a unit you use" has always been. Driven both ways round,
 * because the two are genuinely different journeys: nothing typed, and a name typed that matches
 * nothing.
 *
 *     node scripts/probe-make-a-group.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS = 'shots/make-a-group';
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
const TYPED = `ZGrp${stamp}`;
const NAMED = `ZNamed${stamp}`;

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

const openPicker = async () => {
  await p.getByRole('button', { name: /Add a group|group/i }).first().click();
  await p.waitForTimeout(2500);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  // Waited FOR, not waited out: the nav bar appearing is what "signed in" means, and a cold dev
  // server compiles /main for longer than any fixed number worth writing down.
  await p.locator('.nav-item').first().waitFor({ state: 'visible', timeout: 180000 });
  await p.waitForTimeout(3000);

  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(800);
  await p
    .locator('.nav-item')
    .filter({ hasText: /^Stock$/ })
    .first()
    .click();
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: /add an item|add what you sell/i }).first().click();
  await p.waitForTimeout(4000);
  await p.getByLabel(/What is it called/i).fill(`ZZ Group Walk ${stamp}`);
  await p.waitForTimeout(400);

  // ── Nothing typed: the press that used to do nothing ───────────────────────────────
  console.log('\n— pressed with an empty search box —');
  await openPicker();
  await shot('picker-open');

  const make = p.getByRole('button', { name: 'Make a new group', exact: true });
  check('the sheet offers it before anything is typed', (await make.count()) > 0);

  await make.first().click();
  await p.waitForTimeout(3500);
  await shot('form-open');

  const onForm = await p.locator('body').innerText();
  check(
    'pressing it opens the form instead of doing nothing',
    /What is the group called/i.test(onForm),
    onForm.split('\n').filter(Boolean).slice(0, 2).join(' | ').slice(0, 70),
  );
  check('and the form says what a group is for', /empties work|whoever made/i.test(onForm));

  await p.getByLabel(/What is the group called/i).fill(NAMED);
  await p.waitForTimeout(400);
  await shot('form-filled');

  await p.getByRole('button', { name: 'Make it', exact: true }).first().click();
  await p.waitForTimeout(6000);
  await shot('back-on-the-form');

  const back = await p.locator('body').innerText();
  check('it comes back to the product form', /What is it called/i.test(back));
  check(
    'and the new group is already ticked, not merely present',
    back.includes(NAMED),
    back.replace(/\s+/g, ' ').slice(0, 90),
  );

  // ── A name typed that matches nothing ──────────────────────────────────────────────
  console.log('\n— typed a name that matches nothing —');
  await openPicker();
  const box = p.getByPlaceholder(/Nigerian Breweries/i).first();
  await box.click();
  await p.waitForTimeout(400);
  await box.pressSequentially(TYPED, { delay: 40 });
  await p.waitForTimeout(2500);
  await shot('typed-no-match');

  const makeTyped = p.getByRole('button', { name: `Make "${TYPED}"` });
  check('the button offers to make what was typed', (await makeTyped.count()) > 0);

  await makeTyped.first().click();
  await p.waitForTimeout(3500);
  await shot('form-prefilled');

  check(
    'and the form arrives with that name already in it',
    (await p.getByLabel(/What is the group called/i).inputValue()) === TYPED,
  );

  await p.getByRole('button', { name: 'Make it', exact: true }).first().click();
  await p.waitForTimeout(6000);
  await shot('both-groups');

  const endText = await p.locator('body').innerText();
  check('both groups are on the item', endText.includes(NAMED) && endText.includes(TYPED));

  // ── What reached the shop ──────────────────────────────────────────────────────────
  console.log('\n— what reached the database —');
  const { data: made } = await admin
    .from('product_categories')
    .select('name')
    .eq('store_id', storeId)
    .in('name', [NAMED, TYPED]);
  check('both groups exist in the shop', (made ?? []).length === 2, `${(made ?? []).length} of 2`);

  console.log('\n— page errors —');
  check('no uncaught error', errors.length === 0, errors.join(' / '));
} catch (e) {
  console.log(`\n  FAIL  the walk did not finish — ${String(e).split('\n')[0]}`);
  await shot('where-it-stopped');
  failed += 1;
} finally {
  await browser.close();
  /*
   * The product was never saved — nothing was pressed that saves it — so only the two groups need
   * removing. Archived rather than deleted where a row refuses to go, and what is LEFT is read back
   * and said rather than assumed.
   */
  for (const name of [NAMED, TYPED]) {
    const { error } = await admin
      .from('product_categories')
      .delete()
      .eq('store_id', storeId)
      .eq('name', name);
    if (error) {
      await admin
        .from('product_categories')
        .update({ status: 'archived' })
        .eq('store_id', storeId)
        .eq('name', name);
    }
  }
  const { data: left } = await admin
    .from('product_categories')
    .select('name,status')
    .eq('store_id', storeId)
    .in('name', [NAMED, TYPED]);
  console.log(
    `\nleft behind: ${(left ?? []).filter((r) => r.status !== 'archived').length} group(s) still offered`,
  );
  console.log(`${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}
