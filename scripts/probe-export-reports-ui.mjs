/**
 * EXPORT A REPORT — made, and taken away every way: CSV, PDF, picture, and the page printer's view.
 * Reads only; nothing is changed.
 *
 *     node scripts/probe-export-reports-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const OUT = 'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/export';
mkdirSync(OUT, { recursive: true });
const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
let failed = 0;
const check = (what, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); if (!ok) failed += 1; };

const browser = await chromium.launch();
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

const download = async (buttonName) => {
  const [dl] = await Promise.all([
    p.waitForEvent('download', { timeout: 60000 }),
    p.getByRole('button', { name: buttonName }).locator('visible=true').first().click(),
  ]);
  const path = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(path);
  return path;
};

const report = async (label, periodChip, tag) => {
  console.log(`\n— ${label} —`);
  await p.getByRole('button', { name: new RegExp(`^${label}`) }).locator('visible=true').first().click();
  await p.waitForTimeout(600);
  if (periodChip) {
    await p.getByRole('tab', { name: periodChip, exact: true }).locator('visible=true').first().click();
    await p.waitForTimeout(400);
  }
  await p.getByRole('button', { name: 'Show the report' }).first().click();
  await p.waitForTimeout(6000);
  const rows = await p.locator('[data-print-root="page"] tbody tr').count();
  const totals = await p.locator('[data-print-root="page"] dl').innerText().catch(() => '');
  console.log(`   preview: ${rows} rows · ${totals.replace(/\s+/g, ' ')}`);
  check(`${label}: the preview shows the report`, rows > 0 || /Nothing matches/.test(await p.locator('body').innerText()));
  await p.locator('[data-print-root="page"]').screenshot({ path: `${OUT}/${tag}-preview.png` });

  const csv = readFileSync(await download(/Download CSV/), 'utf8').split(/\r?\n/).filter(Boolean);
  check(`${label}: CSV has every row and a heading`, csv.length === rows + 1, `${csv.length - 1} rows`);

  const pdfPath = await download(/Save as PDF/);
  const pdf = readFileSync(pdfPath, 'latin1');
  const pages = Number((pdf.match(/\/Count (\d+)/) ?? [])[1] ?? 0);
  check(`${label}: PDF is a valid A4 document`, pdf.startsWith('%PDF-1.4') && pdf.includes('%%EOF') && pdf.includes('595.28 841.89'), `${pages} page(s)`);

  const png = await download(/Send as picture/);
  check(`${label}: the picture is made`, readFileSync(png).length > 1000, png.split('/').pop());

  // What a page printer receives: the print stylesheet, on A4.
  await p.evaluate(() => {
    document.documentElement.style.setProperty('--print-size', 'A4 portrait');
    document.documentElement.style.setProperty('--print-margin', '12mm');
  });
  await p.emulateMedia({ media: 'print' });
  await p.setViewportSize({ width: 794, height: 1123 });
  await p.screenshot({ path: `${OUT}/${tag}-print.png`, fullPage: true });
  await p.emulateMedia({ media: 'screen' });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.evaluate(() => {
    document.documentElement.style.removeProperty('--print-size');
    document.documentElement.style.removeProperty('--print-margin');
  });
  return pdfPath;
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);
  await p.evaluate(() => window.__NAV_STACK__.push('sell-stack', 'export_page'));
  await p.waitForTimeout(5000);

  await report('Who owes me', null, 'owes');
  await report('Payments received', 'This month', 'payments');
  await report('What was counted', 'Today', 'counts');

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
