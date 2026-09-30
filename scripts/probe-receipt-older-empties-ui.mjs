/**
 * A RECEIPT CAN SETTLE WHAT THEY HAD FROM BEFORE, TOO.
 *
 * "When settling empties we only see buttons to settle the empties for that particular sale, with no
 * outstanding. Maybe a checkbox that loads the old ones if they brought them." And: "Still with you
 * includes International bottles 2 — a maker does not have bottles."
 *
 * Arewa's receipt (order NG2QZ): the paper says International Breweries 5 crates (4 Trophy from the
 * sale + 1 from before) and no maker line in bottles; the empties block shows this sale's own, offers
 * "Include what they had from before", and ticked it lists everything she holds. Every writer is
 * answered by the probe, so nothing is recorded.
 *
 *     node scripts/probe-receipt-older-empties-ui.mjs [http://localhost:3100]
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

// Nothing is recorded: every empties writer is answered here.
for (const fn of ['record_customer_empties', 'record_customer_empties_for_group', 'write_off_customer_empties']) {
  await p.route(`**/rest/v1/rpc/${fn}*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }),
  );
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
  await top().getByText('Arewa').first().click();
  await p.waitForTimeout(7000);

  let t = await text();
  const paper = (t.match(/Still with you.{0,200}/) ?? [''])[0];
  check('the paper counts her old Trophy crate: International Breweries 5 crates', /International Breweries\s*crates\s*5/.test(t), paper);
  check('no maker line in bottles', !/Breweries\s*bottles/i.test(t), paper);

  const older = top().getByRole('checkbox', { name: /Include what they had from before/ });
  check('the empties block offers what she had from before', (await older.count()) === 1);
  await older.check();
  await p.waitForTimeout(3500);
  t = await text();
  const block = (t.match(/Include what they had from before.{0,400}/) ?? [''])[0];
  check('ticked, it lists everything she holds', /International Breweries crates/.test(block) && /Nigerian Breweries crates/.test(block), block.slice(0, 220));
  await p.screenshot({ path: `${SHOTS}/receipt-older-empties.png`, fullPage: true });
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/receipt-older-empties-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
