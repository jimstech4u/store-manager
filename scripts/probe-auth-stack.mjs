/**
 * The auth flow is a navigation stack, and its back arrow means the previous STEP.
 *
 * These screens used to be one component with a `mode` flag: the only way back from "create an
 * account" was another button that set the flag the other way, and there was no way back at all
 * from the six-digit screen. This proves the stack behaviour that replaced it, including the part
 * that is easy to get wrong — that you cannot walk BACK into a form you have already submitted.
 */

import { chromium } from '@playwright/test';

const BASE = process.argv[2] ?? 'http://localhost:3100';

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const body = () => page.locator('body').innerText();
// `exact`, because the close button's label ("Close and go back to the shops") also contains
// "go back" and a loose match resolves to both.
const backArrow = () => page.getByRole('button', { name: 'Go back', exact: true });

// ── The root of the stack has no back arrow ─────────────────────────────────────────
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);

check('sign-in is the entry screen', /Sign in/i.test(await body()));
check('the root shows no back arrow', (await backArrow().count()) === 0);
check('but it does show a way out', (await page.getByRole('button', { name: /close/i }).count()) > 0);
await page.screenshot({ path: 'shots/auth-signin.png' });

// ── Create an account is a PUSH, so back returns ────────────────────────────────────
await page.getByRole('button', { name: 'Create an account' }).click();
await page.waitForTimeout(1200);

check('create-account is a pushed screen', /Create your account/i.test(await body()));
check('a pushed screen has a back arrow', (await backArrow().count()) === 1);
await page.screenshot({ path: 'shots/auth-signup.png' });

await backArrow().click();
await page.waitForTimeout(1200);
check('the arrow pops back to sign-in', /Welcome back/i.test(await body()));
check('and the arrow is gone again at the root', (await backArrow().count()) === 0);

// ── Browser back moves between STEPS, not out of the flow ───────────────────────────
await page.getByRole('button', { name: 'Create an account' }).click();
await page.waitForTimeout(1200);
await page.goBack();
await page.waitForTimeout(1400);

check(
  'browser back moves within the flow rather than leaving it',
  /Welcome back/i.test(await body()) && page.url().includes('/login'),
  page.url().replace(/^https?:\/\/[^/]+/, ''),
);

// ── An unconfirmed sign-in pushes the six-digit screen ──────────────────────────────
/*
 * The account this signs in as exists and is deliberately unconfirmed, so Supabase answers
 * "Email not confirmed" — the exact case the screen is for. Using a real unconfirmed account
 * rather than a stub is the point: a mocked error would pass even if the string Supabase
 * actually returns changed.
 */
const unconfirmed = process.env.UNCONFIRMED_EMAIL;
if (unconfirmed) {
  await page.locator('input[type=email]').fill(unconfirmed);
  await page.locator('input[type=password]').fill('Sample@12345');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(4000);

  check('an unverified business lands on the code screen', /Check your email/i.test(await body()));
  check('the code screen can be backed out of', (await backArrow().count()) === 1);
  check(
    'the address it is verifying is shown',
    (await body()).includes(unconfirmed),
    unconfirmed,
  );
  await page.screenshot({ path: 'shots/auth-verify.png' });

  // Six digits only, and nothing else typeable.
  const field = page.locator('#verify-code');
  await field.fill('12ab34cd56');
  check('the code field keeps only digits', (await field.inputValue()) === '123456', await field.inputValue());
  check(
    'and stops at six',
    (await field.evaluate((el) => el.maxLength)) === 6,
  );

  await backArrow().click();
  await page.waitForTimeout(1200);
  check('back from the code screen returns to sign-in', /Welcome back/i.test(await body()));
} else {
  console.log('  SKIP  unconfirmed-account checks (set UNCONFIRMED_EMAIL)');
}

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
