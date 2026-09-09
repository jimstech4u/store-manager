/**
 * Signed in, and landed in a shop nobody asked for.
 *
 * This account owns two shops: ASHABI GLOBAL RESOURCES, trading since August, and "Yh" — created
 * today, never onboarded, almost certainly a name typed into the setup form by accident. Signing in
 * put the session into "Yh" and the layout then did what it is supposed to do with a shop that has
 * no `onboarded_at`: sent it to `/setup/opening`.
 *
 * TWO THINGS MADE IT POSSIBLE and this drives both.
 *
 *   The store was chosen as `list[0]` of an UNORDERED join, so which shop you land in is whichever
 *   row the database felt like returning first. It happens to be ASHABI today.
 *
 *   And `/setup/opening` never said which shop it was setting up, or offered any other, so the only
 *   way out was to press "Skip for now" — which marks the WRONG SHOP onboarded to escape it.
 *
 *     node scripts/probe-which-shop.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const NL = String.fromCharCode(10);
const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS = 'shots/which-shop';
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

// The two shops as the database actually has them.
/*
 * THE HALF-BUILT SHOP THIS PROBE MAKES FOR ITSELF.
 *
 * It used to lean on one that happened to exist. The fix under test let that shop be closed,
 * so the precondition disappeared and the probe skipped for ever — still printing a pass-shaped
 * summary while testing nothing.
 *
 * `create_store` is exactly what the setup form calls, and it leaves the new shop with a null
 * `onboarded_at` — which IS the trap: a shop in that state routes straight to /setup/opening.
 * Closing it afterwards is possible because `close_store` now exists; before this session a
 * probe that created a shop had no way to be rid of it.
 */
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});

const stamp = Date.now().toString().slice(-6);
const TRAP_NAME = `ZZ Half Made ${stamp}`;

const { error: madeErr } = await shop.rpc('create_store', {
  p_name: TRAP_NAME,
  p_slug: `zz-half-made-${stamp}`,
});
if (madeErr) {
  console.log(`  could not make the half-built shop: ${madeErr.message}`);
  process.exit(1);
}

const { data: stores } = await admin
  .from('stores')
  .select('id,name,onboarded_at')
  .eq('status', 'active');
const ready = (stores ?? []).filter((s) => s.onboarded_at);
const unfinished = (stores ?? []).filter((s) => !s.onboarded_at);
const trap = unfinished.find((s) => s.name === TRAP_NAME);

console.log(`  made "${TRAP_NAME}" — never onboarded, which is the trap`);
console.log(`  shops now: ${ready.length} ready, ${unfinished.length} unfinished`);

if (!trap || ready.length === 0) {
  console.log('  the shop was not made, or there is no finished shop to prefer.');
  process.exit(1);
}

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

