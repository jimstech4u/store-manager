/**
 * Nothing makes the shop leave what it is doing.
 *
 * Five things that were asked for together, because they are one complaint: a screen that stops
 * and sends you somewhere else. An item missing from a delivery, an item missing from a count, a
 * warning that fills the stock screen and cannot be silenced, an add button that does not look
 * like the thing that adds, a rebate box welded to the fee above it.
 *
 *     node scripts/probe-mid-additions.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/mid-add';
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const stamp = Date.now().toString().slice(-6);
const MADE = [];

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

/*
 * Back to the top of whatever is scrolling, THEN tap.
 *
 * A wheel event at the middle of the screen does not always reach the pane that is actually
 * scrolling — this app scrolls an inner container, not the document — and a tab tapped while that
 * pane is part-way through a smooth scroll fails as "outside the viewport" perhaps one run in
 * three. Setting scrollTop directly has no animation to race.
 */
const tab = async (label) => {
  await p.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll('div')) {
      if (el.scrollHeight > el.clientHeight + 40) el.scrollTop = 0;
    }
  });
  await p.waitForTimeout(900);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(4000);
};

const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

/** Serial, group and nav of the entry we are standing on — for tracing a navigation fault. */
const whereAmI = async () =>
  p.evaluate(() => {
    const u = new URL(window.location.href);
    return `serial=${window.history.state?.axSerial ?? 'none'} group=${u.searchParams.get('group')} hash=${window.location.hash || 'none'} nav=${u.searchParams.get('nav')}`;
  });

/*
 * "Is it green" asked of the pixel, against the shop's own token.
 *
 * A first attempt tested the channels — more green than red and blue — and failed every primary
 * button on the site, because the shop's green is a deep teal (#0b6252) whose blue channel is
 * higher than its green. The question is not "is this greenish", it is "is this THE fill the
 * primary button uses", so the token answers it.
 */
