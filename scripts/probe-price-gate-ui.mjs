/**
 * THE PRICE GATE, CLICKED THROUGH.
 *
 * "Some product do not have price so we should block that as we did for count, which also push a
 * mid sale price list for items as count did."
 *
 * Puts an item the shop has never priced on a receipt and checks that the till says so on the line
 * and on the note, and that "Price it now" opens the price page with a box for that shape. It LOOKS
 * and saves nothing: setting a price here would change a real shop's catalogue.
 *
 *     node scripts/probe-price-gate-ui.mjs [http://localhost:3100] [item name]
 */

import { chromium } from '@playwright/test';
import { trackDrafts } from './probe-drafts.mjs';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const ITEM = process.argv[3] ?? 'Bigi Apple PET';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/price-gate';
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

// A real shop: only drafts this probe opened, and only ones still open, are taken back.
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

  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  if (await plus.count()) {
    await plus.scrollIntoViewIfNeeded();
    await plus.click();
    await p.waitForTimeout(4000);
  }

  console.log(`\n— ${ITEM}, which the shop has never priced, goes on a receipt —`);
  const addItem = p.getByRole('button', { name: /Add an item/i }).first();
  await addItem.waitFor({ state: 'visible', timeout: 120000 });
  await addItem.click();
  await p.waitForTimeout(2500);

  const search = p.locator('[role="dialog"] input').first();
  for (let i = 0; i < 4; i += 1) {
    await search.fill(ITEM);
    await p.waitForTimeout(900);
    if ((await search.inputValue()) === ITEM) break;
  }
  await p.waitForTimeout(3000);
  // The real item, with its size — never the picker's own "Add 'Bigi Apple PET'" row.
  const hit = p.locator('[role="dialog"]').getByText(/Bigi Apple PET \(350mL\)/i).first();
  await hit.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  check('the item is findable at the till', (await hit.count()) > 0);
  await hit.click();
  await p.waitForTimeout(5000);
  await p.screenshot({ path: `${SHOTS}/1-line-added.png`, fullPage: true });

  const chip = p.getByRole('button', { name: /No price yet · Set it/ });
  check('the line says it has no price', (await chip.count()) > 0);

  const body = await p.locator('body').innerText();
  check('the note says so above the lines', /has no price yet/.test(body));

  const pill = p.getByRole('button', { name: /first/i }).first();
  const pillText = (await pill.count()) ? await pill.innerText() : '';
  check(
    'the pay button refuses to take payment',
    /Count .* first|Price .* first/.test(pillText),
    `says "${pillText.replace(/\s+/g, ' ').trim()}"`,
  );

  const now = p.getByRole('button', { name: /Price it now/ }).first();
  await now.click();
  await p.waitForTimeout(5000);
  await p.screenshot({ path: `${SHOTS}/2-price-page.png`, fullPage: true });

  const page = await p.locator('body').innerText();
  check('the price page opens', /Price before selling/.test(page));
  check(
    'with a box for the shape being sold',
    new RegExp(`${ITEM}.*per `, 'i').test(page),
  );
  check('and the cost beside it', /One costs|Cost not recorded yet/.test(page));

  const save = p.getByRole('button', { name: /Nothing priced yet/ });
  check('nothing can be saved until a price is typed', (await save.count()) > 0);

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await p.screenshot({ path: `${SHOTS}/last.png`, fullPage: true }).catch(() => {});
  await browser.close();
  await sweep().catch((e) => console.log('  could not sweep the drafts:', e.message));
  console.log(`\n  shots in ${SHOTS}`);
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
