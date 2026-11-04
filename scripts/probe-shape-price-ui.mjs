/**
 * EACH SHAPE ITS OWN PRICE, AND TWO SHAPES NEVER THE SAME SIZE BY ACCIDENT.
 *
 * "Selling a product with multiple shapes is bad: the price for a Zetar pack is the same for pieces."
 * Zetar's Piece has no price, and switching a line to it used to keep the pack's ₦6,000. On the till:
 * switching to Piece leaves the price empty with "No price yet", and switching back brings the pack's
 * own price. On Zetar's shapes page: the Piece standing alone at the size of a pack is said, and Save
 * waits for it. Its own tab is taken back off the till; nothing is sold or saved.
 *
 *     node scripts/probe-shape-price-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
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
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const PROBE_DRAFTS = trackDrafts(p);
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const price = () => p.getByLabel(/^Price per /).first();

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  if (await plus.count()) {
    await plus.scrollIntoViewIfNeeded();
    await plus.click();
    await p.waitForTimeout(4000);
  }
  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(2000);
  const search = p.locator('[role="dialog"] input').first();
  await search.fill('Zetar');
  await p.waitForTimeout(2500);
  await p.locator('[role="dialog"]').getByText(/^Zetar$/).first().click();
  await p.waitForTimeout(5000);

  const shapes = p.getByRole('group', { name: 'How it is being sold' }).first();
  check('the line offers Zetar in both shapes', (await shapes.getByRole('button', { name: 'Piece' }).count()) > 0 && (await shapes.getByRole('button', { name: 'Pack' }).count()) > 0);
  await shapes.getByRole('button', { name: 'Pack' }).click();
  await p.waitForTimeout(1500);
  check('a pack carries the pack price', (await price().inputValue()).replace(/[^0-9.]/g, '') === '6000', await price().inputValue());

  await shapes.getByRole('button', { name: 'Piece' }).click();
  await p.waitForTimeout(2500);
  check('a piece does not keep the pack price', (await price().inputValue()).trim() === '', await price().inputValue());
  check('and the line asks for its price', (await p.getByRole('button', { name: /No price yet/ }).count()) > 0);

  await shapes.getByRole('button', { name: 'Pack' }).click();
  await p.waitForTimeout(2500);
  check('back to the pack, its own price again', (await price().inputValue()).replace(/[^0-9.]/g, '') === '6000', await price().inputValue());

  // Zetar's shapes, as the shop would open them.
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(3000);
  await p.getByRole('button', { name: /Search your stock/ }).locator('visible=true').first().click();
  await p.waitForTimeout(1500);
  await p.keyboard.type('Zetar');
  await p.waitForTimeout(3500);
  await p.locator('.react-modal-sheet-container').getByText(/^Zetar$/).locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  await p.getByRole('button', { name: /The shapes it comes in/ }).locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  const page = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check('the shapes page says the two are the same size', /each stand on their own at the same size/.test(page), (page.match(/[^.]*same size[^.]*/) ?? [''])[0]);
  check('and Save waits for it', await p.getByRole('button', { name: /^Save$/ }).locator('visible=true').first().isDisabled());

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await sweepDrafts(admin, PROBE_DRAFTS);
  await browser.close();
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