let step = 0;
const shot = async (name) => {
  step += 1;
  await p.screenshot({ path: `${SHOTS}/${String(step).padStart(2, '0')}-${name}.png` });
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);

  /*
   * THE STATE A REAL SESSION IS IN, set before signing in.
   *
   * Making the half-built shop the remembered one is exactly what happens after somebody creates
   * it: `setStoreId` writes `sm.lastStore` on the way through the setup form. Reproducing it here
   * rather than hoping the unordered join comes back the unlucky way round, because a probe that
   * only fails sometimes proves nothing either way.
   */
  await p.evaluate((id) => localStorage.setItem('sm.lastStore', id), trap.id);

  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  /*
   * Waited until the app has DECIDED, not for a number of seconds.
   *
   * "One moment" is the loading screen, and the routing effect runs after the membership read
   * settles — so a fixed wait catches the app mid-thought and reports whichever half-rendered
   * screen it happened to see.
   */
  await Promise.race([
    p.locator('.nav-item').first().waitFor({ state: 'visible', timeout: 180000 }),
    p.getByText(/What you have right now/i).first().waitFor({ state: 'visible', timeout: 180000 }),
  ]);
  await p.waitForTimeout(4000);
  await shot('where-it-landed');

  const url = p.url();
  const body = await p.locator('body').innerText();
  console.log(`\n  landed on: ${url.replace(BASE, '')}`);

  const onSetup = url.includes('/setup');
  check(
    'a half-made shop no longer takes the session on its own',
    !onSetup,
    onSetup ? 'routed to setup' : 'went to the shop',
  );

  /*
   * AND IF IT DOES, THE SCREEN HAS TO SAY WHOSE SETUP THIS IS.
   *
   * Checked even when the route was avoided, because a shop with genuinely one unfinished store
   * still lands here and still deserves to be told which one it is looking at.
   */
  if (onSetup) {
    check(
      'the setup screen names the shop it is setting up',
      body.includes(trap.name),
      body.replace(/\s+/g, ' ').slice(0, 90),
    );
    check(
      'and offers the other shop rather than only "Skip for now"',
      /another shop|different shop|switch/i.test(body),
      body.replace(/\s+/g, ' ').slice(0, 90),
    );
  } else {
    check(
      'it opened the shop that is actually trading',
      ready.some((s) => body.includes(s.name)) || /Sell|Stock/i.test(body),
      body.replace(/\s+/g, ' ').slice(0, 70),
    );

    /*
     * AND THE HALF-MADE SHOP IS NOT LOST — it is chosen, rather than landed in.
     *
     * Preferring the shop that trades would be its own bug if it made the unfinished one
     * unreachable: somebody interrupted halfway through creating a shop would have no way
     * back to it. Going there deliberately is the one context where the setup wizard is
     * what somebody actually asked for.
     */
    console.log(NL + '— and choosing the half-made shop on purpose —');

    /*
     * THROUGH THE SWITCHER, not through localStorage.
     *
     * Setting the remembered id and reloading is exactly what the fix now ignores, so it
     * left the app in the shop that trades and asserted against a screen describing that
     * one. Both checks passed: the name was present because the setup page OFFERS the other
     * shop, and the trading shop was present because it was the shop being set up. A probe
     * satisfied by the opposite of its own claim.
     */
    await p.goto(`${BASE}/setup/opening`, { waitUntil: 'networkidle' });
    await p
      .getByText(/right now/i)
      .first()
      .waitFor({ state: 'visible', timeout: 120000 });
    await p.waitForTimeout(2500);

    const goThere = p.getByRole('button', { name: new RegExp(`Go to ${trap.name}`, 'i') });
    check('the setup screen offers the account\'s other shop', (await goThere.count()) > 0);
    await goThere.first().click();
    await p.waitForTimeout(6000);
    await shot('setup-named');

    const setup = await p.locator('body').innerText();
    const heading = await p.locator('h1').first().innerText();

    /*
     * Asserted on the HEADING, not the page.
     *
     * The shop's name appears on this page twice over once there is a switcher, so 'is the
     * name anywhere in the body' cannot tell being IN a shop from being offered it.
     */
    check(
      'switching to it actually lands in it, and the heading says so',
      heading.includes(trap.name),
      heading.replace(/\s+/g, ' '),
    );
    check(
      'and the way back to the shop that trades is offered',
      /wrong shop/i.test(setup) && ready.some((r) => setup.includes(r.name)),
      setup.replace(/\s+/g, ' ').slice(0, 100),
    );
  }

} catch (e) {
  console.log(`\n  FAIL  the walk did not finish — ${String(e).split('\n')[0]}`);
  await shot('where-it-stopped');
  failed += 1;
} finally {
  await browser.close();

  /*
   * THE TRAP IS CLOSED, and what is left is READ BACK rather than assumed.
   *
   * A shop cannot be deleted — `create_store` writes a membership and the row is referenced —
   * so it is closed, which is what closing is for. A probe that leaves half-built shops behind
   * recreates the exact fault it exists to catch.
   */
  if (trap) {
    const { error: shutErr } = await shop.rpc('close_store', { p_store_id: trap.id });
    const { data: after } = await admin
      .from('stores')
      .select('status')
      .eq('id', trap.id)
      .single();
    const gone = after?.status === 'closed';
    console.log(
      NL + `  "${TRAP_NAME}": ${gone ? 'closed' : `STILL OPEN — ${shutErr?.message ?? after?.status}`}`,
    );
    if (!gone) failed += 1;
  }
  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}
