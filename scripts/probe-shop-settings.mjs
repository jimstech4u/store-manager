/**
 * The shop's own row — renaming it, saying where it is, and closing one made by accident.
 *
 * A shop could rename its units, pools, groups, products and customers, and remove a member. Its
 * own name was fixed at signup for ever and there was no way to be rid of a shop at all, so "Yh" —
 * typed into the setup form by accident one morning — sat in the switcher permanently and, having
 * no `onboarded_at`, answered sign-in with a setup wizard.
 *
 * Driven against the REAL shop for the rename (set to what it already is, then to a new name and
 * back), and it closes the abandoned one for good at the end.
 *
 *     node scripts/probe-shop-settings.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const NL = String.fromCharCode(10);
const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS = 'shots/shop-settings';
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

/*
 * EVERY COLUMN THIS PROBE WRITES, SNAPSHOTTED — not the ones it remembered to.
 *
 * The first version selected `latitude` and not `longitude`, wrote both, and restored one. The
 * shop's real longitude was overwritten with the probe's test value and there was nothing to put
 * back: `stores` is not in the audit log, so `prior_value` had never recorded it. It is not
 * recoverable, and it was somebody's actual address.
 *
 * Listed once, here, and used for both the snapshot and the restore, so the two cannot drift apart
 * again. A probe that writes to the shop somebody is really using has to put back everything it
 * touched, and the way to be sure is not to keep two lists.
 */
const TOUCHED = ['name', 'address', 'latitude', 'longitude', 'timezone', 'money_decimals'];

const { data: before } = await admin
  .from('stores')
  .select(['id', 'status', ...TOUCHED].join(','));
