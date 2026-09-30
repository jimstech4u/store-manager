/**
 * MONEY IS A LEDGER, LIKE EMPTIES AND DEPOSIT.
 *
 * "Too many buttons here — adopt payment and charge as a ledger just like empties and deposit, with a
 * button to record what was returned, or more of it ... and each can have its history as empties and
 * deposit have theirs."
 *
 * Arewa's account shows three cards (Money, Empties, Deposit) and none of the old money cards; Money
 * opens a page with who owes whom, a button for each money record, the statement link and the money
 * history; Record a payment opens the payment form. Nothing is saved.
 *
 *     node scripts/probe-money-ledger-ui.mjs [http://localhost:3100]
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
  // Every receipt and what is open on it — what the Statement page showed (Q55).
  check('the account lists her receipts, with what is open on each', /Receipts/.test(t) && /(open|Paid)/.test((t.split('Receipts')[1] ?? '').slice(0, 200)),
    (t.split('Receipts')[1] ?? '').slice(0, 120));
  // From the account, the Deposit page has no shortcut back up to it.
  await top().getByRole('button', { name: /^Deposit/ }).first().evaluate((el) => el.click());
  await p.waitForTimeout(4000);
  check('Deposit opened from the account has no shortcut back to it', (await top().getByRole('button', { name: 'Their account' }).count()) === 0);
  await p.goBack();
  await p.waitForTimeout(3000);
  t = await text();
  const cards = (t.match(/On this account(.*?)Everything that has happened/) ?? ['', ''])[1];
  check('the account has Money, Empties and Deposit', /Money/.test(cards) && /Empties/.test(cards) && /Deposit/.test(cards), cards.slice(0, 160));
  check('and none of the old money cards',
    !/Record a payment|Record a charge|Return money|You owe them|Statement/.test(cards), cards.slice(0, 160));

  await top().getByRole('button', { name: /^Money/ }).first().click();
  await p.waitForTimeout(4000);
  t = await text();
  check('Money opens its own page', /Money/.test(t) && /(They owe you|You owe them|Nothing owed either way)/.test(t), t.slice(0, 120));
  for (const b of ['Record a payment', 'Record a charge', 'Return money to them', 'Record what you owe them']) {
    check(`it offers ${b}`, (await top().getByRole('button', { name: new RegExp(b.replace(/[()]/g, '.')) }).count()) > 0);
  }
  // The statement is the account now (Q55): no link to it, and no shortcut back up — Back is the way.
  check('no statement link and no shortcut to the account', !/Every receipt, and what is open/.test(t) &&
    (await top().getByRole('button', { name: 'Their account' }).count()) === 0);
  check('with the money history under it', /Every move of it/.test(t) && /Sale|Payment|Receipt/i.test(t.split('Every move of it')[1] ?? ''),
    (t.split('Every move of it')[1] ?? '').slice(0, 120));
  await p.screenshot({ path: `${SHOTS}/money-ledger.png`, fullPage: true });

  await top().getByRole('button', { name: /^Record a payment$/ }).click();
  await p.waitForTimeout(4000);
  t = await text();
  check('Record a payment opens the payment form', /Money they gave you|Record a payment|How much/i.test(t), t.slice(0, 120));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/money-ledger-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
