/**
 * ON AN IPHONE, PRINT GOES TO THE PRINTER'S APP — NOT TO AIRPRINT.
 *
 * Reported as «we could not print from pwa or website on ios because the printer is connected on
 * bluetooth which we can print but store manager cannot». The shop's 80mm roll is paired over
 * Bluetooth and prints perfectly from the printer's own app; Store Manager's Print button gave
 * "No AirPrint printers found", because that is all AirPrint can ever say about a Bluetooth
 * printer. And no web page on iOS can open the printer itself: Safari has no Web Bluetooth.
 *
 * So on iOS the receipt is drawn at the roll's width and handed to the share sheet, where the
 * printer's own app is waiting. What this proves:
 *
 *   · on an iPhone, Print hands over a PNG and does NOT call window.print()
 *   · the screen says why, so nobody goes hunting through AirPrint again
 *   · everywhere else Print still prints directly — the branch is on the DEVICE, not merely on
 *     whether sharing happens to be available, which is the mistake that would quietly take
 *     desktop printing away
 *
 *     node scripts/probe-ios-print.mjs [http://localhost:3101]
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/*
 * BOTH ROUTES ARE STUBBED ON BOTH DEVICES, deliberately.
 *
 * Headless Chromium has no share sheet and no printer, so neither branch can be observed without
 * standing in for them. Giving the desktop pass a working `canShare` too is the point: if the code
 * ever branched on share support instead of on the device, the desktop pass would start sharing
 * and this probe would catch it.
 */
const STUB = `
  window.__printed = 0;
  window.__shared = [];
  window.print = () => { window.__printed += 1; };
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: (d) => !!(d && d.files && d.files.length),
  });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async (d) => {
      window.__shared.push((d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })));
    },
  });
`;

/** Sign in and walk to a past sale's receipt, the screen a shop actually prints from. */
async function openAReceipt(p) {
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(18000);
  if (!new URL(p.url()).pathname.startsWith('/main')) throw new Error('never reached the till: ' + p.url());

  /*
   * `:visible` and `getByRole` throughout, not `text=`.
   *
   * Every tab's stack stays mounted, so "Money" matches the Money page's own hidden <h1> as
   * readily as the nav button — which is what the first version of this probe spent thirty
   * seconds trying to click.
   */
  await p.getByRole('button', { name: 'Money', exact: true }).first().click();
  await p.waitForTimeout(3000);

  /*
   * The sales list is an ICON in the Money header, so it is reached by its aria-label. There is no
   * "Sales" text anywhere on that page to click — the first version of this probe looked for some
   * and spent thirty seconds not finding it.
   */
  await p.getByRole('button', { name: 'All sales and receipts' }).first().click();
  await p.waitForTimeout(6000);

  // The first row on the sales list — a receipt somebody recorded, which is what a shop reprints.
  await p.locator('[class*="rowLink"]:visible, li:visible button:visible')
    .filter({ hasText: /\u20a6/ })
    .first()
    .click();
  await p.waitForTimeout(7000);

  const print = p.locator('button:visible').filter({ hasText: /^Print$/ }).first();
  await print.waitFor({ state: 'visible', timeout: 15000 });
  return print;
}

const b = await chromium.launch();
try {
  // ── An iPhone ──────────────────────────────────────────────────────────────
  {
    const ctx = await b.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent: IPHONE,
    });
    await ctx.addInitScript(STUB);
    const p = await ctx.newPage();
    console.log('\n— an iPhone, printer paired over Bluetooth —');
    const print = await openAReceipt(p);

    const body = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
    check(
      'the screen says a Bluetooth printer is not in the Print list',
      /does not show up under Print/i.test(body),
      body.slice(0, 120),
    );

    await print.click();
    // Drawing the receipt to a canvas and encoding a PNG takes a moment.
    await p.waitForTimeout(6000);
    const printed = await p.evaluate(() => window.__printed);
    const shared = await p.evaluate(() => window.__shared);
    check('Print did not go to AirPrint', printed === 0, `window.print() called ${printed}×`);
    check('Print handed the receipt to the share sheet', shared.length === 1, JSON.stringify(shared));
    check(
      'what it handed over is a picture the printer app can take',
      shared[0]?.[0]?.type === 'image/png' && shared[0][0].size > 1000,
      JSON.stringify(shared[0]?.[0] ?? null),
    );
    await ctx.close();
  }

  // ── Anything else ──────────────────────────────────────────────────────────
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(STUB);
    const p = await ctx.newPage();
    console.log('\n— a desktop, where the browser can print —');
    const print = await openAReceipt(p);

    const body = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
    check(
      'no iPhone advice on a machine it does not apply to',
      !/does not show up under Print/i.test(body),
    );

    await print.click();
    await p.waitForTimeout(3000);
    const printed = await p.evaluate(() => window.__printed);
    const shared = await p.evaluate(() => window.__shared);
    check('Print still prints', printed === 1, `window.print() called ${printed}×`);
    check('and does not divert to the share sheet', shared.length === 0, JSON.stringify(shared));
    await ctx.close();
  }
} catch (e) {
  check('the probe ran to the end', false, e.message);
} finally {
  await b.close();
  console.log(failed === 0 ? '\n  all good' : '\n  ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
