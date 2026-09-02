/**
 * The People stack: pushing the customer form and coming back must leave the stack standing.
 *
 * A pushed page that pops more than it should empties the stack, and an empty stack renders
 * nothing — the shop is left looking at a blank screen having done nothing wrong. It happened once
 * already on the delivery confirmation, where an overlay's history entry and a page pop unwound
 * each other.
 *
 * The nav address is watched, not just the pixels: `people-stack:1.a1` going to `people-stack:1`
 * is the fault, and it is legible in the URL before anything has had a chance to look blank.
 *
 *     node scripts/probe-people-nav.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/people-nav';
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const stamp = Date.now().toString().slice(-6);
const NAME = `ZZ Nav ${stamp}`;

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

/** The people stack's own address, e.g. "1.a1" — the part that says how deep it is. */
const peopleStack = () => {
  const m = /people-stack%3A([^|&#]*)/.exec(p.url());
  return m ? decodeURIComponent(m[1]) : '(not in the address)';
};

const bodyText = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ').trim();

const tab = async (label) => {
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(900);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(4500);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  await tab('People');
  const atRoot = peopleStack();
  check('the People stack is at its root', atRoot.length > 0, atRoot);
  const rootText = await bodyText();
  check('and the page has content', rootText.length > 40, rootText.slice(0, 60));

  // ══ 1. Push the form and come straight back ══════════════════════════════════════
  console.log('\n— open the form, then Back —');
  await p.locator('button[aria-label*="customer" i]:visible').first().click();
  await p.waitForTimeout(3500);
  const pushed = peopleStack();
  check('the form is a page on top', pushed !== atRoot, `${atRoot} → ${pushed}`);
  await p.screenshot({ path: `${SHOTS}/1-form.png` });

  await p.locator('button[aria-label*="back" i]:visible').first().click();
  await p.waitForTimeout(3000);
  await p.screenshot({ path: `${SHOTS}/2-back.png` });

  const afterBack = peopleStack();
  check('Back returns to exactly where it started', afterBack === atRoot, `${pushed} → ${afterBack}`);
  const backText = await bodyText();
  check('and the list is on screen, not a blank page', backText.length > 40, backText.slice(0, 60));

  // ══ 2. Push it, save, and come back ══════════════════════════════════════════════
  console.log('\n— open it again, save, and come back —');
  await p.locator('button[aria-label*="customer" i]:visible').first().click();
  await p.waitForTimeout(3500);

  await p.getByLabel(/Their name/i).fill(NAME);
  await p.getByLabel(/^Phone/i).fill(`0806${Date.now().toString().slice(-7)}`);
  await p.waitForTimeout(400);
  await p.getByRole('button', { name: /Save customer/i }).click();
  await p.waitForTimeout(7000);
  await p.screenshot({ path: `${SHOTS}/3-saved.png` });

  const afterSave = peopleStack();
  check('saving returns to the list, not past it', afterSave === atRoot, `${afterSave}`);

  const savedText = await bodyText();
  check('the page is drawn', savedText.length > 40, savedText.slice(0, 60));
  check('and the new person is in the list', savedText.includes(NAME));

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  const storeId = (await admin.from('stores').select('id').limit(1).single()).data.id;
  await admin.from('store_customers').delete().eq('store_id', storeId).eq('display_name', NAME);
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