const isPrimary = async (locator) => {
  const [bg, primary] = await locator.evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--primary)';
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(el).backgroundColor, resolved];
  });
  const norm = (c) => (c.match(/\d+/g) ?? []).slice(0, 3).join(',');
  return norm(bg) === norm(primary);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  // The dev server compiles this route on first hit, which can outlast a fixed wait.
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ══ 1. The till offers both ways on, on the page ══════════════════════════════════
  console.log('\n— the till: add and scan side by side, on the page —');
  await tab('Sell');
  await p.waitForTimeout(2000);
  const addItem = p.getByRole('button', { name: /^Add an item$/ }).first();
  const scanBtn = p.getByRole('button', { name: /Scan a barcode/i }).first();
  check('"Add an item" is on the page', (await addItem.count()) > 0);
  check('and so is scanning, without opening the picker', (await scanBtn.count()) > 0);
  check('"Add an item" is green', await isPrimary(addItem));
  await p.screenshot({ path: `${SHOTS}/1-till.png` });

  await addItem.click();
  await p.waitForTimeout(2500);
  const addNew = p.getByRole('button', { name: /Add something new|^Add "/ }).first();
  check(
    'the picker offers adding BEFORE you fail to find anything',
    (await addNew.count()) > 0,
    await body().then((t) => t.slice(0, 80)),
  );
  await p.screenshot({ path: `${SHOTS}/2-picker.png` });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(1500);

  // ══ 2. A delivery can invent the item it is receiving ═════════════════════════════
  console.log('\n— a delivery does not send you to Stock —');
  await tab('Stock');
  const receive = p.getByRole('button', { name: /Record a delivery|Receive/i }).first();
  await receive.click();
  await p.waitForTimeout(4000);

  const rAdd = p.getByRole('button', { name: /^Add an item$/ }).first();
  check('the delivery offers "Add an item" in green', await isPrimary(rAdd));
  await rAdd.click();
  await p.waitForTimeout(2500);

  const NAME = `ZZ Mid ${stamp}`;
  const search = p.getByPlaceholder(/Search/i).first();
  await search.fill(NAME);
  await p.waitForTimeout(2500);
  const rAddNew = p.getByRole('button', { name: new RegExp(`Add "${NAME}"`) }).first();
  check(
    'and adding what was typed, rather than "add it under Stock first"',
    (await rAddNew.count()) > 0,
  );
  await p.screenshot({ path: `${SHOTS}/3-delivery-picker.png` });

  if (await rAddNew.count()) {
    await rAddNew.click();
    await p.waitForTimeout(2500);
    await p.getByLabel(/What are you selling it in/i).fill('Bag');
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${SHOTS}/4-quick-add.png` });
    const confirm = p.getByRole('button', { name: /Add to this delivery/i }).first();
    check('the sheet says what it is adding TO', (await confirm.count()) > 0);
    await confirm.click();
    await p.waitForTimeout(6000);
    await p.screenshot({ path: `${SHOTS}/5-delivery-line.png` });

    check(
      'and the line lands on the delivery',
      (await body()).includes(NAME),
      (await body()).slice(0, 120),
    );

    const { data: made } = await admin
      .from('products')
      .select('id, confirmed_at')
      .eq('name', NAME)
      .maybeSingle();
    check('the item exists', Boolean(made));
    /*
     * Signed off, because the owner is signed in and the owner may sign off.
     *
     * Not a weaker assertion than "it waits to be checked" — the opposite one, for the opposite
     * caller. `probe-staff-flow` signs in as a new seller and asserts the same item lands
     * UNCONFIRMED; asserting that here would be asserting the permission does nothing.
     */
    check('and an owner’s own item needs no checking', made ? Boolean(made.confirmed_at) : false);
    if (made) MADE.push(made.id);
  }

  // ══ 3. The rebate is not welded to the fee above it ═══════════════════════════════
  const rebate = p.getByLabel(/Rebate or discount/i).first();
  await rebate.scrollIntoViewIfNeeded();
  const gap = await rebate.evaluate((el) => {
    const block = el.closest('div[class*="rebate"]');
    if (!block) return -1;
    const cs = getComputedStyle(block);
    return parseFloat(cs.marginTop) + parseFloat(cs.paddingTop);
  });
  check('the rebate has room above it', gap >= 16, `${gap}px`);
  await p.screenshot({ path: `${SHOTS}/6-rebate.png` });

  // ══ 4. A count can invent the item it is looking at ═══════════════════════════════
  console.log('\n— a count does not send you to Stock either —');
  await tab('Count');
  const cAdd = p.getByRole('button', { name: /Something not on this list/i }).first();
  check('the count offers to add what is on the shelf', (await cAdd.count()) > 0);
  await p.screenshot({ path: `${SHOTS}/7-count.png` });

  if (await cAdd.count()) {
    await cAdd.click();
    await p.waitForTimeout(2000);
    const CNAME = `ZZ Counted ${stamp}`;
    await p.getByLabel(/What is it called/i).fill(CNAME);
    await p.getByLabel(/What are you selling it in/i).fill('Piece');
    await p.getByRole('button', { name: /Add and count it/i }).first().click();
    await p.waitForTimeout(6000);
    await p.screenshot({ path: `${SHOTS}/8-count-entry.png` });
    check(
      'and goes straight to counting it',
      (await body()).includes(CNAME),
      (await body()).slice(0, 120),
    );

    const { data: made } = await admin.from('products').select('id').eq('name', CNAME).maybeSingle();
    if (made) MADE.push(made.id);
  }

  // ══ 5. The stock warning folds, and can be put away and brought back ══════════════
  console.log('\n— a warning the shop can put away —');
  await tab('Stock');
  console.log('    after tap 1:', (await body()).slice(0, 45), '|', await whereAmI());
  /*
   * Tapped twice, because a tab returns you to where you left that stack.
   *
   * The delivery is still pushed under Stock, so one tap lands back on it. Tapping the tab you
   * are already on is the shop's own gesture for "take me to the top of this", which is the
   * screen this section is about.
   */
  await tab('Stock');
  /*
   * Tapped twice, because a tab returns you to where you left that stack.
   *
   * The delivery is still pushed under Stock, so one tap lands back on it; tapping the tab you
   * are already on is the shop's own gesture for "take me to the top of this".
   */
  await tab('Stock');
  await p.waitForTimeout(3500);
  console.log('    after tap 2:', (await body()).slice(0, 45), '|', await whereAmI());
  await p.screenshot({ path: `${SHOTS}/8b-stock.png` });
  const fold = p.locator('[class*="panelToggle"]:visible').first();
  check('the warning is a folded line, not an open paragraph', (await fold.count()) > 0);

  if (await fold.count()) {
    const before = await fold.evaluate((el) => el.getAttribute('aria-expanded'));
    check('folded by default', before === 'false', String(before));

    const panel = p.locator('[class*="panelFoldable"]:visible').first();
    const tall = await panel.evaluate((el) => el.getBoundingClientRect().height);
    check('so it is short', tall < 90, `${Math.round(tall)}px`);
    await p.screenshot({ path: `${SHOTS}/9-folded.png` });

    await fold.click();
    await p.waitForTimeout(700);
    const open = await fold.evaluate((el) => el.getAttribute('aria-expanded'));
    check('and it opens when asked', open === 'true', String(open));
    await p.screenshot({ path: `${SHOTS}/10-open.png` });

    const title = (await fold.innerText()).replace(/[+\u2212]\s*$/, '').trim();
    await p.getByRole('button', { name: /Stop showing me this/i }).first().click();
    await p.waitForTimeout(1200);
    check('"Stop showing this" removes it', !(await body()).includes(title), title);
    await p.screenshot({ path: `${SHOTS}/11-gone.png` });

    // ── and Settings gives it back ──────────────────────────────────────────────
    await tab('More');
    await p.waitForTimeout(2000);
    await p.mouse.wheel(0, 6000);
    await p.waitForTimeout(1200);
    const back = p.getByRole('button', { name: /^Show again$/ }).first();
    check(
      'Settings lists what was put away',
      (await back.count()) > 0,
      await body().then((t) => (t.includes('Warnings you turned off') ? 'listed' : t.slice(0, 90))),
    );
    await p.screenshot({ path: `${SHOTS}/12-settings.png` });

    if (await back.count()) {
      await back.click();
      await p.waitForTimeout(1200);
      await tab('Stock');
      await p.waitForTimeout(2500);
      check('and brings it back', (await body()).includes(title), title);
      await p.screenshot({ path: `${SHOTS}/13-restored.png` });
    }
  }

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  for (const id of MADE) {
    await admin.from('product_units').delete().eq('product_id', id);
    await admin.from('product_sale_units').delete().eq('product_id', id);
    const gone = await admin.from('products').delete().eq('id', id);
    if (gone.error) await admin.from('products').update({ status: 'archived' }).eq('id', id);
  }
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
