/**
 * The same page, twice in one stack.
 *
 * «if we already push page (empties) and then the stack had a page that pushed empties again, and
 *  when we pop for the new empties, we go to empty»
 *
 * Now that every record page is reachable from every other, a stack can genuinely hold the same page
 * twice: a customer's Empties, up to their account, and their Empties again. An entry's uid was a
 * hash of its route and params, so both copies were ONE uid — React drew two pages under one key,
 * and they shared a scroll container, a transition and a cached instance. Popping the second landed
 * on a blank page.
 *
 *     node scripts/probe-same-page-twice.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { installNavDevtools, navStack } from '@academix-admin/navigation-stack/playwright';

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

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await installNavDevtools(p);

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const warnings = [];
p.on('console', async (m) => {
  if (m.type() !== 'error' || !/same key|duplicate/i.test(m.text())) return;
  const parts = [];
  for (const a of m.args()) {
    try {
      parts.push(String(await a.jsonValue()).replace(/\s+/g, ' '));
    } catch {
      parts.push('(unreadable)');
    }
  }
  warnings.push(parts.join(' ').slice(0, 400));
});

/** What the page on top actually shows. */
const top = () =>
  p.evaluate(() => {
    const pages = [...document.querySelectorAll('.navstack-page')].filter((c) => c.offsetParent !== null);
    const el = pages[pages.length - 1];
    const text = (el ?? document.body).innerText.replace(/\s+/g, ' ').trim();
    return {
      head: [...(el ?? document.body).querySelectorAll('h1')].map((h) => h.innerText.trim()).join('/'),
      chars: text.length,
      text: text.slice(0, 80),
    };
  });

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(14000);

  // A customer with containers out, reached from the Empties list on the till.
  const step = async (label) => console.log(`  … ${label}: ${(await top()).head || '(no heading)'}`);
  await step('after login');
  // Signing in lands on the till already; no need to tap the tab.
  await step('on the till');
  console.log('   actions:', (await p.locator('header button, [class*="header"] button').locator('visible=true').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.innerText).filter(Boolean))).join(' | '));
  await p.getByRole('button', { name: /Containers still to come back/i }).locator('visible=true').first().click();
  await p.waitForTimeout(6000);
  const first = p.locator('.navstack-page:not([inert]) li button').locator('visible=true').first();
  check('the empties list has somebody on it', (await first.count()) > 0, (await top()).text);
  await first.click();
  await p.waitForTimeout(6000);
  check('their empties opened', /Empties/.test((await top()).head), (await top()).head);

  // Up to their account, then back down to the same Empties page: the same page, twice.
  await p.getByRole('button', { name: /Their account/i }).locator('visible=true').first().click();
  await p.waitForTimeout(6000);
  const account = (await top()).head;
  await p.getByRole('button', { name: /^Empties$/ }).locator('visible=true').first().click();
  await p.waitForTimeout(6000);

  const keys = await navStack(p, 'sell-stack').keys();
  const uids = await p.evaluate(() =>
    window.__NAV_STACK__.snapshot('sell-stack').entries.map((e) => e.uid),
  );
  console.log('  stack:', keys.join(' → '));
  check('the same page twice, each its own entry', new Set(uids).size === uids.length, uids.join(' | '));
  check('no duplicate-key complaint from React', warnings.length === 0, warnings[0] ?? '');

  // The pop the report is about.
  await p.getByRole('button', { name: /go back/i }).locator('visible=true').first().click();
  await p.waitForTimeout(4000);
  const afterPop = await top();
  check('popping the second Empties lands on the account, not a blank page', afterPop.head === account, `${afterPop.head} (${afterPop.chars} chars)`);
  check('and the page below has its content', afterPop.chars > 40, afterPop.text);

  // One more, for the page under that.
  await p.getByRole('button', { name: /go back/i }).locator('visible=true').first().click();
  await p.waitForTimeout(4000);
  const back2 = await top();
  check('the first Empties is still whole underneath', /Empties/.test(back2.head) && back2.chars > 40, `${back2.head} (${back2.chars} chars)`);
} catch (e) {
  console.log('STOPPED:', String(e).split('\n')[0]);
  failed += 1;
} finally {
  if (errors.length) console.log('  page errors:', errors.slice(0, 3));
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
