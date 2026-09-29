/**
 * THE HALF BUTTON, CLICKED THROUGH.
 *
 * The shop reported two things that turned out to be one: "all crates and can has halves too
 * selected and now any amount", and "the add part in sell page does not show when we set them in
 * stock product". Every shape was stored `whole_digit = false` - weighed, any amount at all - while
 * carrying `allow_half`, and `partsFor` returns no part-buttons for a weighed thing. So the product
 * form showed halves lit and the till offered none.
 *
 * 0204 corrects the rows and makes the server refuse the combination. This is the proof that a
 * seller can now see and tap a half: a typecheck cannot tell you a button is on a screen.
 *
 *     node scripts/probe-half-crate-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { trackDrafts } from './probe-drafts.mjs';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/half-crate';
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

/*
 * THIS RUNS AGAINST A REAL SHOP, so it takes its own receipts away again.
 *
 * Starting a customer at the till writes a draft, and a probe that leaves them behind puts
 * "Customer 2, 3, 4" on a working sell page — rubbish of mine on somebody's counter. Only drafts
 * opened after this probe started are touched, and only ones still open: a draft that became a
 * sale while this ran is the shop's, not the probe's.
 */
const startedAt = new Date().toISOString();
const sweep = async () => {
  const { data: mine } = await admin
    .from('draft_orders')
    .select('id')
    .eq('status', 'open')
    .in('client_uuid', [...PROBE_DRAFTS]);
  const ids = (mine ?? []).map((d) => d.id);
  if (ids.length === 0) return;
  await admin.from('draft_order_lines').delete().in('draft_order_id', ids);
  await admin.from('draft_orders').delete().in('id', ids);
  console.log(`  (took ${ids.length} probe draft(s) back off the till)`);
};

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
// Only the tabs THIS browser saves are ever cleaned up — never the shop's own (see probe-drafts).
const PROBE_DRAFTS = trackDrafts(p);
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);
  await p.screenshot({ path: `${SHOTS}/1-signed-in.png` });

  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  if (await plus.count()) {
    await plus.scrollIntoViewIfNeeded();
    await plus.click();
    await p.waitForTimeout(4000);
  }

  console.log('\n— a customer asks for half a crate of Goldberg —');
  /*
   * WAITED FOR, NOT TIMED. A dev server compiles this route on the first visit and can take the
   * better part of a minute; a fixed sleep either flakes or pads every later run to suit the worst
   * one. The button appearing is the thing being waited on, so that is what is said.
   */
  const addItem = p.getByRole('button', { name: /Add an item/i }).first();
  await addItem.waitFor({ state: 'visible', timeout: 120000 });
  await addItem.click();
  await p.waitForTimeout(2500);

  // Typed until it sticks: a just-opened picker re-renders and drops what was typed.
  const search = p.locator('[role="dialog"] input').first();
  for (let i = 0; i < 4; i += 1) {
    await search.fill('Goldberg');
    await p.waitForTimeout(900);
    if ((await search.inputValue()) === 'Goldberg') break;
  }
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${SHOTS}/2-picker.png` });

  const hit = p.locator('[role="dialog"]').getByText(/Goldberg Bottle/i).first();
  check('the crate product is findable at the till', (await hit.count()) > 0);
  await hit.click();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/3-line-added.png`, fullPage: true });

  /*
   * THE PART BUTTON ITSELF.
   *
   * Matched on the character the shop sees. `partsFor` labels a half "½", and it is the absence of
   * exactly this that was reported — so the check is for the glyph on the screen, not for a flag
   * in a payload that a screen may or may not honour.
   */
  const half = p.getByRole('button', { name: '½', exact: true });
  const count = await half.count();
  check('a half is offered on the line', count > 0, `${count} found`);

  if (count > 0) {
    await half.first().click();
    await p.waitForTimeout(2500);
    await p.screenshot({ path: `${SHOTS}/4-half-tapped.png`, fullPage: true });

    const qty = p.locator('input[inputmode="decimal"], input[type="number"]').first();
    const said = (await qty.count()) ? await qty.inputValue() : '';
    check('tapping it puts a half on the line', said === '0.5' || said === '.5', `box says "${said}"`);

    const body = await p.locator('body').innerText();
    check('and the receipt says it in halves, not 0.5',
      /1\/2|½/.test(body), 'looking for ½ or 1/2 on the line');
  }

  /*
   * AND NOT ANY AMOUNT AT ALL. A crate that accepts 0.43 has recorded something the shop cannot
   * hand over; that was the other half of the same bug, and it is what `whole_digit` now says.
   */
  const qty = p.locator('input[inputmode="decimal"], input[type="number"]').first();
  if (await qty.count()) {
    await qty.fill('0.43');
    await qty.blur();
    await p.waitForTimeout(2000);
    const after = await qty.inputValue();
    check('a quantity the shop cannot hand over does not stand',
      after !== '0.43', `0.43 became "${after}"`);
    await p.screenshot({ path: `${SHOTS}/5-snapped.png`, fullPage: true });
  }

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await p.screenshot({ path: `${SHOTS}/last.png`, fullPage: true }).catch(() => {});
  await browser.close();
  await sweep().catch((e) => console.log('  could not sweep the drafts:', e.message));
  console.log(`\n  shots in ${SHOTS}`);
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
