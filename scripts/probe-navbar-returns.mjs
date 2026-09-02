/**
 * The tab bar comes back when a pushed page pops.
 *
 * `probe-mid-additions` reported the bar sitting at y=927 in an 844px viewport — hidden, and off
 * the bottom — after a form popped back to the page that pushed it. If that were reliable, a shop
 * adding an item mid-count would be left with no navigation until it happened to scroll the right
 * way.
 *
 * IT HAS NOT BEEN REPRODUCED HERE. Neither a wheel over the list nor scrolling the pane directly
 * hides the bar in this sequence, so the setup for the interesting case cannot be reached and the
 * observation stands as one sighting rather than a defect. That is reported rather than dressed up:
 * a probe that turns "I could not set this up" into a failure is as misleading as one that turns it
 * into a pass.
 *
 * What IS asserted is the part that can be: after a push and a pop the bar is on screen. Asked of
 * its POSITION, because "is it visible" is the question Playwright answered yes to while it sat
 * off the bottom of the screen.
 *
 *     node scripts/probe-navbar-returns.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/navbar';
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

/*
 * Scrolls the pane this app actually scrolls.
 *
 * `mouse.wheel` moves whatever is under the pointer, and in this app that is usually a card rather
 * than the scroller — a first version wheeled 2500px and the bar never moved, so the probe was
 * testing its own gesture. Driving the scrolling element and dispatching the event is what the bar
 * listens for.
 */
const scrollPane = async (by) => {
  await p.evaluate((delta) => {
    const pane = Array.from(document.querySelectorAll('div')).find(
      (el) => el.scrollHeight > el.clientHeight + 200,
    );
    if (pane) {
      pane.scrollTop += delta;
      pane.dispatchEvent(new Event('scroll', { bubbles: true }));
    } else {
      window.scrollBy(0, delta);
    }
  }, by);
  await p.waitForTimeout(1500);
};

/** Where the bar actually is, in viewport terms. */
const barTop = async () => {
  const box = await p.locator('.nav-item').first().boundingBox();
  return box ? Math.round(box.y) : null;
};
const onScreen = async () => {
  const y = await barTop();
  const h = p.viewportSize().height;
  return y !== null && y < h;
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  check('the bar is on screen to begin with', await onScreen(), `y=${await barTop()}`);

  // ── Scroll down far enough to hide it ────────────────────────────────────────
  console.log('\n— scrolled down, which hides it by design —');
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(4000);
  await scrollPane(2500);
  await p.screenshot({ path: `${SHOTS}/1-hidden.png` });
  const hidden = !(await onScreen());
  console.log(
    hidden
      ? `    the bar hid, as intended (y=${await barTop()})`
      : `    NOTE: could not make the bar hide here (y=${await barTop()}); the autohide case below is untested`,
  );

  // ── Scroll back up: it should return ─────────────────────────────────────────
  console.log('\n— and scrolled back up —');
  await scrollPane(-2500);
  await p.screenshot({ path: `${SHOTS}/2-back.png` });
  check('the bar is on screen after scrolling about', await onScreen(), `y=${await barTop()}`);

  // ── The case that matters: a push and a pop while it is hidden ───────────────
  console.log('\n— hidden, then a page is pushed and popped —');
  await scrollPane(2500);
  const wasHidden = !(await onScreen());

  await p.getByRole('button', { name: /Record a delivery|Receive/i }).first().click();
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: 'Go back' }).first().click();
  await p.waitForTimeout(4000);
  await p.screenshot({ path: `${SHOTS}/3-after-pop.png` });

  check(
    'the bar is back after a push and a pop',
    await onScreen(),
    `was ${wasHidden ? 'hidden' : 'shown'} before; now y=${await barTop()} in ${p.viewportSize().height}px`,
  );
} finally {
  await browser.close();
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
