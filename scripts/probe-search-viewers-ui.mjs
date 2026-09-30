/**
 * SEARCH SHEETS: the box is focused once the sheet has opened, and a correction never flashes "empty".
 *
 *  1. Stock search: nothing is focused while the sheet slides up; the box is, once it has opened
 *     (a keyboard raised mid-slide made iOS push the header off and hide the rows).
 *  2. Type a term that finds nothing, then the correction of it: "nothing found" must not be on
 *     screen at any moment between the correction and its match.
 *  3. The product picker at the till: the same.
 *
 *     node scripts/probe-search-viewers-ui.mjs [http://localhost:3100]
 */
import { chromium, webkit } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
let failed = 0;
const check = (what, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`); if (!ok) failed += 1; };
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const browser = await (process.env.ENGINE === 'webkit' ? webkit : chromium).launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const PROBE_DRAFTS = trackDrafts(p);
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

/*
 * WHAT IS FOCUSED RIGHT AFTER THE TAP — measured inside the page, from the click itself.
 *
 * Timing from Node (before Playwright's click round-trip) charged the automation's own latency to
 * the app. A capture listener on the click reads the focused element in the next task, which is as
 * soon after the tap as anything outside it can look.
 */
const armTapWatch = () =>
  p.evaluate(() => {
    window.__tapFocus = null;
    document.addEventListener(
      'click',
      () => setTimeout(() => {
        const a = document.activeElement;
        window.__tapFocus = a && a.tagName === 'INPUT' ? 'input' : String(a?.tagName);
      }, 0),
      { capture: true, once: true },
    );
  });
const tapFocus = () => p.evaluate(() => window.__tapFocus);

/*
 * WHERE THE REAL BOX WAS WHEN IT TOOK FOCUS. Focused while the sheet was still sliding up — low on
 * the screen, where the keyboard goes — is what makes iOS pan the page (header gone, rows under the
 * keyboard). So every focus of an input inside the sheet records how far its sheet still had to go.
 */
const armSlideWatch = () =>
  p.evaluate(() => {
    window.__slideFocus = [];
    document.addEventListener(
      'focusin',
      (e) => {
        const dialog = e.target.closest?.('[role="dialog"]');
        if (!dialog || e.target.tagName !== 'INPUT') return;
        window.__slideFocus.push(getComputedStyle(dialog).transform);
      },
      { capture: true },
    );
  });
const settled = async (what) => {
  const r = await p.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    const t = getComputedStyle(d).transform;
    const heading = d?.querySelector('h1, h2, h3, input');
    return {
      moving: (window.__slideFocus ?? []).filter((m) => m !== 'none' && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(m) && m !== t),
      scrollY: window.scrollY,
      headTop: heading ? Math.round(heading.getBoundingClientRect().top) : -1,
    };
  });
  check(`the ${what} box was never focused mid-slide`, r.moving.length === 0, JSON.stringify(r.moving));
  check(`… the page is not panned`, r.scrollY === 0, `scrollY ${r.scrollY}`);
  check(`… and the sheet's header is on screen`, r.headTop >= 0, `top ${r.headTop}`);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  console.log('\n— Stock search —');
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(5000);
  const launcher = p.getByRole('button', { name: /Search your stock/i }).first();
  await launcher.waitFor({ state: 'visible', timeout: 60000 });
  await armTapWatch();
  await armSlideWatch();
  await launcher.click();
  await p.waitForTimeout(300);
  const f1 = await tapFocus();
  check('no text box is focused in the tap that opens the search (the keyboard waits for the sheet)', f1 !== 'input', String(f1));
  await p.waitForTimeout(1200);
  check('and the real search box has it once the sheet is up',
    await p.evaluate(() => !!document.activeElement?.closest('[role="dialog"]') && document.activeElement.tagName === 'INPUT'));
  await settled('search');

  const box = p.locator('[role="dialog"] input').first();
  await box.fill('zzqqxx');
  await p.waitForTimeout(3500);
  check('a term with no match says so', /Try part of the name/.test(await p.locator('body').innerText()));

  const flash = p.evaluate(
    () =>
      new Promise((resolve) => {
        let flashed = false;
        const start = Date.now();
        const t = setInterval(() => {
          const txt = document.body.innerText;
          const val = document.querySelector('[role="dialog"] input')?.value;
          if (val === 'Goldberg' && /Try part of the name/.test(txt)) flashed = true;
          if (/Goldberg Bottle/.test(txt)) { clearInterval(t); resolve({ flashed, ms: Date.now() - start }); }
          if (Date.now() - start > 15000) { clearInterval(t); resolve({ flashed, ms: -1 }); }
        }, 20);
      }),
  );
  await box.fill('Goldberg');
  const f = await flash;
  check('its correction never flashes "nothing found"', !f.flashed && f.ms > 0, f.ms < 0 ? 'no result' : `${f.ms}ms to the match`);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(1500);

  console.log('\n— The product picker at the till —');
  await p.locator('.nav-item').filter({ hasText: /^Sell$/ }).first().click();
  await p.waitForTimeout(4000);
  const add = p.getByRole('button', { name: /Add an item/i }).first();
  await add.waitFor({ state: 'visible', timeout: 60000 });
  await armTapWatch();
  await armSlideWatch();
  await add.click();
  await p.waitForTimeout(300);
  const f2 = await tapFocus();
  check('no text box is focused in the tap that opens the picker (the keyboard waits for the sheet)', f2 !== 'input', String(f2));
  await p.waitForTimeout(1200);
  check('and the real picker box has it once the sheet is up',
    await p.evaluate(() => !!document.activeElement?.closest('[role="dialog"]') && document.activeElement.tagName === 'INPUT'));
  await settled('picker');

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
