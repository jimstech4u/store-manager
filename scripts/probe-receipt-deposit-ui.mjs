/**
 * A DEPOSIT PAID AT THE TILL IS ON THE RECEIPT, COUNTED ONCE, AND CASH IS ONE LINE.
 *
 * Mr Friday, 30 Sep: goods N61,150 + POS N100 + a N9,950 crate deposit, N71,200 handed over. The
 * receipt said "Left on this sale N100", no deposit, and two "Paid (cash)" lines; his account said
 * the shop owed him N9,950 on top of holding his deposit (0244). Opened from Sell -> All sales, it
 * must say the deposit, one cash line, nothing left — and his account must be square. Read-only.
 *
 *     node scripts/probe-receipt-deposit-ui.mjs [http://localhost:3100]
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

  await p.locator('button[aria-label="All sales and receipts"]').locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  await top().getByText('Mr Friday').first().click();
  await p.waitForTimeout(7000);
  const t = await text();
  const money = (t.match(/Items.{0,400}/) ?? [''])[0];
  check('the deposit is on the receipt', /Deposit, held for you\s*N9,950/.test(t), money.slice(0, 260));
  check('cash is one line', (t.match(/Paid \(cash\)/g) ?? []).length === 1 && /Paid \(cash\)\s*N31,250/.test(t));
  check('POS is its own line', /Paid \(pos\)\s*N30,000/.test(t));
  check('paid in all is the sale', /Paid in all\s*N61,250/.test(t));
  check('nothing left on the sale', !/Left on this sale|Balance\s*N/.test(money), money.slice(0, 260));
  await p.screenshot({ path: `${SHOTS}/receipt-deposit.png`, fullPage: true });
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/receipt-deposit-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
