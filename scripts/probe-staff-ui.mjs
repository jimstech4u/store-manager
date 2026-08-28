/**
 * Adding a staff member through the SCREENS, and the gate that meets them when they sign in.
 *
 * The route is proven elsewhere; this is the part a type-check cannot see — that the checklist
 * renders, that ticking a box changes what is sent, that the login is shown to the admin
 * afterwards (they have to read it out to somebody), and that the new person cannot get past the
 * password their admin chose for them.
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';

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

/*
 * `:visible` on EVERY selector below.
 *
 * Pushed-under pages stay mounted in a navigation stack, so a bare `input` selector finds the
 * team screen's fields sitting behind this form and types into those instead — leaving the
 * button disabled and the failure looking like the form is broken.
 */

/** React ignores a plain `fill` on a controlled input unless the event looks native. */
const type = async (locator, value) =>
  locator.evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);

const signIn = async (page, email, password) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await type(page.locator('input[type="email"]').first(), email);
  await type(page.locator('input[type="password"]').first(), password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(9000);
};

const stamp = Date.now().toString().slice(-6);
const firstName = `Tunde${stamp}`;
let staffEmail = null;
let staffUserId = null;

try {
  // ── The admin adds somebody ────────────────────────────────────────────────────────
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const body = () => page.locator('body').innerText();

  await signIn(page, env.SAMPLE_EMAIL, env.SAMPLE_PASSWORD);
  check('the owner is signed in', !page.url().includes('/login'), page.url().replace(/^https?:\/\/[^/]+/, ''));

  await page.getByRole('button', { name: 'More', exact: true }).first().click();
  await page.waitForTimeout(2400);
  await page.locator('button:visible').filter({ hasText: /your team|people who work here/i }).first().click();
  await page.waitForTimeout(2600);
  check('the team screen opens', /Your team/i.test(await body()));

  await page.getByRole('button', { name: /add.*(staff|someone|team)/i }).first().click();
  await page.waitForTimeout(2600);

  check('the add-someone form is a page', (await page.locator('[role="dialog"]:visible').count()) === 0);
  check('it asks for the person, not just an address', /First name/i.test(await body()));
  check('the permission checklist is on it', /Selling|Running the shop/i.test(await body()));
  await page.screenshot({ path: 'shots/staff-form-top.png', fullPage: true });

  await type(page.locator('input:visible').nth(0), firstName);
  await page.waitForTimeout(800);

  // The address is previewed before anything is created, because the admin has to be able to
  // tell somebody what it will be.
  check('the login address is previewed as they type', /@ashabiglobal\.sm/i.test(await body()),
    (await body()).match(/[a-z0-9.]+@ashabiglobal\.sm/i)?.[0] ?? 'not shown');

  const boxes = page.locator('input[type="checkbox"]:visible');
  const tickedBefore = await boxes.evaluateAll((els) => els.filter((e) => e.checked).length);
  check('the chosen role pre-ticks a starting set', tickedBefore > 0, `${tickedBefore} ticked`);

  // Tick one the role does not give, and confirm the screen says it was changed by hand.
  const reports = page.locator('label:has(input[type="checkbox"])').filter({ hasText: /View reports/i }).first();
  await reports.locator('input').check();
  await page.waitForTimeout(600);
  check('a hand-ticked box is marked as added for this person', /added for this person/i.test(await body()));

  await type(page.locator('input[type="password"]:visible').first(), 'Sample@12345');
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'shots/staff-form-filled.png', fullPage: true });

  await page.getByRole('button', { name: /create their login/i }).click();
  await page.waitForTimeout(9000);

  const after = await body();
  check(
    'the result is a sheet, not another page',
    (await page.locator('[role="dialog"]:visible').count()) === 1,
  );
  check(
    'and the form is still behind it for the next person',
    /First name/i.test(after),
  );
  check('the admin is shown the login to read out', /@ashabiglobal\.sm/i.test(after));
  staffEmail = after.match(/[a-z0-9.]+@ashabiglobal\.sm/i)?.[0] ?? null;
  check('and told the person must pick their own password', /own password/i.test(after));
  await page.screenshot({ path: 'shots/staff-created.png' });

  // ── What that produced, in the database ────────────────────────────────────────────
  const { data: member } = await admin
    .from('store_members')
    .select('user_id, first_name, must_change_password')
    .eq('login_email', staffEmail)
    .single();
  staffUserId = member?.user_id ?? null;
  check('the member exists with the name that was typed', member?.first_name === firstName, member?.first_name);

  const { data: perms } = await admin
    .from('store_member_permissions')
    .select('permission_code, granted')
    .eq('user_id', staffUserId);
  const granted = (perms ?? []).filter((r) => r.granted).map((r) => r.permission_code);
  check('the hand-ticked permission was saved', granted.includes('reports.view'), granted.join(', '));

  check('no page errors adding them', errors.length === 0, errors.join(' | '));

  // ── The new person signs in and is stopped ─────────────────────────────────────────
  const staffPage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const staffErrors = [];
  staffPage.on('pageerror', (e) => staffErrors.push(e.message));

  await signIn(staffPage, staffEmail, 'Sample@12345');
  const staffBody = await staffPage.locator('body').innerText();

  check('a staff login on an admin-set password is stopped', /Choose your own password/i.test(staffBody));
  check('and it explains why', /known to whoever set it up/i.test(staffBody));
  check('with no way past it but changing the password',
    !/Sell|Stock|Count/.test(staffBody), 'the app is not reachable behind it');
  await staffPage.screenshot({ path: 'shots/staff-must-change.png' });

  // Changing it lets them through, and clears the flag for good.
  const pwFields = staffPage.locator('input[type="password"]:visible');
  await type(pwFields.nth(0), 'Chosen@98765');
  await type(pwFields.nth(1), 'Chosen@98765');
  await staffPage.getByRole('button', { name: /save and continue/i }).click();
  await staffPage.waitForTimeout(9000);

  check('choosing a password lets them into the app',
    !/Choose your own password/i.test(await staffPage.locator('body').innerText()));
  await staffPage.screenshot({ path: 'shots/staff-after-change.png' });

  const { data: afterChange } = await admin
    .from('store_members')
    .select('must_change_password')
    .eq('user_id', staffUserId)
    .single();
  check('the flag is cleared in the database', afterChange?.must_change_password === false);

  check('no page errors for the staff member', staffErrors.length === 0, staffErrors.join(' | '));
} finally {
  await browser.close();
  if (staffUserId) {
    await admin.auth.admin.deleteUser(staffUserId);
    console.log(`  (cleaned up ${staffEmail})`);
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
