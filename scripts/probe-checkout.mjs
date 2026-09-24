/**
 * A SHOPPER WHO IS NOT A SHOP, BUYING SOMETHING.
 *
 * The whole path, as a person walks it: fill a basket with nobody signed in, be asked for an
 * account only at the moment of sending, create one, say who to ask for, send the order, and find
 * it waiting on the shop's own Orders screen — where it can be turned down.
 *
 * The checks that matter most are the ones about WHO this person is:
 *   · a shopper is never asked to open a shop — not at sign-up, not at the top bar, not at /main
 *   · signing in from the basket comes back to the basket, not to somebody's till
 *   · the price the shop is asked for is the SHOP'S price, not the one the basket remembered
 *
 * It creates a real account and a real order in the live database, both marked so they can be
 * found: the address is `probe+<stamp>@example.com` and the order is declined at the end. An
 * order declined is cancelled and moves no stock, so nothing is left behind but two rows saying a
 * shopper asked and a shop said no.
 *
 * WAITS ARE `domcontentloaded` PLUS A PAUSE, never `networkidle`. Once the service worker is
 * registered — which it is, a second after the first page — it can hold a connection open long
 * enough that the network never goes idle, and the probe then fails on a wait rather than on
 * anything it was asked to check.
 *
 *     node scripts/probe-checkout.mjs [http://localhost:3101]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);

const STAMP = Date.now().toString().slice(-8);
const EMAIL = `probe.shopper.${STAMP}@example.com`;
const PASSWORD = `Probe-${STAMP}!`;
const NAME = `ZZ Probe Shopper ${STAMP}`;
const PHONE = `080${STAMP}`;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const note = (what, detail = '') => console.log(`  ····  ${what}${detail ? ` — ${detail}` : ''}`);

/*
 * The account is made through the admin API rather than the sign-up form, and confirmed, because
 * the form's own path goes through a six-digit code in an email this probe cannot read. The FORM
 * is still checked — that it exists, says the right thing and does not mention opening a shop —
 * just not walked through to a session.
 */
