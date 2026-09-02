/**
 * The empties journey, clicked.
 *
 * `probe-settle-empties` proves the database does the right thing. This proves a shop can reach it:
 * the page opens from the till and from a receipt, it lists receipts rather than pools, settling is
 * a PUSHED PAGE rather than a sheet (a form that records money has to survive a rotation), a
 * partial return is recordable without an argument, the figure on screen moves afterwards, and a
 * product says what it has out in customers' yards.
 *
 * Writes, and cleans up through `clean-probe-rows.py` — these ledgers refuse a delete, so the
 * probe cannot tidy after itself directly.
 *
 *     node scripts/probe-empties-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/empties-ui';
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

/**
 * Row ids this run caused, so the cleaner can name them.
 *
 * A settlement recorded by CLICKING looks exactly like one a shop recorded — there is no note to
 * stamp and no marker to leave, which is the point of testing the real screen. So the only safe way
 * to undo it is to know which rows appeared while the probe was driving, and the only way to know
 * that is to look before and after.
 *
 * Two runs of an earlier version left four units settled on a real customer's receipt because this
 * did not exist and the cleaner had nothing to match on.
 */
const caused = [];

const ledgerIds = async () => {
  const { data } = await admin
    .from('deposit_ledger')
    .select('id')
    .lt('qty_units', 0)
    .order('created_at', { ascending: false })
    .limit(50);
  return new Set((data ?? []).map((r) => r.id));
};
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

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

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ══ Reachable from the till ═══════════════════════════════════════════════════════
  console.log('\n— from the counter —');
  await tab('Sell');
  const entry = p.getByRole('button', { name: /Containers still to come back/i }).first();
  check('the till offers what is still out', (await entry.count()) > 0);
  await entry.click();
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `${SHOTS}/1-list.png` });

  const listed = await body();
  check('the page opens', /Empties out/i.test(listed), listed.slice(0, 70));
  check(
    'listing RECEIPTS — a name and a day — not pool totals',
    /receipts? (has|have) containers out/i.test(listed),
    listed.slice(0, 110),
  );
  check(
    'and saying which are on trust',
    /on trust|Holding/i.test(listed),
    'a deposit is not assumed',
  );

  // ══ Settling one, short ═══════════════════════════════════════════════════════════
  console.log('\n— a customer brings most of it back —');
  const before = await shop.rpc('empties_by_receipt', { p_store_id: storeId, p_customer_id: null, p_limit: 100 });
  const first = p.locator('[class*="empties-page_card"]').first();
  const who = (await first.innerText()).split('\n')[0];
  await first.click();
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${SHOTS}/2-settle-sheet.png` });

  const settle = await body();
  check('settling is a PAGE, not a sheet', /What came back\?/i.test(settle), settle.slice(0, 60));
  check(
    'with a back arrow, because it is a form that records money',
    (await p.getByRole('button', { name: 'Go back' }).count()) > 0,
  );
  check('it names the customer', settle.includes(who.split(' ')[0]), who);
  check('and shows what went out', /went out/i.test(settle));
  /*
   * Located by the row it belongs to, not by its label.
   *
   * `getByLabel(/^Back$/)` found nothing, and the field is plainly on screen in the screenshot —
   * so the probe was asserting something about label wiring while claiming to assert something
   * about the settle flow. Targeting the quantity box inside the pool row asks the question this
   * test is actually about.
   */
  const backBox = p.locator('[class*="qtyBox"] input').first();
  check('with a box for what came back', (await backBox.count()) > 0);

  /*
   * Measured as a CHANGE, not as an absolute.
   *
   * Pushed-under pages stay mounted and Playwright counts them as visible — that is what a stack
   * is — so "no warnings on screen" was really asking about the till two pages down. The claim
   * worth making is that entering a partial return does not PRODUCE a warning, and a before/after
   * count says exactly that whatever else happens to be behind.
   */
  const warningsBefore = await p.locator('[role="alert"]:visible').count();
  await backBox.fill('2');
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${SHOTS}/3-partial.png` });
  const warningsAfter = await p.locator('[role="alert"]:visible').count();

  const stillOut = /Still out after this/i.test(await body());
  check(
    'a PARTIAL return is arithmetic, not an error',
    stillOut && warningsAfter === warningsBefore,
    stillOut
      ? `warnings ${warningsBefore} → ${warningsAfter}`
      : 'no running figure shown',
  );

  const record = p.getByRole('button', { name: /Record it/i }).first();
  check('and it can be recorded', await record.isEnabled());
  const idsBefore = await ledgerIds();
  await record.click();
  await p.waitForTimeout(6000);
  await p.screenshot({ path: `${SHOTS}/4-after.png` });

  // Everything that appeared while the probe was driving is the probe's to undo.
  for (const id of await ledgerIds()) if (!idsBefore.has(id)) caused.push(id);

  // ══ The figure moved ══════════════════════════════════════════════════════════════
  console.log('\n— and the figure moves —');
  const after = await shop.rpc('empties_by_receipt', { p_store_id: storeId, p_customer_id: null, p_limit: 100 });
  const b = (before.data ?? []).reduce((t, r) => t + Number(r.outstanding_units), 0);
  const a = (after.data ?? []).reduce((t, r) => t + Number(r.outstanding_units), 0);
  check('two fewer units are out than before', a === b - 2, `${b} → ${a}`);

  const shown = await body();
  check('the page is showing the new position, not a spinner', /Empties out/i.test(shown), shown.slice(0, 70));

  // ══ Reachable from a receipt too ══════════════════════════════════════════════════
  console.log('\n— and from a receipt —');
  /*
   * Reached the way the till reaches it, rather than through the Money tab.
   *
   * The sales list is registered on the SELL stack precisely so a seller does not have to leave the
   * counter, and that is the journey worth testing.
   */
  await tab('Sell');
  await p.getByRole('button', { name: /All sales and receipts/i }).first().click();
  await p.waitForTimeout(4500);
  const sale = p.locator('[class*="sales-page_row"]').first();
  if (await sale.count()) {
    await sale.click();
    await p.waitForTimeout(4500);
    const fromReceipt = p.getByRole('button', { name: /Containers still to come back/i }).first();
    check('a receipt offers it as well', (await fromReceipt.count()) > 0, await body().then((t) => t.slice(0, 70)));
    await p.screenshot({ path: `${SHOTS}/5-receipt-entry.png` });
  } else {
    check('a receipt offers it as well', false, 'no sale row found to open');
  }


  // ══ A product says what it has out ════════════════════════════════════════════════
  console.log('\n— and a product knows what is out in customers’ yards —');
  await tab('Stock');
  const returnable = p
    .locator('[class*="stock-page_itemName"]')
    .filter({ hasText: /Star|Gulder|Trophy/ })
    .first();
  if (await returnable.count()) {
    await returnable.scrollIntoViewIfNeeded();
    await returnable.click();
    await p.waitForTimeout(4500);
    await p.screenshot({ path: `${SHOTS}/6-product-empties.png` });
    const prod = await body();
    check('the item shows its containers out', /Containers out/i.test(prod), prod.slice(0, 80));
    check(
      'said in pools, and honest about it being shared',
      /shares these pools|Across every product/i.test(prod),
    );
  } else {
    check('the item shows its containers out', false, 'no returnable product found in the list');
  }

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  try {
    const out = execFileSync('python', ['scripts/clean-probe-rows.py', ...caused], {
      encoding: 'utf8',
    });
    console.log('\n  cleaned:', out.trim());
  } catch (e) {
    console.log('\n  CLEANUP FAILED:', String(e).slice(0, 120));
    failed += 1;
  }
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
