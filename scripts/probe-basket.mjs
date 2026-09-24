/**
 * A BASKET THAT IS ONE BASKET PER SELLER.
 *
 * The claim being tested is the shape: in this marketplace a basket is not one list, it is one list
 * PER SHOP, each with its own total and its own send button, because each is a separate order to a
 * separate business.
 *
 * ABOUT THE SECOND SELLER. This database has exactly one public shop, so the two-seller case cannot
 * be reached by clicking. Rather than skip the only check that matters — or invent a second shop on
 * a live marketplace — the probe fills the basket from the real shop through the real buttons, reads
 * back WHAT THE APP ITSELF PERSISTED, and writes that record back with a second seller in it. It
 * never hardcodes the storage format: it learns the format from a basket the app wrote, so the day
 * state-stack changes how it persists, this keeps working.
 *
 * Also checked, each of them a real way this could be wrong:
 *   · the basket survives a reload — it is persisted, so a shopper can come back to it
 *   · the count in the top bar is the count, and is ABSENT rather than 0 when empty
 *   · Add / Save / Share exist on a product page, and Save survives a reload
 *   · <a href> is not underlined by default
 *   · the shop's Sell header carries an Orders action that opens the orders page
 *
 * WAITS ARE `domcontentloaded` PLUS A PAUSE, never `networkidle`. Once the service worker is
 * registered — which it is, a second after the first page — it can hold a connection open long
 * enough that the network never goes idle, and the probe then fails on a wait rather than on
 * anything it was asked to check.
 *
 *     node scripts/probe-basket.mjs [http://localhost:3101]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const note = (what, detail = '') => console.log(`  ····  ${what}${detail ? ` — ${detail}` : ''}`);

/** Read every key state-stack has persisted, so the probe can find the basket without guessing. */
const readStore = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('StateStackDB', 1);
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('state')) return resolve([]);
          const st = db.transaction(['state'], 'readonly').objectStore('state');
          const keys = st.getAllKeys();
          const vals = st.getAll();
          keys.onsuccess = () => {
            vals.onsuccess = () => resolve(keys.result.map((k, i) => [k, vals.result[i]]));
          };
        };
      }),
  );

const writeStore = (page, key, value) =>
  page.evaluate(
    ([k, v]) =>
      new Promise((resolve) => {
        const open = indexedDB.open('StateStackDB', 1);
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const db = open.result;
          const st = db.transaction(['state'], 'readwrite').objectStore('state');
          const req = st.put(v, k);
          req.onsuccess = () => resolve(true);
          req.onerror = () => resolve(false);
        };
      }),
    [key, value],
  );

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

