/**
 * Is this an app on the phone, or a page in a browser?
 *
 * «how navigationstack and state-stack with pwa can make store manager exactly like an app on
 *  users ios or android so it is easier to use it rather than having to go to a browser»
 *
 * Checks the four things that decide it, against a REAL build (the service worker is not registered
 * in development):
 *
 *   1. the manifest says standalone, with the icons each platform asks for
 *   2. iOS gets what it reads instead of the manifest — apple-touch-icon, the name, capable
 *   3. the service worker takes control, so the app opens from the phone rather than the network
 *   4. with the network cut, a screen already visited still opens — the dinosaur is what this is for
 *
 *     node scripts/probe-installable.mjs [http://localhost:3101]
 */

import { chromium } from '@playwright/test';

const BASE = process.argv[2] ?? 'http://localhost:3101';

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
try {
  // ══ 1. The manifest ═══════════════════════════════════════════════════════════════
  const res = await fetch(`${BASE}/manifest.webmanifest`);
  check('the manifest is served', res.ok, `${res.status} ${res.headers.get('content-type')}`);
  const m = await res.json();
  check('it asks for a window of its own', m.display === 'standalone', m.display);
  check('it has a launch colour, so no white flash', Boolean(m.background_color), m.background_color);
  check('it starts at the front door', m.start_url === '/', m.start_url);
  const sizes = (m.icons ?? []).map((i) => `${i.sizes}/${i.purpose}`);
  check('it offers a 192 and a 512', sizes.some((s) => s.startsWith('192')) && sizes.some((s) => s.startsWith('512')), sizes.join(' '));
  check('and one a launcher may crop', (m.icons ?? []).some((i) => i.purpose === 'maskable'));
  for (const icon of m.icons ?? []) {
    const r = await fetch(`${BASE}${icon.src}`);
    check(`${icon.src} is there`, r.ok && (r.headers.get('content-type') ?? '').includes('png'), `${r.status}`);
  }

  // ══ 2. What iOS reads instead ═════════════════════════════════════════════════════
  const ios = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    // An iPhone, which is the only browser that can install on iOS.
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  });
  await ios.goto(BASE, { waitUntil: 'domcontentloaded' });
  const head = await ios.evaluate(() => ({
    capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content'),
    title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content'),
    touchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
    theme: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
  }));
  check('iOS is told it can run full screen', head.capable === 'yes', String(head.capable));
  check('iOS has a name for the icon', head.title === 'Store Manager', String(head.title));
  check('iOS has an icon to use', Boolean(head.touchIcon), String(head.touchIcon));
  check('the manifest is linked', Boolean(head.manifest), String(head.manifest));
  check('the system bars are coloured', Boolean(head.theme), String(head.theme));

  // The install offer on the landing page: on iPhone it is the two steps, since Apple has no prompt.
  await ios.waitForTimeout(2500);
  const iosText = (await ios.locator('body').innerText()).replace(/\s+/g, ' ');
  check('an iPhone is shown how to install', /Add to Home Screen/i.test(iosText) && /Share/i.test(iosText));

  // ══ 3 & 4. The service worker, and a screen with the network cut ══════════════════
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: 'networkidle' });
  const controlled = await p.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (!reg) return false;
    for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return Boolean(navigator.serviceWorker.controller);
  });
  check('the service worker is in control', controlled);

  // Visit the sign-in screen so it is known, then cut the line and go back to it.
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await ctx.setOffline(true);
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await p.waitForTimeout(2000);
  const offlineText = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check(
    'with no signal, a screen already used still opens',
    /sign in|email|password/i.test(offlineText),
    offlineText.slice(0, 70) || '(blank)',
  );

  // And one never visited says so in the app's own words, not the browser's.
  await p.goto(`${BASE}/never-been-here`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await p.waitForTimeout(1500);
  const unseen = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('and one never used says so in our words', /No signal for this screen/i.test(unseen), unseen.slice(0, 70));
  await ctx.setOffline(false);

  // ══ 5. The app itself, signed in, with the line cut ═══════════════════════════════
  // The promise this phase makes: the shop opens its own till and sees what it last knew.
  const { readFileSync } = await import('node:fs');
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      }),
  );
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(15000);
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(6000);
  const online = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('signed in, the stock list has items', /records say|On the shelf|₦/i.test(online), online.slice(60, 130));

  await ctx.setOffline(true);
  await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await p.waitForTimeout(12000);
  const offlineApp = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('with the line cut, the app still opens', !/No signal for this screen/i.test(offlineApp) && offlineApp.length > 80, offlineApp.slice(0, 80));
  check('and it still shows the shop’s own figures', /records say|₦|Stock/i.test(offlineApp), offlineApp.slice(0, 110));
  await ctx.setOffline(false);
} catch (e) {
  console.log('STOPPED:', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
