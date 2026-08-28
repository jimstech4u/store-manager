/**
 * The till is online-first, and this is what that means in practice.
 *
 * An order exists in the shop from the moment the "+" is pressed — not once something has been
 * added to it. So a seller whose phone dies picks up another one, signs in, and the customers
 * they were serving are still there. This proves it by using TWO separate browser contexts: one
 * starts the orders, the other has never seen them.
 *
 * Cleans up after itself, cancelling every draft it opened.
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';

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

const browser = await chromium.launch();

const type = async (locator, value) =>
  locator.evaluate((el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);

/** A fresh context is a fresh device: its own storage, so nothing carries over. */
const openDevice = async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await type(page.locator('input[type="email"]').first(), env.SAMPLE_EMAIL);
  await type(page.locator('input[type="password"]').first(), env.SAMPLE_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(11000);
  return { context, page };
};

const storeId = (
  await admin.from('stores').select('id').eq('name', 'ASHABI GLOBAL RESOURCES').single()
).data.id;

/** Drafts open before this probe ran, which it must leave alone. */
const before = new Set(
  (
    await admin.from('draft_orders').select('id').eq('store_id', storeId).eq('status', 'open')
  ).data.map((r) => r.id),
);

const openedByProbe = async () => {
  const { data } = await admin
    .from('draft_orders')
    .select('id, code, status')
    .eq('store_id', storeId)
    .eq('status', 'open');
  return data.filter((r) => !before.has(r.id));
};

try {
  // ── One device starts a customer ───────────────────────────────────────────────────
  const first = await openDevice();
  const errors = [];
  first.page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));

  await first.page.getByRole('button', { name: 'Start another customer' }).click();
  await first.page.waitForTimeout(6000);

  const created = await openedByProbe();
  check('pressing + puts the order in the shop straight away', created.length > 0,
    `${created.length} new draft(s)`);
  check('and the shop gives it a handover code', created.every((d) => Boolean(d.code)),
    created.map((d) => d.code).join(', '));

  // The code has to be readable on the screen too — it is read aloud, not looked up.
  const shown = await first.page.locator('body').innerText();
  const anyCode = created.find((d) => shown.includes(d.code));
  check('the code is on screen for the seller to read out', Boolean(anyCode),
    anyCode?.code ?? 'not shown');

  // ── A DIFFERENT device signs in and finds it ───────────────────────────────────────
  const second = await openDevice();

  /*
   * Poll until the tabs arrive, rather than guessing how long that takes.
   *
   * Hydration fetches every order the shop has open and renders one tab each, so how long it takes
   * depends on how many there are and how fast the connection is. A fixed sleep passed on one run
   * and failed on the next, reporting a hydration bug that was not there.
   */
  let tabCount = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    tabCount = await second.page.getByRole('tab').count();
    if (tabCount > 1) break;
    await second.page.waitForTimeout(1000);
  }

  await second.page.screenshot({ path: 'shots/online-second-device.png' });
  check('another device picks up the orders already in the shop', tabCount > 1, `${tabCount} tabs`);

  /*
   * The code shown belongs to a real open order.
   *
   * Read from the element that displays it, not scraped out of the page text — a regex over the
   * whole body matched "CUSTO" out of the heading "CUSTOMER" and then went looking for an order
   * with that code, which is a test failing on its own cleverness rather than on the app.
   */
  const codeText = (
    await second.page.locator('[class*="CustomerTabs_code"]').first().innerText()
  ).trim();

  const { data: matching } = await admin
    .from('draft_orders')
    .select('id')
    .eq('store_id', storeId)
    .eq('status', 'open')
    .eq('code', codeText);

  check(
    'and the code it shows belongs to a real open order',
    (matching?.length ?? 0) > 0,
    codeText || 'nothing shown',
  );

  // ── A settled order cannot simply be cancelled away ────────────────────────────────
  /*
   * Asked of the database directly, because it is the database that has to hold this line. Once
   * money and stock have moved, the record is corrected by voiding the sale — never by deleting
   * the thing that caused it.
   */
  const anyDraft = created[0];
  await admin.from('draft_orders').update({ status: 'settled' }).eq('id', anyDraft.id);
  const owner = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  await owner.auth.signInWithPassword({
    email: env.SAMPLE_EMAIL,
    password: env.SAMPLE_PASSWORD,
  });
  const { error: cancelError } = await owner.rpc('cancel_draft_order', { p_draft_id: anyDraft.id });
  check('a settled order refuses to be cancelled', Boolean(cancelError),
    cancelError?.message ?? 'it was cancelled, which it must not be');

  // ── Cancelling an open one releases its code ───────────────────────────────────────
  await admin.from('draft_orders').update({ status: 'open' }).eq('id', anyDraft.id);
  const { error: okCancel } = await owner.rpc('cancel_draft_order', { p_draft_id: anyDraft.id });
  check('an open order cancels cleanly', !okCancel, okCancel?.message ?? '');

  const { data: after } = await admin
    .from('draft_orders')
    .select('status')
    .eq('id', anyDraft.id)
    .single();
  check('and it is cancelled, not deleted', after?.status === 'cancelled', after?.status);

  /*
   * The code is free again.
   *
   * The unique index is partial — it only holds a code while an order is open — so a cancelled
   * order's code goes straight back into the shop's pool. Proven by inserting another order that
   * takes the same code.
   */
  const { error: reuseError } = await admin.from('draft_orders').insert({
    store_id: storeId,
    code: anyDraft.code,
    status: 'open',
  });
  check('its code goes back for the next order to use', !reuseError,
    reuseError?.message ?? anyDraft.code);

  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  const leftovers = await openedByProbe();
  for (const d of leftovers) {
    await admin.from('draft_orders').update({ status: 'cancelled' }).eq('id', d.id);
  }
  if (leftovers.length) console.log(`  (cleaned up ${leftovers.length} draft(s))`);
  await browser.close();
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