try {
  // ══ 1. Two products, taken from the site's own statement of what is public ════════
  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  const products = [...sitemap.matchAll(/<loc>([^<]*\/product\/[^<]*)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  check('the sitemap lists public products', products.length >= 2, `${products.length} product(s)`);
  if (products.length < 2) throw new Error('need two public products');
  const [first, second] = products;

  // ══ 2. The empty basket ═══════════════════════════════════════════════════════════
  await p.goto(`${BASE}/cart`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  check('the basket page answers', /basket/i.test(await p.locator('h1').first().innerText()));
  check('and says it is empty', /nothing in it/i.test(await p.locator('main').innerText()));
  const badgeWhenEmpty = await p.locator('header a[href="/cart"] span').count();
  check('no badge when there is nothing in it', badgeWhenEmpty === 0, `${badgeWhenEmpty} badge(s)`);

  // ══ 3. Add two products, through the buttons a shopper uses ═══════════════════════
  for (const path of [first, second]) {
    await p.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2500);

    const add = p.getByRole('button', { name: /add .* to basket/i }).first();
    check(`${path.split('/').pop().slice(0, 24)}: offers Add to basket`, (await add.count()) > 0);
    if (await add.count()) {
      await add.click();
      await p.waitForTimeout(900);
      check('and confirms the tap landed', /added|in basket/i.test(await add.innerText()), (await add.innerText()).slice(0, 34));
    }

    check('there is a Save', (await p.getByRole('button', { name: /save this|remove from saved/i }).count()) > 0);
    check('there is a Share', (await p.getByRole('button', { name: /^share$/i }).count()) > 0);
  }

  // Saved, then reloaded: a favourite held only in memory would fail here.
  const save = p.getByRole('button', { name: /save this/i }).first();
  if (await save.count()) await save.click();
  await p.waitForTimeout(800);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  check('a saved product is still saved after a reload', (await p.getByRole('button', { name: /remove from saved/i }).count()) > 0);

  // ══ 4. The badge ══════════════════════════════════════════════════════════════════
  const badge = p.locator('header a[href="/cart"] span').first();
  check('the top bar now carries a badge', (await badge.count()) > 0);
  if (await badge.count()) check('and it reads 2', (await badge.innerText()).trim() === '2', (await badge.innerText()).trim());

  // ══ 5. One shop, one block, two lines ═════════════════════════════════════════════
  await p.goto(`${BASE}/cart`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  check('both products are in the basket', (await p.locator('main section li').count()) === 2, `${await p.locator('main section li').count()} line(s)`);
  check('and under one shop, because they came from one shop', (await p.locator('main section').count()) === 1);
  note('summary', (await p.locator('main p').first().innerText()).replace(/\s+/g, ' '));

  const plus = p.getByRole('button', { name: /one more/i }).first();
  await plus.click();
  await p.waitForTimeout(700);
  check('the stepper raises a line', (await p.locator('main section [class*="qty"] > span').first().innerText()).trim() === '2');

  // ══ 6. It survives a reload ═══════════════════════════════════════════════════════
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  check('the basket survives a reload', (await p.locator('main section li').count()) === 2);
  check('and so does the raised quantity', (await p.locator('main section [class*="qty"] > span').first().innerText()).trim() === '2');

  // ══ 7. A SECOND SELLER — see the note at the top of this file ═════════════════════
  const rows = await readStore(p);
  const basketRow = rows.find(([, v]) => JSON.stringify(v ?? null).includes('storeCode'));
  check('the app persisted the basket', Boolean(basketRow), basketRow ? String(basketRow[0]) : rows.map(([k]) => k).join(', ').slice(0, 80));

  if (basketRow) {
    const [key, value] = basketRow;
    /*
     * state-stack stores the JSON TEXT of the value, not the value. Learned here rather than
     * assumed: whatever came back is unwrapped if it is a string and re-wrapped the same way, so
     * the probe keeps working if that ever changes.
     */
    const wasText = typeof value === 'string';
    const clone = wasText ? JSON.parse(value) : JSON.parse(JSON.stringify(value));
    const findSellers = (node) => {
      if (Array.isArray(node) && node.length && node[0] && typeof node[0] === 'object' && 'storeCode' in node[0]) return node;
      if (node && typeof node === 'object') {
        for (const v of Object.values(node)) {
          const hit = findSellers(v);
          if (hit) return hit;
        }
      }
      return null;
    };
    const sellers = findSellers(clone);
    check('and the persisted shape is the grouped one', Boolean(sellers), sellers ? `${sellers.length} seller(s)` : 'no seller array found');

    if (sellers) {
      const copy = JSON.parse(JSON.stringify(sellers[0]));
      copy.storeCode = 'PROBE2';
      copy.storeName = 'A Second Shop';
      copy.lines = [{ ...copy.lines[0], productId: 'probe-second-seller', name: 'Something from elsewhere', qty: 1 }];
      sellers.push(copy);
      await writeStore(p, key, wasText ? JSON.stringify(clone) : clone);

      /*
       * `reload`, and not `goto` to the same address. Chrome treats a goto to the URL it is already
       * on as a same-document navigation and never reports networkidle, so the probe hung here for
       * thirty seconds and then failed for a reason that had nothing to do with the basket.
       */
      await p.reload({ waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(3500);
      const blocks = await p.locator('main section').count();
      check('two shops means two blocks', blocks === 2, `${blocks} block(s)`);
      const sends = await p.getByRole('button', { name: /send this order/i }).count();
      check('each shop has its own send button', sends === 2, `${sends} button(s)`);
      const totals = await p.locator('main [class*="total"]').allInnerTexts();
      check('and its own total', totals.length === 2, totals.join(' | ').replace(/\s+/g, ' '));
      check('the summary says two shops', /2 shops/i.test(await p.locator('main p').first().innerText()), (await p.locator('main p').first().innerText()).replace(/\s+/g, ' '));

      // ══ 8. Removing one seller leaves the other ═════════════════════════════════
      await p.getByRole('button', { name: /remove all/i }).last().click();
      await p.waitForTimeout(900);
      check('removing one shop leaves the other', (await p.locator('main section').count()) === 1);
    }
  }

  // ══ 9. Links are not underlined ═══════════════════════════════════════════════════
  const underlined = await p.evaluate(
    () => [...document.querySelectorAll('a')].filter((a) => getComputedStyle(a).textDecorationLine === 'underline').length,
  );
  check('links are not underlined by default', underlined === 0, `${underlined} underlined`);

  // ══ 10. The shop's side: Orders in the Sell header ════════════════════════════════
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(15000);
  check('signed in, at the till', new URL(p.url()).pathname.startsWith('/main'), new URL(p.url()).pathname);

  await p.locator('.nav-item').filter({ hasText: /^Sell$/ }).first().click();
  await p.waitForTimeout(5000);
  const orders = p.getByRole('button', { name: /orders/i }).first();
  check('the Sell header carries an Orders action', (await orders.count()) > 0);

  if (await orders.count()) {
    await orders.click();
    await p.waitForTimeout(5000);
    const text = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
    check('it opens the orders page', /marketplace/i.test(text), text.slice(0, 70));
    /*
     * Either state is a pass. With nothing waiting the honest answer IS the empty state, and a
     * check that demanded rows would only pass against a seeded database.
     */
    check(
      'which lists orders, or says there are none',
      /no orders waiting/i.test(text) || /accept and open at the till/i.test(text),
      /no orders waiting/i.test(text) ? 'none waiting' : 'orders listed',
    );
  }
} catch (e) {
  check('the probe ran to the end', false, e.message);
} finally {
  await browser.close();
  console.log(failed === 0 ? '\n  all good\n' : `\n  ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}
