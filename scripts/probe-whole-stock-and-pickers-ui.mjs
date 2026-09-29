/**
 * WHOLE STOCK, AND PICKERS THAT REACH EVERYTHING — clicked through.
 *
 *  1. The product picker pages past 50 (0223) and never says "Nothing found" while it is still
 *     looking.
 *  2. Malta Guinness Can re-said (0222): its edit form reads 133 cans and 12 pieces, offers no ½,
 *     and a typed "5.5" stays whole.
 *
 * Looks only. Nothing is saved; any draft the till opens is taken back.
 *
 *     node scripts/probe-whole-stock-and-pickers-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { trackDrafts } from './probe-drafts.mjs';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/whole-stock';
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

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const startedAt = new Date().toISOString();

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
// Only the tabs THIS browser saves are ever cleaned up — never the shop's own (see probe-drafts).
const PROBE_DRAFTS = trackDrafts(p);
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

/** Product rows in the open picker. */
const rows = () =>
  p.evaluate(() => {
    const c = [...document.querySelectorAll('.selection-viewer-content')].find(
      (el) => el.getBoundingClientRect().height > 0,
    );
    return c ? c.querySelectorAll('[class*="item"]').length : -1;
  });

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  console.log('\n— the product picker —');
  const addItem = p.getByRole('button', { name: /Add an item/i }).first();
  await addItem.waitFor({ state: 'visible', timeout: 120000 });
  await addItem.click();
  await p.waitForTimeout(6000);
  const first = await rows();
  check('opens on the first page', first >= 50, `${first} rows`);

  for (let i = 0; i < 20; i += 1) {
    await p.evaluate(() => {
      const c = [...document.querySelectorAll('.selection-viewer-content')].find(
        (el) => el.getBoundingClientRect().height > 0,
      );
      // The SHEET's scroller, which is what a finger moves — the content box itself never scrolls.
      const sc = c?.closest('.react-modal-sheet-content-scroller') ?? c;
      if (sc) sc.scrollTop = sc.scrollHeight;
    });
    await p.waitForTimeout(1500);
  }
  const all = await rows();
  const { count: active } = await admin
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', '7138327c-c81c-4486-a97c-92207b48b64e')
    .eq('status', 'active');
  check('scrolling reaches every item', all >= active, `${all} of ${active}`);
  await p.screenshot({ path: `${SHOTS}/1-picker-end.png` });

  /*
   * THE FLASH. Watched every 30ms from the keystroke until the result is on screen: "Nothing found"
   * must never appear on the way to a term that does match.
   */
  const search = p.locator('[role="dialog"] input').first();
  const watch = p.evaluate(
    () =>
      new Promise((resolve) => {
        let flashed = false;
        const started = Date.now();
        const t = setInterval(() => {
          const txt = document.body.innerText;
          if (/Nothing found/.test(txt)) flashed = true;
          if (/Goldberg Bottle/.test(txt) && Date.now() - started > 400) {
            clearInterval(t);
            resolve({ flashed, ms: Date.now() - started });
          }
          if (Date.now() - started > 15000) {
            clearInterval(t);
            resolve({ flashed, ms: -1 });
          }
        }, 30);
      }),
  );
  await search.fill('Goldb');
  const seen = await watch;
  check('a matching search never flashes "Nothing found"', !seen.flashed, `result in ${seen.ms}ms`);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(1500);

  console.log('\n— Malta Guinness Can, edited —');
  await p.goto(`${BASE}/main`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: 'Stock', exact: true }).first().click();
  await p.waitForTimeout(4000);
  const hunt = p.getByText(/Malta Guinness Can/i).first();
  for (let i = 0; i < 40 && (await hunt.count()) === 0; i += 1) {
    await p.evaluate(() => {
      const col = [...document.querySelectorAll('.navstack-column-body')].find(
        (el) => el.getBoundingClientRect().height > 0,
      );
      if (col) col.scrollTop += 900;
    });
    await p.waitForTimeout(400);
  }
  await hunt.click();
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: /Edit this item|Edit/i }).first().click();
  await p.waitForTimeout(6000);

  const cans = p.getByRole('textbox', { name: /^Cans/ }).first();
  const pieces = p.getByRole('textbox', { name: /^Pieces/ }).first();
  await cans.scrollIntoViewIfNeeded().catch(() => {});
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${SHOTS}/2-malta-edit.png` });
  check('the Cans box reads 133', (await cans.count()) > 0 && (await cans.inputValue()) === '133',
    (await cans.count()) ? `"${await cans.inputValue()}"` : 'no Cans box');
  check('the Pieces box reads 12', (await pieces.count()) > 0 && (await pieces.inputValue()) === '12',
    (await pieces.count()) ? `"${await pieces.inputValue()}"` : 'no Pieces box');
  check('no ½ button on the shelf boxes', (await p.getByRole('button', { name: '½', exact: true }).count()) === 0);

  if (await cans.count()) {
    // Pasted, the way a figure with a point can arrive at all: a whole-number keypad has no point.
    await cans.fill('5.5');
    await p.waitForTimeout(500);
    check('a typed 5.5 stays whole', (await cans.inputValue()) === '5', `"${await cans.inputValue()}"`);
  }

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await p.screenshot({ path: `${SHOTS}/last.png`, fullPage: true }).catch(() => {});
  await browser.close();
  const { data: mine } = await admin
    .from('draft_orders').select('id').eq('status', 'open').in('client_uuid', [...PROBE_DRAFTS]);
  const ids = (mine ?? []).map((d) => d.id);
  if (ids.length) {
    await admin.from('draft_order_lines').delete().in('draft_order_id', ids);
    await admin.from('draft_orders').delete().in('id', ids);
    console.log(`  (took ${ids.length} probe draft(s) back off the till)`);
  }
  console.log(`\n  shots in ${SHOTS}`);
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
