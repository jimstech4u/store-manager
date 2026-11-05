/**
 * THE APP ON A TABLET AND A LAPTOP: the SideBar, and pages that use the width.
 *
 * "On web and tablet view is not well used … in web or tab view, [JIMSteps] uses the sidebar in
 * place of the navigationbar and the pages react to the changes of the sidebar." From 801px the
 * SideBar replaces the tab bar; every page is a container and lays itself out by its own width.
 *
 * Screenshots each first page (and any extra pages named on the command line, as tab:button-name)
 * at a laptop (1440) and a tablet on its side (1024), checks the tab bar is gone and the sidebar
 * switches tabs, that tapping the active tab returns it to its first page, and that a page widens
 * when the sidebar collapses.
 *
 *     node scripts/probe-wide-shell-ui.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:3100';
const OUT = process.env.SHOTS ?? '.';
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
const errors = [];

for (const [label, width, height] of [['laptop', 1440, 900], ['tablet', 1024, 768]]) {
  console.log(`\n— ${label} ${width}×${height} —`);
  const p = await browser.newPage({ viewport: { width, height } });
  p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  const side = (name) => p.locator('#main-sidebar .sidebar-item').filter({ hasText: new RegExp(`^${name}$`) });
  const shot = (name) => p.screenshot({ path: `${OUT}/wide-${label}-${name}.png` });
  try {
    await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(1500);
    await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
    await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
    await p.locator('button[type="submit"]').first().click();
    await p.waitForURL(/\/main/, { timeout: 60000 });
    await p.waitForTimeout(6000);

    check('the SideBar is drawn', await p.locator('#main-sidebar').isVisible());
    const barShown = await p.locator('.nav-item').filter({ hasText: /^Money$/ }).first().isVisible().catch(() => false);
    check('the tab bar is not', !barShown);
    await shot('sell');

    for (const tab of ['Stock', 'Money', 'More']) {
      await side(tab).click();
      await p.waitForTimeout(4500);
      await shot(tab.toLowerCase());
    }

    // A page laid out by its own width: the Money overview is two columns once there is room.
    await side('Money').click();
    await p.waitForTimeout(2500);
    const cols = async () =>
      p.evaluate(() => {
        const el = [...document.querySelectorAll('[class*="overview"]')].find((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).display === 'grid');
        return el ? getComputedStyle(el).gridTemplateColumns.split(' ').length : 1;
      });
    const before = await cols();
    const sidebarW = async () => (await p.locator('#main-sidebar').boundingBox())?.width ?? 0;
    const w0 = await sidebarW();
    await p.locator('#main-sidebar .sidebar-toggle').click();
    await p.waitForTimeout(800);
    const w1 = await sidebarW();
    check('the SideBar collapses', w1 < w0, `${Math.round(w0)} → ${Math.round(w1)}px`);
    const after = await cols();
    console.log(`      Money overview columns: ${before} with the SideBar open, ${after} closed`);
    await shot('money-collapsed');
    await p.locator('#main-sidebar .sidebar-toggle').click();
    await p.waitForTimeout(800);

    // Floating pill sits in the corner, not a tab bar's height up.
    const pill = await p.getByRole('button', { name: /Money out/ }).last().boundingBox();
    check('Money out sits at the corner', pill && height - (pill.y + pill.height) < 40, pill ? `${Math.round(height - pill.y - pill.height)}px from the foot` : 'not found');

    // The reselect gesture: deep in Stock, tapping Stock again returns to its first page.
    await side('Stock').click();
    await p.waitForTimeout(2500);
    await p.getByRole('button', { name: 'Suppliers and what you owe them' }).locator('visible=true').first().click();
    await p.waitForTimeout(3000);
    await shot('suppliers');
    await side('Stock').click();
    await p.waitForTimeout(2500);
    check('tapping the active tab returns it to its first page', await p.getByText('Stock is worth').last().isVisible());

    for (const extra of process.argv.slice(2).filter((a) => a.includes(':') && !a.startsWith('http'))) {
      const [tab, name] = extra.split(':');
      await side(tab).click();
      await p.waitForTimeout(2000);
      await p.getByRole('button', { name: new RegExp(name, 'i') }).locator('visible=true').first().click();
      await p.waitForTimeout(3500);
      await shot(name.replace(/\W+/g, '-').toLowerCase());
      await side(tab).click();
      await p.waitForTimeout(1500);
    }
  } catch (e) {
    console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
    await shot('crash').catch(() => {});
    failed += 1;
  } finally {
    await p.close();
  }
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
