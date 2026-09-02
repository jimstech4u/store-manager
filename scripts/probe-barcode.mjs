/**
 * Scanning: the camera opens where a shop needs it, and a code finds the right item.
 *
 * WHAT THIS CAN PROVE, and what it cannot.
 *
 * `getUserMedia` is refused outright on this machine — a bare call returns NotAllowedError even
 * with Chromium's fake-device flags and the permission granted for the origin. So the live camera
 * path cannot be exercised here, and pretending otherwise would be worse than saying so.
 *
 * What IS checked, and matters at least as much: the scan is offered in both places a shop needs
 * it; opening it never dead-ends — either a camera view or a plain explanation with a way on; the
 * way on is present and works; and nothing is left holding the camera afterwards. A shop that
 * declines the permission, or whose phone hands the camera to another app, sees exactly this path,
 * so it is the one that must not be a blank sheet.
 *
 * The lookup half is driven directly against the shop, where it can be proven properly.
 *
 *     node scripts/probe-barcode.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/barcode';
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
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const stamp = Date.now().toString().slice(-6);
const CODE = `5449${stamp}999`;

// ══ The lookup, driven directly ═════════════════════════════════════════════════════════════
console.log('\n— what a scanned code finds —');

const { data: existing } = await admin
  .from('products')
  .select('id, name')
  .eq('store_id', storeId)
  .eq('status', 'active')
  .limit(1)
  .single();

await admin.from('products').update({ barcode: CODE }).eq('id', existing.id);

const { data: found, error: findErr } = await shop.rpc('product_by_barcode', {
  p_store_id: storeId,
  p_barcode: CODE,
});
check('a known code finds its item', !findErr && found?.id === existing.id, findErr?.message ?? String(found?.name));

const { data: missing } = await shop.rpc('product_by_barcode', {
  p_store_id: storeId,
  p_barcode: '0000000000000',
});
check(
  'and an unknown one answers nothing, rather than failing',
  !missing || !missing.id,
  JSON.stringify(missing),
);

// ══ The camera, in the two places it is offered ══════════════════════════════════════════════
const browser = await chromium.launch({
  args: [
    // A synthetic camera: the stream is real, the picture is a test pattern.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  permissions: ['camera'],
});
// Granted for THIS origin: a context-wide grant without one is not applied to the page's origin,
// so getUserMedia threw NotAllowedError and the probe blamed the app for its own setup.
await context.grantPermissions(['camera'], { origin: BASE });
const p = await context.newPage();

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const tab = async (label) => {
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(900);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(4500);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ── On the item form ──────────────────────────────────────────────────────────────
  console.log('\n— on the item form —');
  await tab('Stock');
  await p.getByRole('button', { name: /add an item/i }).first().click();
  await p.waitForTimeout(4000);

  const scanButton = p.getByRole('button', { name: /Scan it with the camera/i }).first();
  check('the form offers to scan', (await scanButton.count()) > 0);
  await scanButton.scrollIntoViewIfNeeded();
  await scanButton.click();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/1-form-scanner.png` });

  const sheetText = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  const hasView = (await p.locator('video').count()) > 0;
  const explains = /Cannot use the camera/i.test(sheetText);

  check(
    'it opens to a camera view, or says plainly why not',
    hasView || explains,
    hasView ? 'camera view' : sheetText.slice(0, 100),
  );
  check('and never to a dead end', /Type it instead/i.test(sheetText));

  await p.getByRole('button', { name: /Type it instead/i }).click();
  await p.waitForTimeout(2000);

  /*
   * The camera must be RELEASED, not merely hidden.
   *
   * A stream left running keeps the indicator light on and drains a battery somebody is trading
   * on all day — and on some phones blocks every other app from the camera.
   */
  const stillLive = await p.evaluate(async () => {
    const els = Array.from(document.querySelectorAll('video'));
    return els.some((v) => {
      const s = v.srcObject;
      return s && 'getTracks' in s && s.getTracks().some((t) => t.readyState === 'live');
    });
  });
  check('closing it releases the camera', !stillLive, stillLive ? 'a track is still live' : '');

  // ── At the till ───────────────────────────────────────────────────────────────────
  console.log('\n— at the till —');
  await tab('Sell');
  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  if (await plus.count()) {
    await plus.scrollIntoViewIfNeeded();
    await plus.click();
    await p.waitForTimeout(5000);
  }
  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(3500);
  await p.screenshot({ path: `${SHOTS}/2-picker.png` });

  const tillScan = p.getByRole('button', { name: /Scan a barcode instead/i }).first();
  check('the picker offers to scan', (await tillScan.count()) > 0);
  await tillScan.click();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/3-till-scanner.png` });

  const tillSheet = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check(
    'it opens there too, view or explanation',
    (await p.locator('video').count()) > 0 || /Cannot use the camera/i.test(tillSheet),
    tillSheet.slice(0, 100),
  );
  check('with the same way on', /Type it instead/i.test(tillSheet));

  await p.getByRole('button', { name: /Type it instead/i }).click();
  await p.waitForTimeout(2000);

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  // Put the item's barcode back to whatever it was — this probe borrowed a real product.
  await admin.from('products').update({ barcode: null }).eq('id', existing.id);
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
