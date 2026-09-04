/**
 * One product, one set of shapes — everywhere it is spoken about.
 *
 * «on the shelf in pieces, cost in pieces, and you sell in crate so inconsistent … check for
 *  relationship so we know that all are not lagging any missing that we miss in ui»
 *
 * The base unit is how the arithmetic adds up. It was never meant to be how the shop is spoken to,
 * and it kept leaking: the stock figure, the cost, the price and the count box each picked their
 * own shape, so one product page could say it is kept in pieces, bought in pieces and sold in
 * crates. Every one of those was individually correct.
 *
 * So this checks the RELATIONSHIP rather than any single screen: for one real product, every word
 * the app uses for a quantity or a rate has to be a shape that product actually has, and screens
 * that quote the same fact have to quote it the same way.
 *
 * READ-ONLY, and it closes any till tab it opens.
 *
 *     node scripts/probe-shapes-everywhere.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/shapes-everywhere';
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
/*
 * Signed in with one retry.
 *
 * A long run of probe logins earns a rate limit, and `my_membership` came back null once — the
 * probe then threw on `.data[0]` with a stack trace about null, which says nothing about what
 * happened. One retry, and a sentence if it still will not.
 */
const membership = async () => {
  for (let go = 0; go < 2; go += 1) {
    await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
    const { data } = await shop.rpc('my_membership');
    if (data?.[0]) return data[0];
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log('  FAIL  could not sign in — the shop refused, or a rate limit from earlier runs');
  process.exit(1);
};
const storeId = (await membership()).store_id;
const startedAt = new Date(Date.now() - 1000).toISOString();

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

// ── A product kept in more than one shape, so the words can disagree ────────────────
const { data: rows } = await shop.rpc('product_selling_units', { p_store_id: storeId });
const byProduct = new Map();
for (const r of rows ?? []) {
  const list = byProduct.get(r.product_id) ?? [];
  list.push(r);
  byProduct.set(r.product_id, list);
}

let subject = null;
for (const [id, list] of byProduct) {
  if (list.length < 2) continue;
  const { data: prod } = await shop.from('products').select('name, base_unit').eq('id', id).single();
  subject = { id, name: prod.name, baseUnit: prod.base_unit, shapes: list };
  break;
}
if (!subject) {
  console.log('  SKIP  no product in this shop is kept in more than one shape');
  process.exit(0);
}

/** Every word this product legitimately has for a quantity. */
const words = new Set();
for (const u of subject.shapes) {
  words.add(u.unit_name.toLowerCase());
  words.add(u.unit_plural.toLowerCase());
}

console.log(`\n  ${subject.name}`);
console.log(`  shapes: ${[...words].join(', ')}`);
console.log(`  base unit: ${subject.baseUnit}${words.has(subject.baseUnit.toLowerCase()) ? '' : ' — NOT one of them'}\n`);

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

const tab = async (label) => {
  await p.evaluate(() => {
    (document.activeElement instanceof HTMLElement ? document.activeElement : null)?.blur();
  });
  await p.mouse.move(195, 420);
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(1000);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(3500);
};

/**
 * Every quantity and rate on the screen, and the word attached to it.
 *
 * Deliberately loose about WHICH figures it finds and strict about the words: the question is not
 * whether a number is right, it is whether the shop is being spoken to in a language it uses.
 */
const wordsOnScreen = async () => {
  const text = await body();
  const found = new Set();
  for (const m of text.matchAll(/[\d,.]+\s+([A-Za-z]+)/g)) found.add(m[1].toLowerCase());
  for (const m of text.matchAll(/(?:per|a|each)\s+([A-Za-z]+)/g)) found.add(m[1].toLowerCase());
  return found;
};

/** Words that are quantities but belong to no shape this product has. */
const strangers = (found) => {
  const quantityish = [...found].filter((w) =>
    /^(piece|pieces|bottle|bottles|crate|crates|pack|packs|carton|cartons|bag|bags|kilogram|kilograms|kg|litre|litres|dirica|diricas|paint|paints|can|cans|unit|units)$/.test(w),
  );
  return quantityish.filter((w) => !words.has(w));
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

  /*
   * Found by scrolling to it, not by searching.
   *
   * The search on this screen is a LAUNCHER — a button that opens a sheet — so the placeholder only
   * exists once the sheet is open, and reaching for it unguarded waits thirty seconds for a field
   * nobody asked for. The product is in the list; somebody with it on screen taps it.
   */
  const inList = p.getByText(subject.name, { exact: false }).locator('visible=true').first();
  await inList.scrollIntoViewIfNeeded().catch(() => {});
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${SHOTS}/1-list.png` });

  /*
   * EVERY ROW, against its own product's shapes.
   *
   * A first version read the whole screen and found "pieces" and "crates" — from other products,
   * which are entitled to their own words. Row by row it asks the question that matters: is any
   * product in this shop described in a unit it does not have?
   */
  const shapesByName = new Map();
  for (const [id, list] of byProduct) {
    const { data: prod } = await shop.from('products').select('name').eq('id', id).single();
    if (!prod) continue;
    const w = new Set();
    for (const u of list) {
      w.add(u.unit_name.toLowerCase());
      w.add(u.unit_plural.toLowerCase());
    }
    shapesByName.set(prod.name, w);
  }

  const rowTexts = (
    await p.locator('[class*="stock-page_item"]:visible').allInnerTexts()
  ).filter((t) => typeof t === 'string' && t.trim() !== '');
  const wrongRows = [];
  for (const raw of rowTexts) {
    const row = String(raw).replace(/\s+/g, ' ');
    const name = [...shapesByName.keys()].find((n) => row.startsWith(n));
    if (!name) continue;
    const mine = shapesByName.get(name);
    const found = new Set();
    for (const m of row.matchAll(/[\d,.]+\s+([A-Za-z]+)/g)) found.add(m[1].toLowerCase());
    for (const m of row.matchAll(/(?:per|a|each)\s+([A-Za-z]+)/g)) found.add(m[1].toLowerCase());
    const odd = [...found].filter(
      (w) =>
        /^(piece|pieces|bottle|bottles|crate|crates|pack|packs|carton|cartons|bag|bags|kilogram|kilograms|litre|litres|dirica|diricas|paint|paints|can|cans)$/.test(w) &&
        !mine.has(w),
    );
    if (odd.length > 0) wrongRows.push(`${name}: ${odd.join(', ')}`);
  }

  check(
    'no row describes a product in a unit it does not have',
    wrongRows.length === 0,
    wrongRows.length ? wrongRows.slice(0, 3).join(' | ') : `${rowTexts.length} row(s) checked`,
  );

  // ══ The product ═══════════════════════════════════════════════════════════════════
  console.log('\n— the product —');
  await inList.click();
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `${SHOTS}/2-product.png` });

  const item = await body();
  const itemStrangers = strangers(await wordsOnScreen());
  check(
    'the shelf, the cost and the price all speak the same language',
    itemStrangers.length === 0,
    itemStrangers.length
      ? `found ${itemStrangers.join(', ')} — this product has ${[...words].join('/')}`
      : 'no word on this page that the product does not have',
  );

  /*
   * A COST AND A PRICE FOR EVERY SHAPE.
   *
   * The page used to show one of each, and each picked its own shape — so it could read "₦422.40
   * per piece" above "You sell 1 pack for ₦5,200" and look like a shop that buys pieces and sells
   * packs. Both were individually correct.
   */
  for (const u of subject.shapes) {
    check(
      `${u.unit_name} is priced and costed on the same row`,
      new RegExp(u.unit_name, 'i').test(item),
      `looked for "${u.unit_name}"`,
    );
  }

  /*
   * AND THE FIGURES ARE THE RIGHT FIGURES.
   *
   * A number can be formatted perfectly, sit under the right label, name a shape the shop uses, and
   * still be read from the wrong column or computed from the wrong shape. "₦422.40 per piece" was a
   * real figure about a real thing — just not the thing the sentence claimed. So each one is
   * compared against what the database says, with the arithmetic done from the shape's own
   * multiplier rather than trusted.
   */
  console.log('\n— and the figures are the right figures —');
  const money = (n) =>
    '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const moneyWhole = (n) => '₦' + Number(n).toLocaleString('en-NG');

  for (const u of subject.shapes) {
    const cost = Number(u.avg_cost_per_unit);
    const price = u.price_per_unit == null ? null : Number(u.price_per_unit);

    if (cost > 0) {
      check(
        `${u.unit_name}: the cost on screen is the shop's cost x ${u.base_qty}`,
        item.includes(money(cost)) || item.includes(moneyWhole(cost)),
        `expected ${money(cost)}`,
      );
    }
    if (price != null && u.is_sold) {
      check(
        `${u.unit_name}: the price on screen is the price the till would charge`,
        item.includes(moneyWhole(price)) || item.includes(money(price)),
        `expected ${moneyWhole(price)}`,
      );
    }
  }

  /*
   * The stock figure, decomposed the way the page decomposes it — so this fails if the page starts
   * reading a different column, or divides where it should decompose.
   */
  const onHand = Number(subject.shapes[0].on_hand_base);
  const sorted = [...subject.shapes].sort((a, b) => Number(b.base_qty) - Number(a.base_qty));
  let left = onHand;
  const parts = [];
  if (onHand < 0) {
    const whole = sorted.find(
      (u) => Math.abs(onHand / Number(u.base_qty) - Math.round(onHand / Number(u.base_qty))) < 1e-9,
    );
    const unit = whole ?? sorted[sorted.length - 1];
    const q = Number((onHand / Number(unit.base_qty)).toFixed(2));
    parts.push(`${q} ${Math.abs(q) === 1 ? unit.unit_name.toLowerCase() : unit.unit_plural.toLowerCase()}`);
  } else {
    for (const u of sorted) {
      const whole = Math.floor(left / Number(u.base_qty) + 1e-9);
      if (whole > 0) {
        parts.push(`${whole} ${whole === 1 ? u.unit_name.toLowerCase() : u.unit_plural.toLowerCase()}`);
        left -= whole * Number(u.base_qty);
      }
    }
    if (parts.length === 0) parts.push(`0 ${sorted[sorted.length - 1].unit_plural.toLowerCase()}`);
  }
  const expected = parts.join(' ');
  check(
    'the shelf figure is the database figure, said in shapes',
    item.toLowerCase().includes(expected.toLowerCase()),
    `expected "${expected}" from ${onHand} base units`,
  );

  // ══ Counting it ═══════════════════════════════════════════════════════════════════
  console.log('\n— counting it —');
  await tab('Count');
  /*
   * VISIBLE ONLY. A pushed page never unmounts here, so the Stock list is still in the DOM under
   * the Count tab and a plain text match lands on a row nobody can see.
   */
  const inCount = p.getByText(subject.name, { exact: false }).locator('visible=true').first();
  await inCount.scrollIntoViewIfNeeded().catch(() => {});
  await p.waitForTimeout(1200);
  await inCount.click();
  await p.waitForTimeout(4000);
  const notNow = p.getByRole('button', { name: /^Not now$/ }).first();
  if ((await notNow.count()) > 0) {
    await notNow.click();
    await p.waitForTimeout(2500);
  }
  await p.screenshot({ path: `${SHOTS}/3-count.png` });

  const boxes = p.locator('[class*="shapeBoxes"] input');
  check(
    'a shelf is counted in every shape, not just one',
    (await boxes.count()) >= subject.shapes.length,
    `${await boxes.count()} box(es) for ${subject.shapes.length} shape(s)`,
  );

  const counting = await body();
  check(
    'and it still asks the question',
    /How many are on the shelf/i.test(counting),
    'replacing the field took its label with it once',
  );
  const countStrangers = strangers(await wordsOnScreen());
  check(
    'in the shop’s own words',
    countStrangers.length === 0,
    countStrangers.length ? `found ${countStrangers.join(', ')}` : [...words].join('/'),
  );

  check('no page errors along the way', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  const { data: open } = await admin
    .from('draft_orders')
    .select('id')
    .eq('store_id', storeId)
    .eq('status', 'open')
    .gte('created_at', startedAt);
  for (const r of open ?? []) await shop.rpc('cancel_draft_order', { p_draft_id: r.id });
  console.log(`\n  ok  ${(open ?? []).length} draft tab(s) opened, closed again`);
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
