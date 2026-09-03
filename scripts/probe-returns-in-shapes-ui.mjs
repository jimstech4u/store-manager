/**
 * The settle screen counts in shapes and asks where the missing ones went.
 *
 * `probe-what-did-not-come-back` proves the database. This proves a shop can reach it, and READ-ONLY:
 * it fills the boxes, checks what the screen says back, and leaves without saving. Settling writes
 * to append-only ledgers, and a probe that cannot undo what it did has no business pressing the
 * button when reading the screen is the claim.
 *
 * What it checks is the arithmetic a seller would otherwise do standing up: a box per shape rather
 * than one box in the pool's smallest unit, the multiplication said back, and — the part that had
 * nowhere to go at all — a question about the ones that are not coming back.
 *
 *     node scripts/probe-returns-in-shapes-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/returns-ui';
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
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const { data: receipts } = await shop.rpc('empties_by_receipt', {
  p_store_id: storeId,
  p_customer_id: null,
  p_limit: 20,
});
const subject = (receipts ?? []).find((r) => Number(r.outstanding_units) > 1);
if (!subject) {
  console.log('  SKIP  nothing is out in this shop to settle');
  process.exit(0);
}

/*
 * A pool that declares its shapes is what makes this worth clicking.
 *
 * With none declared the screen keeps ONE free box — right, because a shop that never said "whole
 * crates only" has not said anything — and there is no per-shape counting to look at. The probe
 * supplies the shapes rather than writing them to the shop, so it can check the screen without
 * changing a rule somebody relies on.
 */
const pool = subject.expected[0];
const { data: declared } = await shop.rpc('return_units_for', { p_category_id: pool.category_id });
const supplied =
  (declared ?? []).length > 0
    ? declared
    : [
        { id: '11111111-1111-1111-1111-111111111111', name: 'Crate', base_qty: 12 },
        { id: '22222222-2222-2222-2222-222222222222', name: 'Bottle', base_qty: 1 },
      ];

console.log(`\n  ${subject.customer_name} — ${subject.outstanding_units} ${pool.category} out`);
console.log(
  `  comes back in: ${supplied.map((u) => `${u.name} of ${u.base_qty}`).join(', ')}${
    (declared ?? []).length > 0 ? '' : ' (supplied — this pool declares none)'
  }\n`,
);

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

