/**
 * PHOTOGRAPHS OF CHOSEN PAGES, on a phone and on a desktop — to compare a redesign before and after.
 *
 *     SHOTS=<dir> node scripts/shots-pages.mjs [http://localhost:3100]
 *
 * Groups you file under, Words you measure in, Running low (from More), the count gate (from the
 * till, on a tab of its own, cancelled at the end) and Stock for comparison. Nothing is recorded.
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';
import { addOnTill } from './till.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? 'probe-shots/pages';
mkdirSync(SHOTS, { recursive: true });
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const browser = await chromium.launch();
const drafts = new Set();

for (const [label, viewport, mobile] of [
  ['phone', { width: 390, height: 844 }, true],
  ['desktop', { width: 1440, height: 900 }, false],
]) {
  const p = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
  const tracked = trackDrafts(p);
  const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
  // The tab bar on a phone, the sidebar on a desktop: whichever control is labelled exactly so.
  const tab = (name) =>
    p.evaluate((name) => {
      const all = [...document.querySelectorAll('.nav-item, aside *, nav *, [class*="idebar"] *')];
      const hit = all.find((n) => n.textContent.trim() === name && n.offsetParent !== null);
      (hit?.closest('button, a, [role="button"], [role="tab"], .nav-item') ?? hit)?.click();
    }, name);
  const shot = (name) => p.screenshot({ path: `${SHOTS}/${name}-${label}.png` });
  const back = async () => {
    await p.goBack();
    await p.waitForTimeout(1800);
  };

  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(7000);

  await tab('Stock');
  await p.waitForTimeout(3000);
  await shot('stock');

  await tab('More');
  await p.waitForTimeout(2500);
  for (const [name, file] of [
    ['Groups you file under', 'groups'],
    ['Words you measure in', 'units'],
  ]) {
    await top().getByText(name, { exact: true }).first().evaluate((el) => el.click());
    await p.waitForTimeout(3500);
    await shot(file);
    await back();
  }
  await top().getByRole('button', { name: /Running low/ }).first().evaluate((el) => el.click()).catch(() => {});
  await p.waitForTimeout(3500);
  await shot('running-low');
  await back();

  // The count gate, from a tab of the probe's own.
  await tab('Sell');
  await p.waitForTimeout(3000);
  const start = p.getByRole('button', { name: /Start (another|a) customer/ }).first();
  if (!(await start.count())) {
    await shot('sell-no-start');
    console.log(`  (${label}: no way to start a customer found)`);
  } else {
    await start.evaluate((el) => el.click());
  }
  await p.waitForTimeout(4000);
  await addOnTill(p, '1 Big Stout', 'Big Stout Bottle (600mL)').catch(() => {});
  await p.waitForTimeout(3000);
  const countNow = p.getByRole('button', { name: /Count (it|them) now/ }).locator('visible=true').first();
  if (await countNow.count()) {
    await countNow.click();
    await p.waitForTimeout(4000);
    await shot('count-gate');
  } else {
    console.log(`  (${label}: nothing uncounted, so no count gate to photograph)`);
  }
  for (const id of tracked) drafts.add(id);
  await p.close();
}

await sweepDrafts(admin, drafts);
await browser.close();
console.log('saved to', SHOTS);
