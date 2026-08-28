/**
 * The six-digit flow, end to end, against the real Supabase project.
 *
 * A REAL unconfirmed account, the REAL "Email not confirmed" refusal, and a REAL token from
 * Supabase's own generator — verified through the actual UI. The only thing not exercised is
 * Brevo carrying the mail, and that is deliberate: `generateLink` returns the same six digits the
 * email would have contained, so the flow can be proven without posting to anybody's inbox.
 *
 * Cleans up after itself. A stray unconfirmed account is the sort of thing that sits in a project
 * for a year and then confuses somebody debugging sign-up.
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

// A throwaway address on a domain that exists but goes nowhere useful.
const email = `probe.otp.${Date.now()}@example.com`;
const password = 'Sample@12345';
let userId = null;

try {
  // ── A genuinely unconfirmed account ────────────────────────────────────────────────
  const { data: made, error: makeError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: false,
  });
  if (makeError) throw makeError;
  userId = made.user.id;
  check('an unconfirmed account exists to test against', !made.user.email_confirmed_at);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const body = () => page.locator('body').innerText();

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // ── Signing in unconfirmed lands on the code screen ────────────────────────────────
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(5000);

  check('an unverified business is sent to the code screen', /Check your email/i.test(await body()));
  check('and it names the address being verified', (await body()).includes(email));
  check(
    'the code screen can be backed out of',
    (await page.getByRole('button', { name: 'Go back', exact: true }).count()) === 1,
  );
  await page.screenshot({ path: 'shots/otp-live-screen.png' });

  /*
   * Pasting something with stray characters keeps the DIGITS, not the first six characters.
   *
   * A `maxLength` here clipped the raw text first, so "12ab34cd56" became "12ab34" and then
   * "1234" — a code silently missing two digits, which is the worst possible way to fail.
   */
  const field = page.locator('#verify-code');
  await field.fill('12ab34cd56789');
  check('a pasted code keeps its digits, not its first six characters',
    (await field.inputValue()) === '123456', await field.inputValue());

  // ── A wrong code is refused, and says so usefully ──────────────────────────────────
  await field.fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForTimeout(4000);
  check('a wrong code is refused', /did not work|expired/i.test(await body()));
  check('and it stays on the code screen', /Check your email/i.test(await body()));

  // ── The real six digits, from Supabase's own generator ─────────────────────────────
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'signup',
    email,
    password,
  });
  if (linkError) throw linkError;
  const otp = link.properties?.email_otp;
  check('Supabase issues a six-digit code', /^[0-9]{6}$/.test(otp ?? ''), otp);

  await field.fill(otp);
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForTimeout(7000);

  check(
    'the right code verifies and leaves the auth flow',
    !page.url().includes('/login'),
    page.url().replace(/^https?:\/\/[^/]+/, ''),
  );
  await page.screenshot({ path: 'shots/otp-live-after.png' });

  // ── And the account really is confirmed now, in the database ───────────────────────
  const { data: after } = await admin.auth.admin.getUserById(userId);
  check('the account is confirmed in the database', Boolean(after.user?.email_confirmed_at),
    after.user?.email_confirmed_at ?? 'still null');

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
} finally {
  if (userId) {
    await admin.auth.admin.deleteUser(userId);
    console.log(`  (cleaned up ${email})`);
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
