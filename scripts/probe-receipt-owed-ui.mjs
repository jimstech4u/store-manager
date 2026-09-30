/**
 * A CORRECTED RECEIPT SAYS WHAT THE ACCOUNT SAYS.
 *
 * Oroja brother, 30 Sep: N13,200, corrected with N13,100 paid. It printed "Owed before N13,100 ·
 * Total owed N13,200" — the account read at the sale's first moment, before the correction's money
 * (0240). Opened from Sell -> All sales and receipts, it must say: Paid N13,100 · Left on this sale N100 · Total owed N100,
 * and no "Owed before". Read-only.
 *
 *     node scripts/probe-receipt-owed-ui.mjs [http://localhost:3100]
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
const pageText = () =>
  p.evaluate(() => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    const pages = [...(active?.querySelectorAll('.navstack-page') ?? [])];
    return (pages[pages.length - 1]?.innerText ?? '').replace(/\s+/g, ' ');
  });

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
  await p.getByText('Oroja brother').locator('visible=true').first().click();
  await p.waitForTimeout(6000);
  const t = await pageText();
  await p.screenshot({ path: `${SHOTS}/receipt-oroja.png`, fullPage: true });
  check('it is the corrected receipt', /Corrected/.test(t) && /13,200/.test(t), t.slice(0, 120));
  check('Paid N13,100', /Paid \(cash\)\s*[N₦]13,100/.test(t));
  check('Left on this sale N100', /Left on this sale\s*[N₦]100\b/.test(t));
  check('Total owed N100', /Total owed\s*[N₦]100\b/.test(t), (t.match(/Total owed\s*\S+/) ?? [''])[0]);
  check('no "Owed before" (they owed nothing before it)', !/Owed before/.test(t), (t.match(/Owed before\s*\S+/) ?? [''])[0]);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/receipt-oroja-crash.png` }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
