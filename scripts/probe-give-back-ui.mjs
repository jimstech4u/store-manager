/**
 * GIVING A CUSTOMER'S OWN EMPTIES BACK, AND MONEY OWED BACK — from their account.
 *
 * "I have returned Arewa's Nigerian Breweries crate but I could not clear it." "In the empties page,
 * a button to return some back, to its page. On the customer page remove the statement card and
 * make it return money we owe them."
 *
 * Arewa: the account shows Return money (not Statement); Their empties opens the empties page, where
 * her NBL crate in our yard has "Given back" (asked first) and "Give some of theirs back" opens the
 * counting page on her side. Every writer is answered by the probe, so nothing is recorded.
 *
 *     node scripts/probe-give-back-ui.mjs [http://localhost:3100]
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
for (const fn of ['record_customer_empties', 'record_customer_empties_for_group', 'write_off_customer_empties', 'record_money_back']) {
  await p.route(`**/rest/v1/rpc/${fn}*`, (route) => {
    sent.push({ fn, body: JSON.parse(route.request().postData() ?? '{}') });
    return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
}

const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const text = async () => ((await top().innerText()) ?? '').replace(/\s+/g, ' ');

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(8000);

  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /everyone you sell to/i }).locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  const row = p.getByRole('button', { name: /Arewa/ }).locator('visible=true').first();
  await row.waitFor({ state: 'visible', timeout: 60000 });
  await row.click();
  await p.waitForTimeout(6000);

  let t = await text();
  check('the account offers Return money', /Return money/.test(t));
  check('and no Statement card', !/Every receipt, and what is open/.test(t));

  await top().getByRole('button', { name: /Their empties/ }).first().click();
  await p.waitForTimeout(5000);
  t = await text();
  check('her NBL crate is listed as hers, in our yard', /Theirs, in your yard.*Nigerian Breweries crate/.test(t),
    (t.match(/Theirs, in your yard.{0,80}/) ?? [''])[0]);

  await top().getByRole('button', { name: 'Given back', exact: true }).first().click();
  await p.waitForTimeout(1200);
  check('Given back asks first', /Gave back 1 Nigerian Breweries crate\?/.test(await p.locator('body').innerText()));
  await p.getByRole('button', { name: /Yes, given back/ }).click();
  await p.waitForTimeout(2500);
  const give = sent.find((s) => s.fn === 'record_customer_empties_for_group');
  check('it is recorded as her maker crate coming off our side',
    give && give.body.p_direction === 'returned' && give.body.p_side === 'we_hold' && Number(give.body.p_qty) === 1,
    JSON.stringify(give?.body ?? sent));

  await top().getByRole('button', { name: /Give some of theirs back/ }).first().click();
  await p.waitForTimeout(5000);
  t = await text();
  check('Give some of theirs back opens the counting page on her side', /Given back to them/.test(t) && /Nigerian Breweries/.test(t),
    t.slice(0, 160));
  await p.screenshot({ path: `${SHOTS}/give-back.png`, fullPage: true });
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/give-back-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
