/**
 * A FINISHED ITEM IS NOT ADDED, AND ALL ITEMS ADDS, SAYS THE OLD EMPTIES APART, AND THE ACCOUNT.
 *
 * "When we want to sell an item that has 0, it does not get added: a dialog says it is finished,
 * they confirm physically, and they can count it and correct it as the count gate does (a button
 * goes there). A floating button to add more items in All items. Still with you should bring their
 * outstanding empties as well. And a checkbox to print the account, with a dropdown for which."
 *
 * The shelf is SUPPLIED, not changed: `get_product` is answered with nothing on hand for Goldberg,
 * so no stock moves. On the probe's own tab, with Mr Christian (who holds a Trophy crate and a
 * Goldberg crate from before):
 *   - the till refuses Goldberg with the dialog, and "Count it" opens Goldberg's own count;
 *   - a Trophy crate goes on; All items' Still with you prints what they had before, what this
 *     order sends out and the two together; the account box prints "Pay into" and the chosen
 *     account; the floating "Add an item" opens the picker, refuses Goldberg the same way, and takes
 *     Trophy to the till's own line page.
 * Nothing is settled; the probe's draft is taken back off the till at the end.
 *
 *     node scripts/probe-finished-item-ui.mjs [http://localhost:3100]
 */
import { chromium, webkit } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad';
const GOLDBERG = '2c38cae5-08a5-427d-8da0-226109c4f3b3';
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

const browser = await (process.env.ENGINE === 'webkit' ? webkit : chromium).launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const PROBE_DRAFTS = trackDrafts(p);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Goldberg's shelf, as the server would say it if it were empty. Every other item reads as it is.
let askedGoldberg = 0;
await p.route('**/rest/v1/rpc/get_product*', async (route) => {
  const body = JSON.parse(route.request().postData() ?? '{}');
  const res = await route.fetch();
  if (body.p_product_id !== GOLDBERG) return route.fulfill({ response: res });
  askedGoldberg += 1;
  const rows = await res.json();
  return route.fulfill({
    response: res,
    json: (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r, on_hand: '0' })),
  });
});

const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const text = async () => ((await top().innerText()) ?? '').replace(/\s+/g, ' ');
const body = async () => ((await p.locator('body').innerText()) ?? '').replace(/\s+/g, ' ');
const paper = async () =>
  ((await top().locator('[data-print-root]').first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
const box = (name) => top().getByRole('checkbox', { name });
const pickInSheet = async (term, match) => {
  const search = p.locator('[role="dialog"] input').first();
  await search.waitFor({ state: 'visible', timeout: 30000 });
  for (let i = 0; i < 4; i += 1) {
    await search.fill(term);
    await p.waitForTimeout(900);
    if ((await search.inputValue()) === term) break;
  }
  const hit = p.locator('[role="dialog"]').getByText(match).first();
  await hit.waitFor({ state: 'visible', timeout: 30000 });
  await hit.click();
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(10000);

  // Our own tab — never the shop's.
  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  await plus.scrollIntoViewIfNeeded();
  await plus.click();
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: /(Say|Change) who this sale is for/ }).locator('visible=true').first().click();
  await p.waitForTimeout(2500);
  await pickInSheet('Christian', /Mr Christian/);
  await p.waitForTimeout(4000);

  // ── The till: Goldberg is finished ──────────────────────────────────────────────────────
  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(2000);
  await pickInSheet('Goldberg', /Goldberg Bottle \(600mL\)/);
  await p.waitForTimeout(5000);
  let t = await body();
  check('the till asks the server, fresh', askedGoldberg > 0, `asked ${askedGoldberg}`);
  check('a dialog says Goldberg is finished', /Goldberg Bottle \(600mL\) is finished/.test(t) && /none left/.test(t),
    (t.match(/.{0,20}is finished.{0,80}/) ?? ['none'])[0]);
  check('and it was not added', (await p.getByRole('button', { name: /One more Goldberg/ }).count()) === 0);
  await p.screenshot({ path: `${SHOTS}/finished-dialog.png` });
  await p.getByRole('button', { name: /^Count it$/ }).click();
  await p.waitForTimeout(5000);
  t = await text();
  check('"Count it" opens Goldberg’s own count', /Goldberg/.test(t) && /count|shelf/i.test(t), t.slice(0, 120));
  await p.goBack();
  await p.waitForTimeout(3000);

  // ── A Trophy crate goes on ──────────────────────────────────────────────────────────────
  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(2000);
  await pickInSheet('Trophy Bottle', /Trophy Bottle \(600mL\)/);
  await p.waitForTimeout(5000);
  check('an item with stock goes on as before', (await p.getByRole('button', { name: /One more Trophy/ }).count()) > 0);
  await p.getByRole('button', { name: /One more Trophy/ }).first().click();
  await p.waitForTimeout(3000);

  // ── All items ───────────────────────────────────────────────────────────────────────────
  await p.getByRole('button', { name: /All items/ }).first().click();
  await p.waitForTimeout(6000);
  t = await paper();
  check('All items opens on the paper', /NOT A RECEIPT/.test(t) && /Trophy/.test(t), t.slice(0, 80));

  await box(/Still with you/).check();
  await p.waitForTimeout(5000);
  t = await paper();
  check('still with you says what they had before',
    /Had before this order/.test(t) && /Going out on this order/.test(t) && /Still with you in all/.test(t),
    (t.match(/Had before.{0,200}/) ?? [t.slice(-200)])[0]);

  const acct = box(/Account to pay into/);
  check('there is an account box', (await acct.count()) === 1);
  await acct.check();
  await p.waitForTimeout(1500);
  const select = top().getByRole('combobox', { name: 'Which account' });
  const options = await select.locator('option').allInnerTexts();
  check('ticking it opens a choice of account', (await select.count()) === 1 && options.length > 0, options.join(' | '));
  t = await paper();
  const first = options[0]?.split(' · ') ?? [];
  check('the paper says where to pay', /Pay into/.test(t) && first.every((part) => t.includes(part.trim())),
    (t.match(/Pay into.{0,80}/) ?? ['none'])[0]);
  if (options.length > 1) {
    await select.selectOption({ index: 1 });
    await p.waitForTimeout(800);
    const second = options[1].split(' · ')[1];
    check('choosing another account prints that one', (await paper()).includes(second), second);
  }
  await p.screenshot({ path: `${SHOTS}/all-items-account.png`, fullPage: true });

  // ── The floating "Add an item" ──────────────────────────────────────────────────────────
  const fab = top().getByRole('button', { name: /^Add an item$/ });
  check('All items has the floating "Add an item"', (await fab.count()) === 1);
  await fab.click();
  await p.waitForTimeout(2000);
  await pickInSheet('Goldberg', /Goldberg Bottle \(600mL\)/);
  await p.waitForTimeout(5000);
  t = await body();
  check('it refuses a finished item the same way', /Goldberg Bottle \(600mL\) is finished/.test(t));
  await p.getByRole('button', { name: /^Not now$/ }).click();
  await p.waitForTimeout(1500);
  check('"Not now" leaves All items as it was', /NOT A RECEIPT/.test(await paper()) && !/is finished/.test(await body()));

  await top().getByRole('button', { name: /^Add an item$/ }).click();
  await p.waitForTimeout(2000);
  await pickInSheet('Trophy Bottle', /Trophy Bottle \(600mL\)/);
  await p.waitForTimeout(6000);
  t = await text();
  check('an item with stock opens the till’s own line page', /Trophy/.test(t) && /(Add to|on the sale)/i.test(t), t.slice(0, 140));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/finished-item-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
