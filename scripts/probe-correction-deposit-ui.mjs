/**
 * A CORRECTION LOADS BACK THE WHOLE BREAKDOWN — the deposit included.
 *
 * "Why didn't the deposit load back? The correction screen should load back all the breakdown —
 * deposit, charge and payment — so we can press cancel to remove one and add a corrected one." Mrs
 * Adeola's receipt (#C74E799F, N32,150 of goods and a N6,000 deposit): the correction's items step
 * shows the deposit put down with it and what was paid; the payment step lists the deposit (paid)
 * with its cancel, and asks for nothing more. Read-only: the correction is never finished and the
 * cancel is never confirmed.
 *
 *     node scripts/probe-correction-deposit-ui.mjs [http://localhost:3100]
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
// Nothing is written: a correction or a cancel reaching the shop would be answered here, and fail the probe.
const written = [];
for (const fn of ['amend_sale', 'cancel_sale_deposit', 'void_payment']) {
  await p.route(`**/rest/v1/rpc/${fn}*`, (route) => {
    written.push(fn);
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

  await p.locator('button[aria-label="All sales and receipts"]').locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  await top().getByText('Mrs Adeola').first().click();
  await p.waitForTimeout(7000);
  let t = await text();
  check('her receipt says the deposit, and nothing of it left to pay', /Deposit, held for you\s*N6,000/.test(t) && !/Deposit still to pay/.test(t),
    (t.match(/Total.{0,200}/) ?? [''])[0]);

  await top().getByRole('button', { name: /Something on this is wrong/ }).first().click();
  await p.waitForTimeout(6000);
  t = await text();
  check('the correction shows the deposit put down with it', /Deposit put down with it\s*₦6,000/.test(t), (t.match(/It should say.{0,160}/) ?? [''])[0]);
  // The goods' payment. The N6,000 paid the deposit, not the goods, so it is the deposit line's.
  check('and what was paid for the goods', /Paid \(transfer\)\s*₦32,150/.test(t));

  await p.getByRole('button', { name: /Correct payment/ }).last().click();
  await p.waitForTimeout(6000);
  t = await text();
  // In Take payment's OWN lines — the till's "Deposit held" line and its payment rows — each with its cross.
  check('the deposit is Take payment’s own deposit line, paid', /Deposit held\s*Put down with this sale — paid\s*₦6,000/.test(t),
    (t.match(/Deposit held.{0,60}/) ?? [''])[0]);
  check('with its cross', (await top().getByRole('button', { name: /Cancel the deposit put down with this sale/ }).count()) === 1);
  check('the payments are Take payment’s own rows, each with its cross',
    /Already paid on this receipt\s*Transfer\s*₦32,150/.test(t) && (await top().getByRole('button', { name: /Take back the ₦32,150 transfer/ }).count()) === 1,
    (t.match(/Already paid on this receipt.{0,60}/) ?? [''])[0]);
  check('no separate deposit section any more', !/Deposit put down with this sale/.test(t));
  check('and nothing more is asked for', !/Pay all|The rest \(/.test(t) || /Pay all \(₦0\)/.test(t), (t.match(/Pay all.{0,20}|The rest.{0,20}/) ?? ['none'])[0]);
  await p.screenshot({ path: `${SHOTS}/correction-deposit.png`, fullPage: true });
  check('nothing was written', written.length === 0, written.join(','));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/correction-deposit-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
