/**
 * Every screen that says what is on the shelf says it the same way — clicked, not reasoned about.
 *
 * `probe-stock-in-shapes` proves the ARITHMETIC. This proves it REACHES the four places a shop
 * actually reads stock: the stock list, a product, the count screen, and the picker on a delivery.
 * Three of those were still saying it in base units or by division after the list was fixed, which
 * is the same defect wearing different clothes — and one only a click finds, because the function
 * they all import was already correct.
 *
 * THE SHELF IS SUPPLIED, NOT WRITTEN. No product in the sample shop has two shapes and a remainder
 * on it — everything is zero, negative, or a round number — and those read identically whichever
 * sentence the screen uses, so a probe running against the shop as it stands says PASS and proves
 * nothing. The `product_selling_units` response is intercepted and one product is given 1,196
 * bottles in crates of twelve. Nothing is written, so there is nothing to clean up, and the thing
 * under test — whether the screen decomposes what it is handed — is exactly what is exercised.
 *
 *     node scripts/probe-shape-read-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/shape-read';
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

const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

/*
 * ANY DRAFT THIS RUN OPENED, closed again.
 *
 * Visiting the Sell tab starts a customer, so a probe that only reads still leaves an empty tab
 * behind — and three of them left twenty in one evening. Bounded by when this run started rather
 * than by an id snapshot, because there are over a thousand drafts in this shop and PostgREST caps
 * a response at a thousand rows: the snapshot silently truncates and the new ones fall outside it.
 */
const closeOpenedDrafts = async (startedAt) => {
  const { data } = await admin
    .from('draft_orders')
    .select('id')
    .eq('store_id', storeId)
    .eq('status', 'open')
    .gte('created_at', startedAt);

  for (const r of data ?? []) await shop.rpc('cancel_draft_order', { p_draft_id: r.id });

  const { data: left } = await admin
    .from('draft_orders')
    .select('id')
    .eq('store_id', storeId)
    .eq('status', 'open')
    .gte('created_at', startedAt);
  return { closed: (data ?? []).length, left: (left ?? []).length };
};

const runStartedAt = new Date(Date.now() - 1000).toISOString();


let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

// ── Which product gets the crates ────────────────────────────────────────────────────
const { data: rows, error: readErr } = await shop.rpc('product_selling_units', {
  p_store_id: storeId,
});
if (readErr) {
  console.log(`  FAIL  could not read the shapes — ${readErr.message}`);
  process.exit(1);
}
if (!rows?.length) {
  console.log('  FAIL  the shop has no shapes at all');
  process.exit(1);
}

const SUBJECT = rows[0].product_id;
const { data: prod } = await shop.from('products').select('name').eq('id', SUBJECT).single();
const NAME = prod.name;

const STOCK = 1196;
const CRATE = 12;
const WHOLE = Math.floor(STOCK / CRATE); // 99
const REST = STOCK - WHOLE * CRATE; //  8
const WANT = new RegExp(`${WHOLE}\\s+crates\\s+${REST}\\s+bottles`, 'i');
const OLD_WAY = new RegExp(`${(STOCK / CRATE).toFixed(2)}`); // "99.67"
const BASE_ONLY = new RegExp(`${STOCK}\\s+bottles`, 'i');

/** The two rows the pages will be handed for that product. */
const supplied = (template) => {
  const shape = (name, plural, baseQty, isCounted) => ({
    ...template,
    product_id: SUBJECT,
    product_unit_id: `${SUBJECT}-${baseQty}`,
    unit_name: name,
    unit_plural: plural,
    base_qty: baseQty,
    is_default: isCounted,
    on_hand_units: STOCK / baseQty,
    on_hand_base: STOCK,
    is_counted: isCounted,
    is_deposit: false,
    is_sold: true,
    is_bought: baseQty > 1,
  });
  return [shape('Crate', 'Crates', CRATE, true), shape('Bottle', 'Bottles', 1, false)];
};

console.log(`\n  the shelf supplied to every screen: ${NAME}`);
console.log(`  ${STOCK} bottles, twelve to a crate → "${WHOLE} crates ${REST} bottles"`);
console.log(`  the old sentence would have said "${(STOCK / CRATE).toFixed(2)} crates"\n`);

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

/*
 * Answer the real server, then replace ONE product's rows.
 *
 * Not a wholesale fake: every other product keeps whatever it actually has, so the pages render the
 * shop they normally would and a break anywhere else still shows up.
 */
let intercepted = 0;
await p.route('**/rest/v1/rpc/product_selling_units', async (route) => {
  const res = await route.fetch();
  let body;
  try {
    body = await res.json();
  } catch {
    return route.fulfill({ response: res });
  }
  if (!Array.isArray(body)) return route.fulfill({ response: res });

  const template = body.find((r) => r.product_id === SUBJECT) ?? body[0];
  const patched = [...body.filter((r) => r.product_id !== SUBJECT), ...supplied(template)];
  intercepted += 1;
  await route.fulfill({
    response: res,
    body: JSON.stringify(patched),
    headers: { ...res.headers(), 'content-length': undefined },
  });
});

