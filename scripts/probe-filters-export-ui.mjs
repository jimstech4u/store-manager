/**
 * FILTERS ON THE SERVER, AND AN EXPORT OF EVERY MATCH — Stock, People, Sales. Looks and downloads;
 * changes nothing.
 *
 *     node scripts/probe-filters-export-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const OUT = 'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/filters';
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
let failed = 0;
const check = (what, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); if (!ok) failed += 1; };

const browser = await chromium.launch();
// A desktop-shaped context, so the export downloads rather than opening a share sheet.
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
const p = await ctx.newPage();
/*
 * The till starts a customer by itself when it opens with none, so even a probe that never
 * touches Sell can leave an empty tab on the shop's till. Only what THIS browser saved is closed.
 */
const PROBE_DRAFTS = trackDrafts(p);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
await p.addInitScript({ content: 'window.__NAV_STACK_DEVTOOLS__ = true;' });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const exportRows = async (label) => {
  const [dl] = await Promise.all([
    p.waitForEvent('download', { timeout: 60000 }),
    p.getByRole('button', { name: 'Export' }).locator('visible=true').first().click(),
  ]);
  const path = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(path);
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  console.log(`   ${label}: ${dl.suggestedFilename()} — ${lines.length - 1} rows`);
  return lines.length - 1;
};
const chip = async (name) => {
  await p.getByRole('tab', { name, exact: true }).locator('visible=true').first().click();
  await p.waitForTimeout(4000);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  console.log('\n— Stock —');
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(6000);
  await chip('None left');
  const outRows = await exportRows('none left');
  check('None left exports the 4 items with none left', outRows === 4, `${outRows}`);
  await chip('No price');
  const npRows = await exportRows('no price');
  check('No price exports all 50, not just the first page', npRows === 50, `${npRows}`);
  await chip('Everything');

  console.log('\n— People —');
  await p.evaluate(() => window.__NAV_STACK__.push('stock-stack', 'people_page'));
  await p.waitForTimeout(6000);
  await chip('Owes you');
  const owes = await exportRows('owes you');
  check('Owes you exports the 5 who owe', owes === 5, `${owes}`);
  await chip('Has your empties');
  const emp = await exportRows('has your empties');
  check('Has your empties exports the 7', emp === 7, `${emp}`);
  await chip('Everyone');

  console.log('\n— Sales —');
  await p.evaluate(() => window.__NAV_STACK__.push('stock-stack', 'sales_page'));
  await p.waitForTimeout(6000);
  await chip('Unpaid');
  const unpaid = await exportRows('unpaid');
  check('Unpaid exports the unpaid sales', unpaid >= 7, `${unpaid}`);
  await chip('All');
  const all = await exportRows('all');
  check('All exports every sale', all >= 41, `${all}`);

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
