/**
 * THE COUNT GATE IS THE SHOP'S TO SET.
 *
 * "Users decide how the count gate works: aggressive (now) or relaxed (the days they pick, like an
 * alarm's Repeat); and on Running low, count when low — the shop's box, and each item's own." Ashabi
 * is set Relaxed, Monday and Sunday (0251); today being neither, the till sells with no count asked.
 * Every settings write is answered by the probe, so the shop's own settings are not touched.
 *
 *     node scripts/probe-count-gate-settings-ui.mjs [http://localhost:3100]
 */
import { chromium, webkit } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad';
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
const sent = [];
for (const fn of ['set_count_gate', 'set_count_when_low', 'set_product_count_when_low']) {
  await p.route(`**/rest/v1/rpc/${fn}*`, (route) => {
    sent.push({ fn, body: JSON.parse(route.request().postData() ?? '{}') });
    return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
}
const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const text = async () => ((await top().innerText()) ?? '').replace(/\s+/g, ' ');
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
  await p.waitForTimeout(8000);

  // ── Settings → Count gate ──────────────────────────────────────────────────────────────
  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(2500);
  await top().getByRole('button', { name: /^Count gate$/ }).click();
  await p.waitForTimeout(4000);
  let t = await text();
  check('Count gate shows the two ways, Relaxed chosen',
    (await top().getByRole('radio', { name: /Relaxed/ }).getAttribute('aria-checked')) === 'true' && /Aggressive/.test(t));
  check('its Repeat says Monday and Sunday', /Repeat\s*Every Monday and Sunday/.test(t), (t.match(/Repeat.{0,40}/) ?? [''])[0]);
  check('and today (Thursday) is not a count day', /Today is not a count day/.test(t));
  await p.screenshot({ path: `${SHOTS}/count-gate-settings.png`, fullPage: true });

  await top().getByRole('button', { name: /^Repeat/ }).click();
  await p.waitForTimeout(3000);
  t = await text();
  check('Repeat lists every day, Monday to Sunday', /Every Monday.*Every Tuesday.*Every Wednesday.*Every Thursday.*Every Friday.*Every Saturday.*Every Sunday/.test(t));
  const ticked = await top().locator('[role="checkbox"][aria-checked="true"]').allInnerTexts();
  check('with Monday and Sunday ticked', ticked.map((x) => x.trim()).join(',') === 'Every Monday,Every Sunday', ticked.join(','));
  await p.screenshot({ path: `${SHOTS}/count-days.png`, fullPage: true });
  await top().getByRole('checkbox', { name: /Every Friday/ }).click();
  await p.waitForTimeout(1500);
  const gateCall = sent.find((s) => s.fn === 'set_count_gate');
  check('ticking Friday saves relaxed: Monday, Friday, Sunday',
    gateCall && gateCall.body.p_mode === 'relaxed' && JSON.stringify(gateCall.body.p_days) === '[1,5,7]', JSON.stringify(gateCall?.body));
  await p.goBack(); await p.waitForTimeout(1500);
  await p.goBack(); await p.waitForTimeout(2000);

  // ── Running low: the shop's box ────────────────────────────────────────────────────────
  await top().getByRole('button', { name: /When to be told stock is running out/ }).click();
  await p.waitForTimeout(4000);
  const shopBox = top().getByRole('checkbox', { name: /Count an item when it runs low/ });
  check('Running low has the shop’s "count when low", off', (await shopBox.count()) === 1 && !(await shopBox.isChecked()));
  await shopBox.click(); // the save is answered by the probe, so the box re-reads "off" — what counts is what was sent
  await p.waitForTimeout(1500);
  const lowCall = sent.find((s) => s.fn === 'set_count_when_low');
  check('ticking it saves the shop’s say', lowCall && lowCall.body.p_on === true, JSON.stringify(lowCall?.body));

  // ── An item's own say, following the shop ─────────────────────────────────────────────
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(3000);
  await p.getByRole('button', { name: /Search your stock/ }).locator('visible=true').first().click();
  await p.waitForTimeout(1500);
  await p.keyboard.type('Goldberg');
  await p.waitForTimeout(3000);
  await p.locator('.react-modal-sheet-container').getByText(/Goldberg Bottle/).locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  t = await text();
  const itemBox = top().getByRole('checkbox', { name: /Count it when it runs low/ });
  check('an item has its own "count when low", following the shop', (await itemBox.count()) === 1 && /Following the shop \(off\)/.test(t),
    (t.match(/Count it when it runs low.{0,60}/) ?? [''])[0]);
  await itemBox.click();
  await p.waitForTimeout(1500);
  const itemCall = sent.find((s) => s.fn === 'set_product_count_when_low');
  check('ticking it gives the item its own say', itemCall && itemCall.body.p_on === true, JSON.stringify(itemCall?.body));

  // ── The till, on a day that is not a count day ────────────────────────────────────────
  await p.locator('.nav-item').filter({ hasText: /^Sell$/ }).first().click();
  await p.waitForTimeout(3000);
  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  await plus.scrollIntoViewIfNeeded();
  await plus.click();
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(2000);
  await pickInSheet('Goldberg', /Goldberg Bottle \(600mL\)/);
  await p.waitForTimeout(3000);
  await p.getByRole('button', { name: /One more Goldberg/ }).first().click();
  await p.waitForTimeout(5000);
  t = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('the till asks for no count today', !/have not been counted today|has not been counted today|Count them now/.test(t),
    (t.match(/.{0,40}counted today.{0,40}/) ?? ['none'])[0]);
  await p.getByRole('button', { name: /Take payment/ }).first().click();
  await p.waitForTimeout(5000);
  t = await text();
  check('Take payment opens without sending you to count', /Recording for|How are they paying/.test(t) && !/Count before selling|count gate/i.test(t), t.slice(0, 100));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/count-gate-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
