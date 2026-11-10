/**
 * A TAB KEEPS ITS PLACE WHEN YOU SWITCH AWAY AND BACK.
 *
 * "group change makes the pages lose restore, but navigation in the same stack maintains the
 * scroll restore" (10 Nov). Scroll a tab's page down with the wheel (a person's scroll), switch to
 * another tab, switch back: it must be where it was. Stock and Money, both ways. Read-only.
 *
 *     node scripts/probe-tab-scroll-ui.mjs [http://localhost:3100]      (ENGINE=webkit for Safari)
 */
import { chromium, webkit } from '@playwright/test';
import { readFileSync } from 'node:fs';

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
const p = await browser.newPage({ viewport: { width: 390, height: 844 } });

/** The scroll of the page on show: the visible column body with the most to scroll. */
const top = () =>
  p.evaluate(() => {
    const bodies = [...document.querySelectorAll('.navstack-column-body')].filter((b) => b.offsetParent !== null && b.scrollHeight > b.clientHeight);
    return bodies.length ? Math.round(bodies[0].scrollTop) : -1;
  });
// Clicked in the page: after a scroll down the autohiding bar is off screen, as on a phone.
const tab = (name) =>
  p.evaluate((name) => {
    const item = [...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === name);
    item?.click();
  }, name);

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(6000);

  for (const [here, away] of [['Stock', 'Money'], ['Money', 'Stock'], ['Stock', 'Sell']]) {
    await tab(here);
    await p.waitForTimeout(2500);
    // Wheel steps until the page has moved — a page still loading its list has nothing to scroll.
    let before = 0;
    for (let tries = 0; tries < 3 && before <= 200; tries++) {
      await p.mouse.move(195, 500);
      for (let i = 0; i < 8; i++) {
        await p.mouse.wheel(0, 150);
        await p.waitForTimeout(60);
      }
      await p.waitForTimeout(800);
      before = await top();
    }
    await tab(away);
    await p.waitForTimeout(1500);
    await tab(here);
    await p.waitForTimeout(1500);
    const after = await top();
    check(`${here} → ${away} → ${here}`, before > 200 && Math.abs(after - before) < 30, `${before} -> ${after}`);
  }
} catch (e) {
  check('ran', false, e.message.split('\n')[0]);
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
