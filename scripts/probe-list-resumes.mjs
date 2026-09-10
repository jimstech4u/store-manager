/**
 * A list that came back from the background, and kept everything it had.
 *
 * Reported from a phone: the stock and count screens return after a long spell in the background
 * showing TWO items — and both of them products created since the list was last read. Money and
 * People, on the same device, keep their lists.
 *
 * That shape is the whole diagnosis. Everything already known was filtered out as a duplicate and
 * only genuinely new rows survived:
 *
 *     load(true)            seenRef = new Set()      the reset clears the duplicate filter
 *     ...awaiting
 *     IndexedDB rehydrates  snapshot.items = old 30
 *     the seeding block     sees an empty filter beside a full list, and seeds all 30 back
 *     the response lands    every row filtered as "seen"
 *     items = fresh         → only what was created while the list was away
 *
 * So this reproduces it the way it happens: load the list, create products behind its back, plant
 * the persisted snapshot the way a suspended tab leaves it, and come back.
 *
 *     node scripts/probe-list-resumes.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const NL = String.fromCharCode(10);
const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS = 'shots/list-resumes';
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
const made = [];

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

let step = 0;
const shot = async (name) => {
  step += 1;
  await p.screenshot({ path: `${SHOTS}/${String(step).padStart(2, '0')}-${name}.png` });
};

const rowsOn = () => p.locator('li > button[class*="stock-page_item"]').count();

const openStock = async () => {
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(7000);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.locator('.nav-item').first().waitFor({ state: 'visible', timeout: 180000 });
  await p.waitForTimeout(3000);

  await openStock();
  await shot('first-load');

  const full = await rowsOn();
  check('the stock list loads a full page', full > 5, `${full} rows`);

  /*
   * PRODUCTS CREATED WHILE THE LIST IS AWAY.
   *
   * This is what makes the fault visible rather than silent. With nothing new to keep, a poisoned
   * duplicate filter produces an EMPTY `fresh` and the list is left alone; with new rows it
   * produces exactly those and throws everything else away. Two, because two is what was reported.
   */
  console.log(NL + '— two products appear while the screen is in the background —');
  for (const n of [1, 2]) {
    const { data } = await admin
      .from('products')
      .insert({
        store_id: storeId,
        name: `ZZ Resume ${stamp}-${n}`,
        base_unit: 'piece',
        status: 'active',
      })
      .select('id')
      .single();
    made.push(data.id);
  }
  check('two new products exist', made.length === 2);

  /*
   * AND THE STATE A SUSPENDED TAB LEAVES: the snapshot persisted, the page reloaded.
   *
   * The reload is what makes the restore race the mount fetch, which is the race itself. On a
   * phone this is the browser discarding the tab's context and rebuilding it on the way back.
   */
  await p.reload({ waitUntil: 'networkidle' });
  await p.locator('.nav-item').first().waitFor({ state: 'visible', timeout: 180000 });
  await p.waitForTimeout(2500);
  await openStock();
  await shot('after-resume');

  const after = await rowsOn();

  /*
   * THE ASSERTION, said as the fault reads.
   *
   * Not "more than two" — a list that came back with three would be the same bug with a third
   * product. It has to come back with everything it had, plus what appeared.
   */
  check(
    'the list comes back whole, not just the rows created since',
    after >= full,
    `${after} rows, was ${full}`,
  );

  const body = await p.locator('body').innerText();
  const onlyNew =
    body.includes(`ZZ Resume ${stamp}-1`) && after <= 3;
  check('and is not reduced to what is new', !onlyNew, onlyNew ? `only ${after} rows` : '');
} catch (e) {
  console.log(`${NL}  FAIL  the walk did not finish — ${String(e).split('\n')[0]}`);
  await shot('where-it-stopped');
  failed += 1;
} finally {
  await browser.close();
  for (const id of made) {
    const { error } = await admin.from('products').delete().eq('id', id);
    if (error) await admin.from('products').update({ status: 'archived' }).eq('id', id);
  }
  const { data: left } = await admin
    .from('products')
    .select('name,status')
    .in('id', made.length > 0 ? made : ['00000000-0000-0000-0000-000000000000']);
  console.log(
    `${NL}left behind: ${(left ?? []).filter((r) => r.status !== 'archived').length} product(s) still listed`,
  );
  console.log(`${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}