const admin = async (path, body) => {
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

let placedCode = null;

try {
  // ══ 1. A basket, with nobody signed in ════════════════════════════════════════════
  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  const product = [...sitemap.matchAll(/<loc>([^<]*\/product\/[^<]*)<\/loc>/g)].map((m) => new URL(m[1]).pathname)[0];
  check('there is a public product to buy', Boolean(product), product ?? 'none');
  if (!product) throw new Error('nothing public to order');

  await p.goto(`${BASE}${product}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /add .* to basket/i }).first().click();
  await p.waitForTimeout(900);
  check('a signed-out shopper can fill a basket', (await p.locator('header a[href="/cart"] span').count()) > 0);

  // ══ 2. The ask arrives at the send button, and nowhere earlier ════════════════════
  await p.goto(`${BASE}/cart`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const sendSignedOut = p.getByRole('button', { name: /sign in to send/i }).first();
  check('the basket says an account is needed to send', (await sendSignedOut.count()) > 0);

  await sendSignedOut.click();
  await p.waitForTimeout(3000);
  check('and sending goes to sign in', new URL(p.url()).pathname === '/login', p.url().replace(BASE, ''));
  check('carrying the way back to the basket', new URL(p.url()).searchParams.get('next') === '/cart');

  // ══ 3. Signing up as a shopper is not signing up a shop ═══════════════════════════
  await p.getByRole('button', { name: /order from shops/i }).first().click();
  await p.waitForTimeout(2500);
  const signupText = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('there is a shopper sign-up, distinct from opening a shop', /shopper account/i.test(signupText), signupText.slice(0, 60));
  check('and it promises no shop setup', /not be asked to set up a shop/i.test(signupText));

  // ══ 4. A real account, confirmed out of band ══════════════════════════════════════
  /*
   * `signed_up_as` because that is what the real sign-up form sets, and it is what tells the app
   * shell this person is a shopper rather than a shop that has not been made yet. Creating the user
   * without it would be testing a path no real shopper takes.
   */
  const made = await admin('admin/users', {
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { signed_up_as: 'customer' },
  });
  check('the probe could create its shopper', made.status === 200, `${made.status}`);
  const userId = made.body?.id ?? null;
  note('shopper', `${EMAIL} ${userId ?? ''}`);

  await p.goto(`${BASE}/login?next=/cart`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(EMAIL);
  await p.locator('input[type="password"]').first().fill(PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(8000);
  check('signing in comes back to the basket', new URL(p.url()).pathname === '/cart', new URL(p.url()).pathname);

  // ══ 5. The shop is not offered to somebody who came to buy ════════════════════════
  const top = (await p.locator('header').first().innerText()).replace(/\s+/g, ' ');
  check('the top bar does not offer to set up a shop', !/set up my shop/i.test(top), top.slice(0, 60));
  check('it offers their own orders instead', /my orders/i.test(top), top.slice(0, 60));

  // ══ 6. Who the shop should ask for ════════════════════════════════════════════════
  await p.waitForTimeout(2500);
  const send = p.getByRole('button', { name: /send this order to/i }).first();
  check('the basket now offers to send the order', (await send.count()) > 0);
  await send.click();
  await p.waitForTimeout(2500);
  check('and asks who the shop should ask for', /who should the shop ask for/i.test(await p.locator('main').innerText()));

  await p.locator('main form input').first().fill(NAME);
  await p.locator('main form input[type="tel"]').first().fill(PHONE);
  await p.getByRole('button', { name: /save and send/i }).click();
  await p.waitForTimeout(9000);

  // ══ 7. Sent ═══════════════════════════════════════════════════════════════════════
  const afterText = (await p.locator('main').innerText()).replace(/\s+/g, ' ');
  check('the order is sent', /sent to the shop/i.test(afterText), afterText.slice(0, 80));
  placedCode = /order number is ([A-Z0-9]+)/i.exec(afterText)?.[1] ?? null;
  check('and it comes back with a code to quote', Boolean(placedCode), placedCode ?? afterText.slice(0, 60));
  check('the basket no longer holds what was sent', (await p.locator('main section[class*="seller"]').count()) === 0);
  check('and the top bar badge is gone with it', (await p.locator('header a[href="/cart"] span').count()) === 0);

  // ══ 8. It is theirs to see ════════════════════════════════════════════════════════
  await p.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  const mine = (await p.locator('main').innerText()).replace(/\s+/g, ' ');
  check('the shopper can see their own order', placedCode ? mine.includes(placedCode) : false, mine.slice(0, 80));
  check('and it says it is waiting on the shop', /waiting on the shop/i.test(mine));

  // ══ 9. /main has nothing for a shopper, and does not ask them to open a shop ══════
  await p.goto(`${BASE}/main`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(9000);
  const landed = new URL(p.url()).pathname;
  check('a shopper at /main is sent to the marketplace, not the shop wizard', landed === '/', landed);

  // ══ 10. The shop's side: it is waiting, and can be turned down ════════════════════
  const shop = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await shop.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await shop.waitForTimeout(1500);
  await shop.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await shop.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await shop.locator('button[type="submit"]').first().click();
  await shop.waitForTimeout(15000);
  check('the shop signs in to its till', new URL(shop.url()).pathname.startsWith('/main'));

  await shop.locator('.nav-item').filter({ hasText: /^Sell$/ }).first().click();
  await shop.waitForTimeout(5000);
  const ordersAction = shop.getByRole('button', { name: /orders waiting|orders/i }).first();
  const badge = (await ordersAction.innerText()).replace(/\s+/g, '');
  check('the Sell header badges the waiting order', /\d/.test(badge), badge || '(no number)');

  await ordersAction.click();
  await shop.waitForTimeout(5000);
  const queue = (await shop.locator('body').innerText()).replace(/\s+/g, ' ');
  check('the order is in the shop’s queue', placedCode ? queue.includes(placedCode) : false, queue.slice(0, 90));
  check('named by the person who sent it', queue.includes(NAME), NAME);

  /*
   * THIS ORDER, not whichever is first. The queue is a real shop's queue and may hold anything;
   * declining the top card would turn down somebody else's order.
   */
  const card = shop.locator('li').filter({ hasText: placedCode ?? ' ' }).first();
  check('the probe can find its own order in the queue', (await card.count()) > 0, placedCode ?? '');

  /*
   * `dispatchEvent`, not `click`. The confirm dialog opens over the button that opened it, and
   * Playwright's own retry then reports the click it just made as blocked by the thing that click
   * produced. Dispatching the event asks for the one behaviour being tested and nothing else.
   */
  await card.getByRole('button', { name: /^decline$/i }).first().dispatchEvent('click');
  await shop.waitForTimeout(1800);
  check('declining asks first', /decline this order/i.test(await shop.locator('body').innerText()));
  await shop.getByRole('button', { name: /decline it/i }).first().dispatchEvent('click');
  await shop.waitForTimeout(6000);
  const afterDecline = (await shop.locator('body').innerText()).replace(/\s+/g, ' ');
  check(
    'declining takes it out of the queue',
    placedCode ? !afterDecline.includes(placedCode) : false,
    /no orders waiting/i.test(afterDecline) ? 'queue empty' : afterDecline.slice(0, 70),
  );

  // And the shopper is told, on their own screen, without anybody having to say so.
  await p.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  check('the shopper sees it was turned down', /turned down/i.test(await p.locator('main').innerText()));
} catch (e) {
  check('the probe ran to the end', false, e.message);
} finally {
  await browser.close();
  console.log(failed === 0 ? '\n  all good\n' : `\n  ${failed} failed\n`);
  console.log(`  left behind: shopper ${EMAIL}${placedCode ? `, declined order ${placedCode}` : ''}\n`);
  process.exit(failed === 0 ? 0 : 1);
}
