/**
 * SETTINGS IS A LIST OF THINGS TO GO AND DO, NOT A FORM.
 *
 * Asked for as «the rule is that setting page is just the clickable card that when clicked opens
 * the page that does the settings changes, so remove any setting with input or select or tab
 * switcher to their respective pages», and «remove the save button in setting-page because that
 * page will not handle save setting, only inside individual pages».
 *
 * The screen had grown into a form: a select at the top, a paper width, a logo upload, a bank
 * chooser, two previews, and one Save governing all of it. Three things went wrong with that and a
 * shop hit each: a change made at the top is not saved until somebody scrolls to a button they
 * cannot see; two screens editing overlapping parts of one row overwrite each other; and a page
 * that long is a page where nobody finds what they came for.
 *
 * WHAT THIS GUARDS AGAINST is the half-finished version of that move — a setting whose control was
 * taken off Settings and whose new home was never finished, leaving a shop unable to change it at
 * all. So it checks both ends: gone from Settings, AND reachable and working on its own page.
 *
 *     node scripts/probe-settings-are-cards.mjs [http://localhost:3101]
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

/* Whatever the shop has now, restored at the end. */
const { data: before } = await db
  .from('store_settings')
  .select('update_reminder_minutes, receipt_footer')
  .eq('store_id', storeId)
  .single();

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
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
  const link = p.locator('[class*="rowLink"]:visible, button:visible').filter({ hasText: /Settings|Your shop/i }).first();
  if (await link.count()) {
    await link.click();
    await p.waitForTimeout(9000);
  }

  const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

  // ── Nothing left on Settings that needs saving ────────────────────────────
  check('the Save action is gone from the header', (await p.getByRole('button', { name: /Save settings|Saving your settings/i }).count()) === 0);

  /*
   * VISIBLE controls only. Every tab's stack stays mounted, so a field on a page sitting behind
   * this one is still in the DOM — counting all of them would fail against controls nobody can
   * reach, which is a test of the DOM rather than of the screen.
   */
  const visibleSelects = await p.locator('select:visible').count();
  check('no select boxes left on Settings', visibleSelects === 0, `${visibleSelects} visible`);

  const settingsText = await body();
  for (const gone of ['Paper width', 'Line above the receipt', 'Line at the bottom', 'Logo on the receipt']) {
    check(`"${gone}" has left Settings`, !settingsText.includes(gone));
  }

  // ── And each one is reachable and works where it went ─────────────────────
  check('Settings points at the receipt and the printer', /The receipt, your printer and your paper/i.test(settingsText));
  check('and at the update reminder', /How often to ask again/i.test(settingsText));

  console.log('\n— the update reminder, on its own page —');
  await p.getByRole('button', { name: /How often to ask again/i }).first().click();
  await p.waitForTimeout(7000);
  const sel = p.locator('select:visible').first();
  check('the page has the setting', (await sel.count()) > 0, (await body()).slice(0, 100));
  /*
   * A DIFFERENT value from the one it holds, so "it saved" cannot pass by accident on a page that
   * saved nothing.
   */
  const now = Number(before?.update_reminder_minutes ?? 30);
  const want = now === 60 ? 240 : 60;
  await sel.selectOption(String(want));
  await p.waitForTimeout(6000);
  const { data: after } = await db
    .from('store_settings')
    .select('update_reminder_minutes')
    .eq('store_id', storeId)
    .single();
  check(
    'and it saves as it is changed, with no Save button',
    Number(after?.update_reminder_minutes) === want,
    `${now} → ${after?.update_reminder_minutes}, wanted ${want}`,
  );
  await p.screenshot({ path: 'shots/probe-settings-updates.png', fullPage: true });

  console.log('\n— the receipt, on its own page —');
  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(3000);
  if (await link.count()) {
    await link.click();
    await p.waitForTimeout(7000);
  }
  await p.getByRole('button', { name: /The receipt, your printer and your paper/i }).first().click();
  await p.waitForTimeout(9000);

  const printText = await body();
  check('the receipt page opened', /Printing|What the receipt says/i.test(printText), printText.slice(0, 110));
  check('it has the paper width', /Paper width/i.test(printText));
  check('the words on the receipt', /Line above the receipt/i.test(printText));
  check('the bank details', /Bank details on receipts/i.test(printText));
  check('and how this device prints', /How this device prints/i.test(printText));

  /*
   * ONE PREVIEW. There were two — a bitmap drawn by the old settings block and the one built from
   * the lines the printer is sent — and they could disagree, which is the fault a shop reported.
   */
  const previews = await p.locator('[class*="PrintPreview_paper__"]:visible').count();
  check('there is exactly one preview', previews === 1, `${previews} on screen`);

  const widths = await p.locator('[class*="preset"]:visible, [class*="option"]:visible').filter({ hasText: /80mm|80 mm/i }).count();
  check('and one paper-width control, not two', widths <= 1, `${widths} offering 80mm`);
  await p.screenshot({ path: 'shots/probe-settings-receipt.png', fullPage: true });

  // ── The footer saves as it is typed, with no Save button anywhere ─────────
  const footer = p.getByLabel(/Line at the bottom/i).first();
  if (await footer.count()) {
    const mark = `probe ${Date.now().toString(36)}`;
    await footer.fill(mark);
    await footer.blur();
    await p.waitForTimeout(6000);
    const { data: saved } = await db
      .from('store_settings')
      .select('receipt_footer')
      .eq('store_id', storeId)
      .single();
    check('the receipt footer saves as it is typed', saved?.receipt_footer === mark, String(saved?.receipt_footer));
  }
} catch (e) {
  check('the probe ran to the end', false, String(e).split('\n')[0]);
  await p.screenshot({ path: 'shots/probe-settings-stopped.png', fullPage: true }).catch(() => {});
} finally {
  await b.close();
  await db
    .from('store_settings')
    .update({
      update_reminder_minutes: before?.update_reminder_minutes ?? 30,
      receipt_footer: before?.receipt_footer ?? null,
    })
    .eq('store_id', storeId);
  const { data: back } = await db
    .from('store_settings')
    .select('update_reminder_minutes, receipt_footer')
    .eq('store_id', storeId)
    .single();
  check(
    'the shop is left as it was found',
    Number(back?.update_reminder_minutes) === Number(before?.update_reminder_minutes ?? 30) &&
      (back?.receipt_footer ?? null) === (before?.receipt_footer ?? null),
    `${back?.update_reminder_minutes} / ${back?.receipt_footer}`,
  );
  console.log(failed === 0 ? '\n  all good' : `\n  ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
