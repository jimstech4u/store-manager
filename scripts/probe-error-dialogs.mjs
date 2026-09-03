/**
 * A failure interrupts.
 *
 * Twenty-odd screens moved their failure message off the page and into a dialog. The claim is not
 * "the code compiles" — it is that when something actually fails, the shop is stopped and told,
 * instead of a panel appearing above the fold on a screen whose keyboard is open.
 *
 * So this makes real things fail, at the counter, and looks.
 *
 *     node scripts/probe-error-dialogs.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/error-dialogs';
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

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

/** The dialog-viewer's own surface, asked of the DOM rather than of the text. */
const dialog = () => p.locator('[class*="dialog"]:visible, [role="alertdialog"]:visible').first();

const tab = async (label) => {
  await p.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll('div')) {
      if (el.scrollHeight > el.clientHeight + 40) el.scrollTop = 0;
    }
  });
  await p.waitForTimeout(700);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(3500);
};

try {
  // ══ 1. A sign-in that genuinely fails ═════════════════════════════════════════════
  console.log('\n— a wrong password, which is a failure —');
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill('definitely-not-the-password');
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(6000);
  await p.screenshot({ path: `${SHOTS}/1-wrong-password.png` });

  check('the failure stops the shop in a dialog', (await dialog().count()) > 0, await body().then((t) => t.slice(0, 90)));
  /*
   * ANY real reason, not one exact sentence.
   *
   * This probe signs in with a deliberately wrong password, and run often enough Supabase stops
   * saying "invalid credentials" and starts saying "too many requests" — which is a different and
   * equally true failure a shop can meet. Asserting the credentials wording made the probe fail
   * for a reason that had nothing to do with the dialog, which is the thing under test.
   */
  const said = await body();
  check(
    'and says what went wrong',
    /do not match|Could not sign|too many|rate|try again/i.test(said),
    said.slice(0, 90),
  );

  const ok = p.getByRole('button', { name: /^OK$/ }).first();
  check('with one way out', (await ok.count()) > 0);
  if (await ok.count()) {
    await ok.click();
    await p.waitForTimeout(1200);
    check('which dismisses it', (await dialog().count()) === 0);
    check('and does not leave an overlay swallowing taps', await p.locator('input[type="password"]').first().isEditable());
  }

  // ══ 2. A missing field, which is NOT a failure ════════════════════════════════════
  console.log('\n— an empty field, which is a condition —');
  await p.locator('input[type="email"]').first().fill('');
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(2000);
  await p.screenshot({ path: `${SHOTS}/2-empty-field.png` });

  check(
    'stays on the page, beside the field being fixed',
    (await dialog().count()) === 0 && /Enter your email/i.test(await body()),
    await body().then((t) => (/Enter your email/i.test(t) ? 'shown inline' : t.slice(0, 80))),
  );

  // ══ 3. Signed in, then a real save failure at the counter ═════════════════════════
  console.log('\n— a save that the server refuses —');
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  await tab('People');
  const add = p.getByRole('button', { name: /add|new/i }).first();
  await add.click();
  await p.waitForTimeout(3500);

  const NAME = `ZZ Dialog ${Date.now().toString().slice(-5)}`;
  await p.getByLabel(/Their name/i).fill(NAME);
  await p.getByLabel(/Phone/i).first().fill('08099999999');
  await p.waitForTimeout(400);

  /*
   * THE SERVER REFUSES, BECAUSE WE MAKE IT.
   *
   * A first version typed a one-digit phone number expecting the database to reject it. It did
   * not — the save succeeded and left a junk customer in the shop's real list, and the probe
   * reported the dialog missing when the dialog had simply never been asked for. A test that
   * depends on guessing which inputs a server dislikes is testing the guess.
   *
   * Failing the request itself is the honest way to ask "what does this screen do when a save
   * fails", and it works whatever the validation rules turn out to be.
   */
  await p.route('**/rest/v1/rpc/upsert_customer*', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'The shop could not be reached. Try again.' }),
    }),
  );

  const save = p.getByRole('button', { name: /save|add/i }).last();
  await save.scrollIntoViewIfNeeded();
  await save.click();
  await p.waitForTimeout(6000);
  await p.screenshot({ path: `${SHOTS}/3-save-refused.png` });

  const sawDialog = (await dialog().count()) > 0;
  check('a refused save interrupts rather than sitting on the page', sawDialog, await body().then((t) => t.slice(0, 100)));
  if (sawDialog) {
    check('titled as a failure to save', /Not saved/i.test(await body()));
    check('carrying what the server said', /could not be reached/i.test(await body()));
    await p.getByRole('button', { name: /^OK$/ }).first().click();
    await p.waitForTimeout(1200);
    check('and the form is still filled in behind it', (await p.getByLabel(/Their name/i).inputValue()) === NAME);
    check('so the shop can try again without retyping', (await dialog().count()) === 0);
  }
  await p.unroute('**/rest/v1/rpc/upsert_customer*');

  // ══ 4. A condition that must NOT have become dismissible ══════════════════════════
  console.log('\n— a condition that must stay on the page —');
  await tab('Stock');
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${SHOTS}/4-conditions.png` });
  check(
    'the units warning is still a panel, not a dialog',
    (await dialog().count()) === 0,
    'nothing should be interrupting on arrival',
  );

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
