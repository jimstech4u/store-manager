/**
 * Every selection sheet in the app: is the close button big enough to hit, and do the rows keep
 * off the edges of the screen?
 *
 * MEASURED, not looked at. "It looks about right" is how a 24px close button in the corner of a
 * phone survived — the icon is drawn at a comfortable size and the thing you can actually tap is
 * the glyph. This reads the boxes the browser lays out.
 *
 *     node scripts/probe-viewer-touch.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/viewer-touch';
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/**
 * The size a finger needs.
 *
 * 44px is the figure both Apple and the WCAG target-size guidance land on, and it is the number
 * this app's own `--touch-min` is set to.
 */
const TOUCH_MIN = 44;
const VIEWPORT = 390;


/*
 * Tidy up the tabs this run opened.
 *
 * Tapping "Start another customer" creates a real open order in the shop, with a real spoken code
 * reserved against it. Left behind, they pile up in the customer bar a seller has to scroll past —
 * ninety-three of them accumulated before anybody noticed. Only EMPTY ones opened after this run
 * started are touched, so a real sale somebody is building is never cancelled.
 */
async function closeTabsOpenedByThisRun(admin, storeId, since) {
  const { data: opened } = await admin
    .from('draft_orders')
    .select('id')
    .eq('store_id', storeId)
    .eq('status', 'open')
    .gte('created_at', since);

  for (const d of opened ?? []) {
    const { count } = await admin
      .from('draft_order_lines')
      .select('id', { count: 'exact', head: true })
      .eq('draft_order_id', d.id);
    if ((count ?? 0) === 0) {
      // Cancelled, not deleted — that is what releases the code for the next order.
      await admin.from('draft_orders').update({ status: 'cancelled', code: null }).eq('id', d.id);
    }
  }
}

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const storeId = (await admin.from('stores').select('id').limit(1).single()).data.id;
const runStartedAt = new Date().toISOString();

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: VIEWPORT, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const tab = async (label) => {
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(1000);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(4500);
};

/** Measures whichever selection sheet is currently open. */
const measure = async (name) => {
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${SHOTS}/${name}.png` });

  const close = p.locator('.selection-viewer-cancel:visible').first();
  if ((await close.count()) === 0) {
    check(`${name}: the sheet has a close button`, false, 'none found');
    return;
  }

  const box = await close.boundingBox();
  check(
    `${name}: close button is at least ${TOUCH_MIN}px square`,
    box.width >= TOUCH_MIN && box.height >= TOUCH_MIN,
    `${Math.round(box.width)}x${Math.round(box.height)}`,
  );

  // It must also stay ON the screen — a 44px box half off the right edge is still a 22px target.
  check(
    `${name}: and sits fully on screen`,
    box.x >= 0 && box.x + box.width <= VIEWPORT + 0.5,
    `right edge at ${Math.round(box.x + box.width)} of ${VIEWPORT}`,
  );

  check(
    `${name}: it announces itself`,
    Boolean(await close.getAttribute('aria-label')),
    `aria-label="${await close.getAttribute('aria-label')}"`,
  );

  // And the rows keep off the sides.
  const row = p.locator('.selection-viewer-content:visible > *').first();
  if (await row.count()) {
    const rb = await row.boundingBox();
    if (rb) {
      check(
        `${name}: rows keep a gap from both edges`,
        rb.x >= 8 && rb.x + rb.width <= VIEWPORT - 8,
        `left ${Math.round(rb.x)}, right ${Math.round(VIEWPORT - (rb.x + rb.width))}`,
      );
    }
  }
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  console.log('\n— the product picker, on the till —');
  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  if (await plus.count()) {
    await plus.click();
    await p.waitForTimeout(5000);
  }
  await p.screenshot({ path: `${SHOTS}/0-till.png` });
  console.log('  till:', (await p.locator('body').innerText()).slice(0, 200));
  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await measure('1-product-picker');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(2000);

  console.log('\n— the customer picker —');
  const item = p.locator('[role="dialog"] [class*="ProductPicker_name"]').first();
  if (await item.count()) {
    await item.click();
    await p.waitForTimeout(5000);
  } else {
    await p.getByRole('button', { name: /Add an item/i }).first().click();
    await p.waitForTimeout(3000);
    await p.locator('[role="dialog"] [class*="ProductPicker_name"]').first().click();
    await p.waitForTimeout(5000);
  }
  await p.getByRole('button', { name: /take payment/i }).first().click();
  await p.waitForTimeout(5000);
  await p.locator('[class*="forRow"]').first().click();
  await measure('2-customer-picker');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(2000);

  console.log('\n— the unit picker, in the catalogue —');
  await p.locator('button[aria-label*="back" i]:visible').first().click().catch(() => {});
  await p.waitForTimeout(3000);
  await tab('Stock');
  const firstProduct = p.locator('[class*="stock-page_itemName"]').first();
  if (await firstProduct.count()) {
    await firstProduct.click();
    await p.waitForTimeout(4000);
    const opener = p.getByText('How you buy and sell it').first();
    if (await opener.count()) {
      await opener.click();
      await p.waitForTimeout(4500);
      await p.getByRole('button', { name: /Add a shape/i }).first().click();
      await measure('3-unit-picker');
    } else {
      console.log('  (no units screen reachable on this item)');
    }
  }
} finally {
  await browser.close();
  await closeTabsOpenedByThisRun(admin, storeId, runStartedAt);
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
