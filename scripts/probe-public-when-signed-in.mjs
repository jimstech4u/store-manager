/**
 * THE PUBLIC SIDE, SEEN BY SOMEBODY WHO IS ALREADY SIGNED IN.
 *
 * The marketplace is the same site as the app: a shop's own products are listed there. So a shop
 * owner who wanders onto it — from a link, from a search, from the settings screen — must not be
 * asked to sign in to something they are signed into, and must have one tap back to their till.
 *
 * Also checked: that there is a route out of the app to the public side at all. There was none, so
 * the only way to see how your shop looks to a shopper was to type the address.
 *
 *     node scripts/probe-public-when-signed-in.mjs [http://localhost:3101]
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

try {
  // ── Signed out, the offer to join is the point ───────────────────────────────────
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(3000);
  const signedOut = (await p.locator('header, [class*="top"]').first().innerText()).replace(/\s+/g, ' ');
  check('signed out, the marketplace offers a way in', /open a shop|sign in/i.test(signedOut), signedOut.slice(0, 50));

  // ── Sign in ──────────────────────────────────────────────────────────────────────
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(15000);
  check('signed in, at the till', new URL(p.url()).pathname.startsWith('/main'), new URL(p.url()).pathname);

  // ── The way OUT to the public side ───────────────────────────────────────────────
  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(5000);
  const marketLink = p.getByRole('link', { name: /see the marketplace/i }).first();
  check('settings offers a way to the marketplace', (await marketLink.count()) > 0);

  // ── The public side, while signed in ─────────────────────────────────────────────
  for (const [what, path] of [['the marketplace', '/'], ['a shop', '/s/7R8U2A']]) {
    await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(3500);
    /*
     * THE WHOLE PAGE, not the top bar. The way back to your own side floats at the bottom right
     * now, and the branding and sign-in buttons belong to the landing page alone — so a check that
     * reads only the header would see an empty row and call it a failure.
     */
    const top = (await p.locator('body').innerText()).replace(/\s+/g, ' ');

    check(`${what}: no invitation to sign in`, !/sign in|sign up/i.test(top), top.slice(0, 60));
    check(`${what}: one tap back to the shop`, /my shop|set up my shop/i.test(top), top.slice(0, 60));
  }

  // And the same on a product page, which is often the FIRST page somebody ever sees.
  const href = await p.locator('a[href*="/product/"]').first().getAttribute('href');
  if (href) {
    await p.goto(`${BASE}${href}`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(3500);
    /*
     * THE WHOLE PAGE, not the top bar. The way back to your own side floats at the bottom right
     * now, and the branding and sign-in buttons belong to the landing page alone — so a check that
     * reads only the header would see an empty row and call it a failure.
     */
    const top = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
    check('a product page: no invitation to sign in', !/sign in|sign up/i.test(top), top.slice(0, 60));
    check('a product page: one tap back to the shop', /my shop|set up my shop/i.test(top), top.slice(0, 60));
  } else {
    check('there was a product link to follow', false, 'none on the shop page');
  }
} catch (e) {
  console.log('STOPPED:', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