const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

const tab = async (label) => {
  await p.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll('div')) {
      if (el.scrollHeight > el.clientHeight + 40) el.scrollTop = 0;
    }
  });
  await p.waitForTimeout(700);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(3500);
};

const findText = async (re) => {
  const t = await body();
  return t.match(re)?.[0] ?? t.slice(0, 100);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ══ The stock list ════════════════════════════════════════════════════════════════
  console.log('— the stock list —');
  await tab('Stock');
  const stockSearch = p.getByPlaceholder(/search/i).first();
  if ((await stockSearch.count()) > 0) {
    await stockSearch.fill(NAME);
    await p.waitForTimeout(3000);
  }
  await p.screenshot({ path: `${SHOTS}/1-list.png` });

  check('the read was intercepted at all', intercepted > 0, `${intercepted} time(s)`);

  const list = await body();
  check('says it in two shapes', WANT.test(list), await findText(WANT));
  check('and not as a decimal of a crate', !OLD_WAY.test(list));

  // ══ The product ═══════════════════════════════════════════════════════════════════
  console.log('\n— the product itself —');
  await p.getByText(NAME, { exact: false }).first().click();
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `${SHOTS}/2-product.png` });

  const item = await body();
  check('"On the shelf" is in shapes', WANT.test(item), await findText(WANT));
  check('not the base unit alone', !BASE_ONLY.test(item));

  // The removal warning names a quantity somebody can picture.
  const trash = p.getByRole('button', { name: /Remove this item/i }).first();
  if ((await trash.count()) > 0) {
    await trash.click();
    await p.waitForTimeout(2500);
    await p.screenshot({ path: `${SHOTS}/3-remove.png` });
    const warn = await body();
    check(
      'the removal warning says what is still there, in shapes',
      /still .{0,40} on the shelf/i.test(warn) && WANT.test(warn),
      (warn.match(/There (is|are) still [^.]{0,50}/i) ?? ['no warning found'])[0],
    );
    await p.keyboard.press('Escape');
    await p.waitForTimeout(1500);
  } else {
    console.log('  SKIP  this account cannot remove an item');
  }

  // ══ The count screen ══════════════════════════════════════════════════════════════
  console.log('\n— counting the shelf —');
  await tab('Count');
  await p.waitForTimeout(2500);
  const countSearch = p.getByPlaceholder(/search/i).first();
  if ((await countSearch.count()) > 0) {
    await countSearch.fill(NAME);
    await p.waitForTimeout(3000);
  }
  await p.screenshot({ path: `${SHOTS}/4-count.png` });

  const count = await body();
  check('what the records say is comparable to a shelf', WANT.test(count), await findText(WANT));
  check('no decimal of a crate to argue with', !OLD_WAY.test(count));

  // ══ The picker on a delivery ══════════════════════════════════════════════════════
  console.log('\n— deciding how much more to take —');
  await tab('Stock');
  await p.waitForTimeout(2000);
  /*
   * Tapped TWICE on purpose.
   *
   * Coming back to a tab restores the stack where it was left — standing on the product page, whose
   * header carries Edit and Remove, not the list's Record-a-delivery. Re-tapping the active tab is
   * the gesture that pops a stack to its root, and it is the one a shop would use.
   */
  await tab('Stock');
  await p.waitForTimeout(2000);
  // The header action, by its aria-label — the button itself is an icon.
  const receive = p.getByRole('button', { name: 'Record a delivery' }).first();
  if ((await receive.count()) > 0) {
    await receive.click();
    await p.waitForTimeout(4500);
    const add = p.getByRole('button', { name: /^Add an item$/ }).first();
    if ((await add.count()) > 0) {
      await add.click();
      await p.waitForTimeout(3000);
      const sheetSearch = p.getByPlaceholder(/search/i).last();
      await sheetSearch.fill(NAME);
      await p.waitForTimeout(3000);
      await p.screenshot({ path: `${SHOTS}/5-picker.png` });

      const picker = await body();
      check(
        'the picker says what is already here, in shapes',
        WANT.test(picker),
        await findText(/[\w\s.]{0,30}in stock/),
      );
      check('and not a decimal', !OLD_WAY.test(picker));
    } else {
      console.log('  SKIP  no "add an item" on the delivery screen');
    }
  } else {
    console.log('  SKIP  no way into a delivery from Stock');
  }

  check('no page errors along the way', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  const tidy = await closeOpenedDrafts(runStartedAt);
  console.log(
    tidy.left === 0
      ? `  ok  ${tidy.closed} draft tab(s) opened by this run, all closed`
      : `  FAIL  ${tidy.left} draft tab(s) left open in the shop`,
  );
  if (tidy.left > 0) failed += 1;
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
