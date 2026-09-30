/**
 * THE VIEWERS' BACK WORKS WITH THE KEYBOARD UP.
 *
 * "the search viewer and selection viewer bring keyboard but now we cannot press back button in the
 * viewer and it is not working." Both viewers open with the search box focused. This taps their own
 * arrow, and tries the phone's Back, on:
 *
 *   S  Stock → Search your stock (search-viewer): the arrow closes it; the phone Back closes it.
 *   P  Sell → Add an item (selection-viewer): the arrow leaves search and STAYS out; the close
 *      button closes it; the phone Back closes it — and the till is still there, not a blank tab.
 *
 *     node scripts/probe-viewer-back-ui.mjs [http://localhost:3100]
 */

import { chromium, webkit } from '@playwright/test';
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

const browser = await (process.env.ENGINE === 'webkit' ? webkit : chromium).launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
// Only the tabs THIS browser saves are ever cleaned up — never the shop's own (see probe-drafts).
const PROBE_DRAFTS = trackDrafts(p);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const sheetOpen = () =>
  p.evaluate(() =>
    [...document.querySelectorAll('.react-modal-sheet-container')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top < window.innerHeight - 40;
    }),
  );
const focusedSearch = () =>
  p.evaluate(() => {
    const a = document.activeElement;
    return a instanceof HTMLInputElement && /search/i.test(a.className + ' ' + a.placeholder);
  });
const searchMode = () => p.locator('button[aria-label="Exit search mode"]').locator('visible=true').count();
const onScreen = () =>
  p.evaluate(() => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    return {
      tab: active?.getAttribute('data-stack-id'),
      pages: active?.querySelectorAll('.navstack-page').length ?? 0,
      blank: (active?.textContent ?? '').trim().length === 0,
    };
  });
const tab = async (label) => {
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(2500);
};
const phoneBack = async () => {
  await p.goBack({ waitUntil: 'commit' }).catch(() => {});
  await p.waitForTimeout(2000);
};

const openStockSearch = async () => {
  await tab('Stock');
  await p.getByRole('button', { name: /Search your stock/ }).locator('visible=true').first().click();
  await p.waitForTimeout(1800);
};
const openPicker = async () => {
  await tab('Sell');
  const add = p.getByRole('button', { name: /Add an item/ }).locator('visible=true').first();
  // A fresh browser has nobody on the till: start one (tracked, and closed again at the end).
  if ((await add.count()) === 0) {
    await p.getByRole('button', { name: /Start a customer/ }).locator('visible=true').first().click();
    await p.waitForTimeout(2500);
  }
  await add.click();
  await p.waitForTimeout(1800);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(8000);

  console.log('S  Stock search (search-viewer)');
  await openStockSearch();
  check('opens with the search box focused', (await sheetOpen()) && (await focusedSearch()));
  await p.locator('.search-viewer-search-back-button').locator('visible=true').first().click();
  await p.waitForTimeout(1500);
  check('its arrow closes it', !(await sheetOpen()));
  await openStockSearch();
  await phoneBack();
  check('the phone Back closes it', !(await sheetOpen()));
  const s = await onScreen();
  check('… leaving Stock where it was', s.tab === 'stock-stack' && s.pages === 1 && !s.blank, JSON.stringify(s));

  console.log('P  Sell product picker (selection-viewer)');
  await openPicker();
  check('opens in search, box focused', (await sheetOpen()) && (await searchMode()) > 0 && (await focusedSearch()));
  await p.locator('button[aria-label="Exit search mode"]').locator('visible=true').first().click();
  await p.waitForTimeout(1500);
  check('its arrow leaves search mode', (await searchMode()) === 0, `still in search: ${await searchMode()}`);
  check('… and the picker is still open to browse', await sheetOpen());
  await p.waitForTimeout(1500);
  check('… and does not jump back into search', (await searchMode()) === 0);
  await p.locator('.selection-viewer-cancel').locator('visible=true').first().click();
  await p.waitForTimeout(1500);
  check('its close button closes it', !(await sheetOpen()));
  await openPicker();
  await phoneBack();
  check('the phone Back closes it', !(await sheetOpen()));
  const t = await onScreen();
  check('… leaving the till where it was', t.tab === 'sell-stack' && !t.blank, JSON.stringify(t));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p
    .screenshot({ path: 'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/viewer-crash.png' })
    .catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
