/**
 * THE PRINT PREVIEW SHOWS WHAT THE ROLL WILL SAY.
 *
 * Asked for as «let's be able to really configure printer options in setting and see preview like
 * we have so we can choose», after a first physical print came out faint and the shop compared the
 * printer's own letters against a picture of them.
 *
 * The receipt goes to the printer as ESC/POS text now, in its built-in font, because a 203dpi head
 * prints ROM glyphs sharply and a resampled bitmap thinly. That font has sizes, and the preview is
 * how a shop picks one without spending a roll finding out.
 *
 * WHAT MAKES THIS PREVIEW WORTH ANYTHING: it is built from the SAME instruction the printer gets,
 * un-tagged, at the same characters-per-line. A preview assembled by a second layout would agree
 * with the paper until the day it did not, and nobody would know which was wrong.
 *
 * So this checks the arithmetic the preview depends on, and that the screen actually draws it:
 *
 *   · the sizes give the right characters-per-line for a 576-dot head
 *   · picking a size is kept, per device, on the shop
 *   · the preview redraws at the chosen size
 *   · and it says ₦ prints as N, which is a limitation a shop must be told about rather than find
 *
 *     node scripts/probe-print-preview.mjs [http://localhost:3101]
 */
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
await db.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await db.rpc('my_membership')).data[0].store_id;

/* Whatever this shop already had, put back at the end. */
const { data: had } = await db.rpc('my_printers', { p_store_id: storeId });
const { data: shopSettings } = await db
  .from('store_settings')
  .select('printer_width_mm')
  .eq('store_id', storeId)
  .single();
const paperMm = Number(shopSettings?.printer_width_mm) || 80;
console.log(`  ${(had ?? []).length} device(s) already set up; ${paperMm}mm roll`);