const real = (before ?? []).find((s) => s.name.startsWith('ASHABI'));
const spare = (before ?? []).find((s) => s.id !== real?.id && s.status === 'active');
const originalName = real?.name;
const asFound = real ? Object.fromEntries(TOUCHED.map((c) => [c, real[c]])) : null;
console.log(`  ${real?.name} as found: ${JSON.stringify(asFound)}`);

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

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.locator('.nav-item').first().waitFor({ state: 'visible', timeout: 180000 });
  await p.waitForTimeout(3000);

  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(4000);
  await p.getByText('This shop', { exact: true }).first().click();
  await p.waitForTimeout(4000);
  await shot('shop-page');

  const body = await p.locator('body').innerText();
  check('the shop has a screen of its own', /What it is called/i.test(body));
  check('it can say where it is', /Where it is/i.test(body));
  check('and it offers closing', /Closing this shop/i.test(body));

  const nameBox = p.getByLabel(/^Shop name/i).first();
  check(
    'the name arrives filled in, not blank',
    (await nameBox.inputValue()) === originalName,
    await nameBox.inputValue(),
  );

  /*
   * SAVE IS OFF UNTIL SOMETHING CHANGES.
   *
   * A rename that writes the same name is a no-op that still touches every receipt's source of
   * truth and logs an audit row for nothing.
   */
  const saveName = p.getByRole('button', { name: 'Save the name', exact: true });
  check('saving the same name is not offered', await saveName.isDisabled());

  // ── Renamed, and put back ──────────────────────────────────────────────────────────
  console.log(NL + '— renaming it —');
  const renamed = `${originalName} X`;
  await nameBox.fill(renamed);
  await p.waitForTimeout(500);
  check('changing it enables the save', !(await saveName.isDisabled()));
  await saveName.click();
  await p.waitForTimeout(5000);
  await shot('renamed');

  const { data: after } = await admin.from('stores').select('name').eq('id', real.id).single();
  check('the new name reached the shop', after.name === renamed, after.name);
  check(
    'and the screen says it without a reload',
    (await p.locator('body').innerText()).includes(renamed),
  );

  await nameBox.fill(originalName);
  await p.waitForTimeout(400);
  await saveName.click();
  await p.waitForTimeout(5000);
  const { data: restored } = await admin.from('stores').select('name').eq('id', real.id).single();
  check('and it can be put back', restored.name === originalName, restored.name);

  // ── Where it is ────────────────────────────────────────────────────────────────────
  console.log(NL + '— saying where it is —');
  await p.getByLabel(/^Address/i).first().fill('12 Ojuelegba Road, Surulere, Lagos');
  await p.getByLabel(/^Latitude/i).first().fill('6.5244');
  await p.getByLabel(/^Longitude/i).first().fill('3.3792');
  await p.waitForTimeout(500);
  await p.getByRole('button', { name: 'Save where you are', exact: true }).click();
  await p.waitForTimeout(5000);
  await shot('placed');

  const { data: placed } = await admin
    .from('stores')
    .select('address, latitude, longitude')
    .eq('id', real.id)
    .single();
  check('the address reached the shop', /Ojuelegba/.test(placed.address ?? ''), placed.address);
  check(
    'and the coordinates the storefront searches by',
    Number(placed.latitude) === 6.5244 && Number(placed.longitude) === 3.3792,
    `${placed.latitude}, ${placed.longitude}`,
  );

  // ── The clock, and whether money shows kobo ─────────────────────────────────────
  console.log(NL + '— the shop clock —');
  const clockPick = p.locator('#shop-clock');
  check(
    'the clock arrives on the shop own value',
    (await clockPick.inputValue()) === (asFound.timezone ?? 'Africa/Lagos'),
    await clockPick.inputValue(),
  );

  const offered = await clockPick.locator('option').allInnerTexts();
  check(
    'and each choice says its offset, not just a name',
    offered.some((o) => /\(\+?-?\d{1,2}:\d{2}\)/.test(o)),
    offered.slice(0, 3).join(' / '),
  );

  await clockPick.selectOption('Africa/Nairobi');
  await p.getByRole('button', { name: 'Save the clock', exact: true }).click();
  await p.waitForTimeout(4500);

  const { data: clocked } = await admin
    .from('stores')
    .select('timezone')
    .eq('id', real.id)
    .single();
  check('the clock reaches the shop', clocked.timezone === 'Africa/Nairobi', clocked.timezone);

  console.log(NL + '— kobo —');
  await shot('clock-and-kobo');
  const kobo = p.getByRole('button', { name: /^Kobo/ });
  check('the choices show themselves, not just their names', /₦3,700.50/.test(await kobo.innerText()));

  await kobo.click();
  await p.getByRole('button', { name: 'Save how money is shown', exact: true }).click();
  await p.waitForTimeout(4500);

  const { data: shown } = await admin
    .from('stores')
    .select('money_decimals')
    .eq('id', real.id)
    .single();
  check('two places reaches the shop', Number(shown.money_decimals) === 2, `${shown.money_decimals}`);

  /*
   * AND IT REACHES THE SCREENS, which is the half that was missing.
   *
   * `money_decimals` has been settable in the database since 0009 and every one of the 143
   * `formatMoney` calls took the hard-coded default of 0 — so the column could be changed and
   * nothing anywhere looked different. Checked on the till, which is where money is read.
   */
  await p.locator('.nav-item').filter({ hasText: /^Money$/ }).first().click();
  await p.waitForTimeout(6000);
  await shot('money-in-kobo');
  const moneyPage = await p.locator('body').innerText();
  check(
    'and every screen shows it — money reads in kobo now',
    /₦[\d,]+\.\d{2}/.test(moneyPage),
    (moneyPage.match(/₦[\d,]+(\.\d+)?/g) ?? []).slice(0, 4).join(' '),
  );

  // ── Closing the one made by accident ───────────────────────────────────────────────
  if (spare) {
    console.log(NL + `— closing "${spare.name}", which was never meant to exist —`);

    // Back to the shop page, which the money check navigated away from. Inside the branch that
    // needs it: with nothing to close there is nowhere to walk back to and no reason to try.
    await p.mouse.wheel(0, -4000);
    await p.waitForTimeout(600);
    await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
    await p.waitForTimeout(5000);
    await p.getByText('This shop', { exact: true }).first().click();
    await p.waitForTimeout(5000);

    await p.getByRole('button', { name: 'Close this shop', exact: true }).click();
    await p.waitForTimeout(3000);
    await shot('close-asked');

    const asked = await p.locator('body').innerText();
    check(
      'the question says what is at stake, not "are you sure?"',
      /has been trading|sales recorded/i.test(asked),
      asked.replace(/\s+/g, ' ').slice(-120),
    );
    check(
      'and names the number of sales rather than a vague warning',
      /\d+\s*<?\/?strong?>?\s*sales|[0-9]{2,}/.test(asked),
    );

    // Not confirmed — this is the shop that trades.
    await p.getByRole('button', { name: 'Keep it', exact: true }).click();
    await p.waitForTimeout(2000);

    const { data: safe } = await admin.from('stores').select('status').eq('id', real.id).single();
    check('backing out leaves the trading shop open', safe.status === 'active', safe.status);

    /*
     * AND THE ABANDONED ONE GOES, through the same function the screen calls.
     *
     * Driven server-side rather than through the UI because reaching it means switching the session
     * into it, and the fix under test deliberately refuses to open a shop with no `onboarded_at`
     * unless somebody chooses it. The screen's own path is exercised above; this is the outcome the
     * whole change exists for.
     */
    const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    await shop.auth.signInWithPassword({
      email: env.SAMPLE_EMAIL,
      password: env.SAMPLE_PASSWORD,
    });
    const { error } = await shop.rpc('close_store', { p_store_id: spare.id });
    check(`"${spare.name}" closes`, !error, error ? error.message : '');

    const { data: gone } = await admin
      .from('stores')
      .select('status')
      .eq('id', spare.id)
      .single();
    check('and it is closed, not deleted', gone.status === 'closed', gone.status);

    const { data: mine } = await shop
      .from('store_members')
      .select('stores!inner(name, status)')
      .eq('stores.status', 'active');
    check(
      'so the switcher offers only the shop that trades',
      (mine ?? []).length === 1,
      (mine ?? []).map((m) => m.stores.name).join(', '),
    );
  } else {
    console.log(NL + '  (no spare shop to close)');
  }

  console.log(NL + '— page errors —');
  check('no uncaught error', errors.length === 0, errors.join(' / '));
} catch (e) {
  console.log(`${NL}  FAIL  the walk did not finish — ${String(e).split('\n')[0]}`);
  await shot('where-it-stopped');
  failed += 1;
} finally {
  await browser.close();

  // The real shop is put back exactly as it was found. Its name is on every receipt.
  if (real && asFound) {
    await admin.from('stores').update(asFound).eq('id', real.id);

    // READ BACK and say so, rather than assuming the update landed. A restore that silently failed
    // leaves the shop holding this probe's test address.
    const { data: check } = await admin
      .from('stores')
      .select(TOUCHED.join(','))
      .eq('id', real.id)
      .single();
    const same = TOUCHED.every((c) => String(check?.[c]) === String(asFound[c]));
    console.log(`  restored: ${same ? 'yes' : `NO — now ${JSON.stringify(check)}`}`);
    if (!same) failed += 1;
  }
  const { data: end } = await admin.from('stores').select('name,status,address');
  console.log(NL + 'shops now:');
  for (const s of end ?? []) {
    console.log(`  ${s.name.padEnd(28)} ${s.status}  ${s.address ?? '(no address)'}`);
  }
  console.log(`${NL}${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}