if ((declared ?? []).length === 0) {
  await p.route('**/rest/v1/rpc/return_units_for', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(supplied),
    });
  });
}

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  console.log('— getting to what is out —');
  await p.locator('.nav-item').filter({ hasText: /^Sell$/ }).first().click();
  await p.waitForTimeout(3500);

  const entry = p.getByRole('button', { name: /Containers still to come back/i }).first();
  check('the till offers what is still out', (await entry.count()) > 0);
  await entry.click();
  await p.waitForTimeout(4500);

  const card = p.locator('[class*="empties-page_card"]').first();
  await card.click();
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `${SHOTS}/1-settle.png` });

  const opened = await body();
  check('the settle page opens', /What came back/i.test(opened), opened.slice(0, 60));

  // ══ A box per shape ═══════════════════════════════════════════════════════════════
  console.log('\n— counted the way a shop counts —');
  const boxes = p.locator('[class*="shapeBoxes"] input');
  const n = await boxes.count();
  check(
    'there is a box for each shape, not one for the whole pool',
    n >= supplied.length,
    `${n} box(es) for ${supplied.length} shape(s)`,
  );

  const big = supplied.reduce((a, b) => (Number(a.base_qty) >= Number(b.base_qty) ? a : b));
  const small = supplied.reduce((a, b) => (Number(a.base_qty) <= Number(b.base_qty) ? a : b));
  const labels = await p.locator('[class*="shapeBoxes"] label').allInnerTexts();
  check(
    'and each is named after its shape',
    labels.some((l) => l.toLowerCase().includes(big.name.toLowerCase())),
    labels.join(', ').slice(0, 60),
  );

  /*
   * Aim three SHORT, in whole shapes plus a remainder.
   *
   * A first version aimed at "one crate and three bottles" without checking it fitted: against
   * twelve outstanding that is fifteen, so the shortfall section never appeared and the probe
   * reported SKIP on the thing it exists to test.
   */
  const OUT = Number(subject.outstanding_units);
  const target = Math.max(1, OUT - 3);
  const crates = Math.floor(target / Number(big.base_qty));
  const loose = target - crates * Number(big.base_qty);
  const counted = crates * Number(big.base_qty) + loose;

  if (crates > 0) await boxes.nth(0).fill(String(crates));
  if (n > 1 && loose > 0) await boxes.nth(1).fill(String(loose));
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${SHOTS}/2-counted.png` });

  const said = await body();
  check(
    'the multiplication is said back, not left to the seller',
    new RegExp(`That is ${counted} of`).test(said),
    (said.match(/That is \d+ of \d+ back/) ?? ['it was not'])[0],
  );
  console.log(
    `      ${crates} × ${big.name}${loose ? ` + ${loose} ${small.name}` : ''} = ${counted} of ${OUT}`,
  );

  // ══ And the ones that are not coming back ═════════════════════════════════════════
  console.log('\n— where are the others? —');
  const short = OUT - counted;
  if (short > 0) {
    const asked = await body();
    check(
      'the screen asks, rather than warning',
      new RegExp(`${short} did not come back`).test(asked),
      (asked.match(/\d+ did not come back[^?]*\?/) ?? ['it did not ask'])[0],
    );
    check(
      'and says that leaving it alone means they are still owed',
      /still owed/i.test(asked),
      'short is the normal case, not a fault',
    );

    const goneBox = p.locator('input').filter({ hasNot: p.locator('[readonly]') });
    const notComing = p.getByLabel(/not coming back/i).first();
    check('there is somewhere to say they are gone', (await notComing.count()) > 0);
    if ((await notComing.count()) > 0) {
      await notComing.fill(String(short));
      await p.waitForTimeout(2500);
      await p.screenshot({ path: `${SHOTS}/3-gone.png` });

      const paidField = p.getByLabel(/Paid for them/i).first();
      check(
        'and only then is the money asked for',
        (await paidField.count()) > 0,
        'a money box before anything is written off is a question with no subject',
      );
      if ((await paidField.count()) > 0) {
        await paidField.fill('750');
        await p.waitForTimeout(2000);
        const withMoney = await body();
        check(
          'which says it is not paying down what they owe',
          /not against what they owe/i.test(withMoney),
          (withMoney.match(/Recorded against[^.]{0,45}/) ?? ['no such note'])[0],
        );
      }
    }
    void goneBox;
  } else {
    console.log('  SKIP  the count came out exact, so nothing is missing to ask about');
  }

  // ══ More than they owe ════════════════════════════════════════════════════════════
  //
  // Found by this probe overshooting on its first run: the screen said "That is 15 of 12 back" and
  // "Still out after this: -3" without a word, and only the server would have refused it — after
  // the button, with the bottles already counted onto the counter.
  console.log('\n— and more than they owe —');
  await boxes.nth(0).fill(String(Number(big.base_qty) > 1 ? OUT : OUT + 5));
  if (n > 1) await boxes.nth(1).fill(String(OUT));
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${SHOTS}/5-over.png` });

  const over = await body();
  check(
    'it says so before the button, not after the server refuses',
    /more than this receipt has out/i.test(over),
    (over.match(/more than this receipt has out/i) ?? ['it did not'])[0],
  );
  const save = p.getByRole('button', { name: /Record|Save|Settle/i }).last();
  check(
    'and the button will not offer to do it',
    (await save.count()) === 0 || (await save.isDisabled()),
    'a wrong count must not be one tap from the ledger',
  );

  await p.screenshot({ path: `${SHOTS}/4-final.png` });
  check('no page errors along the way', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  // Nothing to undo: this probe never pressed the button.
  console.log('\n  ok  read-only — nothing was settled');
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
