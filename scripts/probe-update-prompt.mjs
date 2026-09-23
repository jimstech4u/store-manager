/**
 * A new version arrives while the app is open: it asks, and only then takes over.
 *
 * «how about we detect and show a dialog viewer to reload (relaunch)»
 *
 * An installed app updates itself on its next launch, which for a till left open on a counter may
 * be days. So a waiting version says so — and waits for an answer, because reloading somebody
 * mid-sale to deliver an improvement is the app putting itself first.
 *
 * This ships a genuinely different worker to a running app (the file on disk is edited, exactly as
 * a deploy would), then checks the app notices, asks, and comes back running the new one.
 *
 *     node scripts/probe-update-prompt.mjs [http://localhost:3101]
 */

import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const BASE = process.argv[2] ?? 'http://localhost:3101';
const SW = 'public/sw.js';
const TEMPLATE = 'sw/sw.template.js';
const NEW_VERSION = 'v-probe';

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/*
 * ── FIRST: CAN A DEPLOY BE NOTICED AT ALL? ────────────────────────────────────────
 *
 * Everything below tests what happens once the browser sees a different worker. None of it means
 * anything if real deploys ship the same worker — which is exactly what happened: VERSION was a
 * hand-written 'v5', four deploys went out byte-identical, and no shop was ever told. The dialog
 * worked perfectly and was never shown.
 */
const served = await fetch(`${BASE}/sw.js`).then((r) => r.text());
const servedVersion = /const VERSION = '([^']*)'/.exec(served)?.[1] ?? '';
check(
  'the worker carries the build it came from, not a constant',
  /^[0-9a-f]{7,40}$|^t[0-9]+$/.test(servedVersion),
  servedVersion || '(none)',
);

// And two different commits really do produce two different workers.
const template = readFileSync(TEMPLATE, 'utf8');
const stamp = (sha) => template.replaceAll('__BUILD_VERSION__', sha);
check(
  'two builds are two different workers',
  stamp('aaaaaaaaaaaa') !== stamp('bbbbbbbbbbbb'),
);
check(
  'and nothing is left unstamped',
  !stamp('aaaaaaaaaaaa').includes('__BUILD_VERSION__'),
);

const original = readFileSync(SW, 'utf8');
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  const controlled = await p.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return Boolean(navigator.serviceWorker.controller);
  });
  check('the app is running under its worker', controlled);

  const before = await p.evaluate(() => caches.keys());
  check('nothing is waiting on a first visit', !(await p.locator('body').innerText()).includes('A new version is ready'));

  // ── A deploy: a different worker on the server, while this app is open ────────────
  writeFileSync(SW, original.replace(/const VERSION = '[^']+'/, `const VERSION = '${NEW_VERSION}'`));
  await p.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update();
  });
  await p.waitForTimeout(4000);

  const asked = p.getByText('A new version is ready').first();
  check('the app says a new version is ready', (await asked.count()) > 0);

  const notNow = p.getByRole('button', { name: /Not now/i }).first();
  check('and it can be put off', (await notNow.count()) > 0);

  // ── "Not now" means not now ──────────────────────────────────────────────────────
  await notNow.click();
  await p.waitForTimeout(2500);
  const afterNotNow = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('saying not now puts it away', !afterNotNow.includes('A new version is ready'));
  check('and leaves the app where it was', /sign in|email|password/i.test(afterNotNow), afterNotNow.slice(0, 60));
  const stillWaiting = await p.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return Boolean(reg?.waiting);
  });
  check('the new version is still there, waiting', stillWaiting);

  // It asks again after the wait the shop chose; the wait itself is a timer, so what is checked
  // here is that asking again brings the dialog back rather than the page having moved on.
  await p.evaluate(() => {
    window.dispatchEvent(new Event('visibilitychange'));
  });

  // ── Yes ──────────────────────────────────────────────────────────────────────────
  // Reload to be asked again without waiting out the reminder — the same page, the same waiting
  // worker. (A reload while one waits does not install it: it needs every page to let go.)
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(5000);
  const askedAgain = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('it is offered again on the next look', askedAgain.includes('A new version is ready'), askedAgain.slice(0, 60));

  const reloads = [];
  p.on('load', () => reloads.push(1));
  await p.getByRole('button', { name: /Update now/i }).first().click();
  await p.waitForTimeout(6000);

  check('saying yes relaunches the app', reloads.length > 0, `${reloads.length} reload(s)`);
  const after = await p.evaluate(() => caches.keys());
  check(
    'and it comes back on the new version',
    after.some((k) => k.includes(NEW_VERSION)),
    `before: ${before.join(', ')} | after: ${after.join(', ')}`,
  );
  check(
    'with the old version cleared away',
    !after.some((k) => k.includes('v5')),
    after.join(', '),
  );

  // ── And the app is usable, not a blank page ──────────────────────────────────────
  const text = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('the page it lands on is the app', /sign in|email|password/i.test(text), text.slice(0, 60));
  check('and it is not still asking', !text.includes('A new version is ready'));
} catch (e) {
  console.log('STOPPED:', String(e).split('\n')[0]);
  failed += 1;
} finally {
  writeFileSync(SW, original);
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