/*
 * AS AN IPHONE, because the size picker is only shown for the routes that actually send ESC/POS —
 * and headless Chromium has no printer, no Bluetooth device and is not iOS, so it settles on "this
 * device's dialog" where there is nothing to configure. The share-sheet stub is what makes the
 * "Printer app" option offer itself, exactly as it does on a real phone.
 */
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 390, height: 900 },
  isMobile: true,
  hasTouch: true,
  userAgent: IPHONE,
});
await ctx.addInitScript(`
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: (d) => !!(d && d.files && d.files.length),
  });
  Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {} });
`);
const p = await ctx.newPage();
let deviceId = null;
try {
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.locator('.nav-item').first().waitFor({ state: 'visible', timeout: 180000 });
  await p.waitForTimeout(4000);

  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(3000);
  const settingsLink = p.locator('[class*="rowLink"]:visible, button:visible').filter({ hasText: /Settings|Your shop/i }).first();
  if (await settingsLink.count()) {
    await settingsLink.click();
    await p.waitForTimeout(8000);
  }

  /*
   * Headless Chromium has no printer and reports no Bluetooth device, so the page settles on its
   * own dialog — and the size picker is only shown for the routes that actually send ESC/POS.
   * Choosing "Printer app" is what a shop on an iPhone does, and it is what makes the picker appear.
   */
  const appOption = p.locator('[class*="printerOption"]:visible').filter({ hasText: /Printer app/i }).first();
  if (await appOption.count()) {
    await appOption.click();
    await p.waitForTimeout(6000);
  }

  const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('the size picker is on the settings page', /How big it prints/i.test(await body()), (await body()).slice(0, 120));

  /*
   * THE ARITHMETIC, said on the buttons. On a 576-dot head the small font is 9 dots wide and the
   * large one 12, and the double-width variants take twice that — so 64, 32 and 48 characters a
   * line. Shown to the shop because "Wide" means nothing on its own and "32 characters a line" is
   * the thing that decides whether a product name fits.
   */
  const text = await body();
  check('it says how many characters fit at each size', /characters a line/i.test(text));

  /*
   * DERIVED FROM THE SHOP'S OWN ROLL, not from an assumption about it.
   *
   * This asserted 64 and 32 — the right answers for an 80mm roll — and failed, because the shop it
   * runs against is set to 48mm. The counts were correct for the paper configured; the probe was
   * wrong to know better. Which is worth keeping: a probe that hard-codes the sample shop's setup
   * fails the day somebody changes it, and tells you nothing about the code.
   */
  const dots = paperMm >= 76 ? 576 : paperMm >= 56 ? 384 : Math.max(8, Math.floor(Math.max(1, paperMm - 8)) * 8);
  const expectSmall = Math.floor(dots / 9);
  const expectWide = Math.floor(dots / 18);
  check(
    `small is ${expectSmall} on this shop's ${paperMm}mm roll`,
    new RegExp(`${expectSmall} characters a line`).test(text),
    text.match(/\d+ characters a line/g)?.join(', ') ?? '',
  );
  check(
    `and the wide sizes are ${expectWide}`,
    new RegExp(`${expectWide} characters a line`).test(text),
  );

  const preview = p.locator('[class*="PrintPreview_paper__"]:visible').first();
  check('the preview is drawn', (await preview.count()) > 0);
  const previewText = (await preview.innerText()).replace(/\s+/g, ' ');
  check('it shows the shop and a real total', /ASHABI|Your shop/i.test(previewText) && /78,800/.test(previewText), previewText.slice(0, 120));
  check(
    'and the naira sign is already spelled the way it will print',
    previewText.includes('N78,800') && !previewText.includes('₦78,800'),
    previewText.slice(0, 160),
  );
  await p.screenshot({ path: 'shots/probe-print-preview-wide-tall.png', fullPage: true });

  // ── Choosing a different size changes the paper ───────────────────────────
  const small = p.locator('[class*="printerOption"]:visible').filter({ hasText: /^Small/ }).first();
  check('a smaller size can be chosen', (await small.count()) > 0);
  const before = (await preview.innerText()).split('\n').length;
  await small.click();
  await p.waitForTimeout(6000);

  const { data: saved } = await db.rpc('my_printers', { p_store_id: storeId });
  const mine = (saved ?? []).find((r) => r.kind === 'ios_app');
  deviceId = mine?.device_id ?? null;
  check('the choice is kept on the shop, against this device', mine?.text_size === 'ss', JSON.stringify(mine?.text_size));

  const after = (await preview.innerText()).split('\n').length;
  /*
   * Fewer lines at the small size: the same receipt at 64 characters a line wraps less than at 32.
   * Checked as a CHANGE rather than an exact count — the exact number depends on this shop's name
   * and address, and a probe that hard-codes it is testing the sample shop.
   */
  check('and the preview redraws smaller', after < before, `${before} lines → ${after}`);
  await p.screenshot({ path: 'shots/probe-print-preview-small.png', fullPage: true });

  check(
    'the page says the naira sign will print as N',
    /prints as N/i.test(await body()),
  );
} catch (e) {
  check('the probe ran to the end', false, String(e).split('\n')[0]);
  await p.screenshot({ path: 'shots/probe-print-preview-stopped.png', fullPage: true }).catch(() => {});
} finally {
  await b.close();
  /*
   * Put this device's row back to whatever it was, or remove it if the probe created it. A probe
   * that leaves a live shop pointed at a printer it does not have is one that breaks tomorrow's
   * printing.
   */
  if (deviceId) {
    const was = (had ?? []).find((r) => r.device_id === deviceId);
    if (was) {
      await db.rpc('set_my_printer', {
        p_store_id: storeId,
        p_device_id: deviceId,
        p_kind: was.kind,
        p_device_label: was.device_label,
        p_printer_name: was.printer_name,
        p_width_mm: was.width_mm,
        p_usb_vendor_id: was.usb_vendor_id,
        p_usb_product_id: was.usb_product_id,
        p_bt_device_id: was.bt_device_id,
        p_text_size: was.text_size,
      });
    } else {
      await db.rpc('forget_my_printer', { p_store_id: storeId, p_device_id: deviceId });
    }
  }
  const { data: left } = await db.rpc('my_printers', { p_store_id: storeId });
  check(
    'the shop is left with the devices it started with',
    (left ?? []).length === (had ?? []).length,
    `${(had ?? []).length} → ${(left ?? []).length}`,
  );
  console.log(failed === 0 ? '\n  all good' : '\n  ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}
