/**
 * The app sheet after moving onto @academix-admin/bottom-viewer.
 *
 * Proves the package now does everything the retired app-level Sheet did: announces itself as a
 * named modal, takes taps over the tab bar, closes on Escape and on back, keeps Tab inside itself,
 * and stops the page behind from scrolling.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE = process.argv[2];
const raw = fs.readFileSync('.env.local', 'utf8');
const env = k => (raw.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]?.trim().replace(/^"|"$/g, '');
let failed = 0;
const ok = (n, v, d = '') => { if (!v) failed++; console.log(`  ${v ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.goto(BASE + '/login', { waitUntil: 'networkidle' });
await p.locator('input[type="email"]').first().fill(env('SAMPLE_EMAIL'));
await p.locator('input[type="password"]').first().evaluate((el, v) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, env('SAMPLE_PASSWORD'));
await p.locator('button[type="submit"]').first().click();
await p.waitForTimeout(9000);

// The bank-account sheet in settings: a plain BottomSheet with fields and a footer, reachable in
// two taps and not entangled with a sale in progress.
//
// The tab bar auto-hides on scroll and every stack stays mounted, so a bare `.first()` resolves a
// button on a hidden tab. Scroll to the top to bring the bar back, then click by exact name.
const revealTabs = async () => {
  await p.evaluate(() => {
    document.querySelectorAll('[class*="PageScaffold_body"]').forEach((c) => { if (c.scrollTop > 0) c.scrollTop = 0; });
  });
  await p.waitForFunction(() => {
    const nav = document.querySelector('nav.navigation-bar');
    if (!nav) return true;
    const m = getComputedStyle(nav).transform;
    return m === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(m);
  }, undefined, { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(300);
};

await revealTabs();
await p.getByRole('button', { name: 'More', exact: true }).first().click();
await p.waitForTimeout(1800);
await p.locator('button:visible').filter({ hasText: /bank|money is collected|account/i }).first().click();
await p.waitForTimeout(2200);
await p.screenshot({ path: 'shots/sheet-bank-page.png' });

const openSheet = async () => {
  // The trigger is the header's "+" — an icon button whose only name is its aria-label.
  await p.getByRole('button', { name: 'Add an account' }).first().click();
  await p.waitForTimeout(1400);
};
await openSheet();
await p.screenshot({ path: 'shots/sheet-open.png' });

const dialog = p.locator('[role="dialog"][aria-modal="true"]:visible').first();
ok('the sheet is a named modal dialog', await dialog.count() > 0,
   await dialog.count() ? `name: ${JSON.stringify(await dialog.getAttribute('aria-label'))}` : 'no [role=dialog]');
ok('it has an accessible name', !!(await dialog.getAttribute('aria-label').catch(() => null)));

ok('a tap where the tabs are hits the sheet, not the tab bar', await p.evaluate(() => {
  const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 30);
  let n = el;
  while (n) {
    if (n.getAttribute?.('role') === 'dialog') return true;
    if (/react-modal-sheet|bottom-viewer/.test((n.className || '').toString())) return true;
    n = n.parentElement;
  }
  return false;
}));

ok('the page behind cannot scroll', await p.evaluate(() => {
  const before = window.scrollY;
  window.scrollBy(0, 400);
  return window.scrollY === before;
}));

// Tab must not walk out of the sheet.
const inside = await p.evaluate(async () => {
  const dlg = document.querySelector('[role="dialog"][aria-modal="true"]');
  if (!dlg) return null;
  const f = dlg.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
  if (!f.length) return null;
  f[f.length - 1].focus();
  return true;
});
if (inside) {
  await p.keyboard.press('Tab');
  ok('Tab from the last control stays inside the sheet',
     await p.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-modal="true"]')));
} else ok('Tab from the last control stays inside the sheet', false, 'no focusable content found');

await p.keyboard.press('Escape');
await p.waitForTimeout(900);
ok('Escape closes it', await p.locator('[role="dialog"][aria-modal="true"]:visible').count() === 0);

// Re-open and prove the back gesture closes the sheet rather than leaving the screen behind it.
await openSheet();
const urlBefore = p.url();
await p.goBack();
await p.waitForTimeout(2500);
ok('back closes the sheet', await p.locator('[role="dialog"][aria-modal="true"]:visible').count() === 0);
ok('back left us on the same screen', p.url().replace(/#.*$/, '') === urlBefore.replace(/#.*$/, ''),
   p.url().replace(/^https?:\/\/[^/]+/, ''));
await p.screenshot({ path: 'shots/sheet-after-back.png' });

ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
