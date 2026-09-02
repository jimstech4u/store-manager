/**
 * What the history entries actually say at the moment the reselect goes wrong.
 *
 * Reading, not asserting. `probe-tab-reselect` proves the fault; this prints the `?nav=`, the
 * `group=` and the serial of every step leading to it, so the fix is aimed at the real cause
 * rather than the first plausible one.
 *
 *     node scripts/probe-reselect-history.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
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

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const where = async (label) => {
  const info = await p.evaluate(() => {
    const u = new URL(window.location.href);
    return {
      nav: u.searchParams.get('nav'),
      group: u.searchParams.get('group'),
      serial: window.history.state?.axSerial ?? null,
      len: window.history.length,
    };
  });
  const top = (await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 40);
  console.log(
    `  ${label.padEnd(22)} serial=${String(info.serial).padEnd(4)} group=${String(info.group).padEnd(6)} nav=${info.nav} | ${top}`,
  );
};

const tab = async (label) => {
  await p.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll('div')) {
      if (el.scrollHeight > el.clientHeight + 40) el.scrollTop = 0;
    }
  });
  await p.waitForTimeout(700);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(3500);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);
  await where('signed in');

  await tab('Stock');
  await where('tab Stock');

  await p.getByRole('button', { name: /Record a delivery|Receive/i }).first().click();
  await p.waitForTimeout(4000);
  await where('push delivery');

  await tab('Count');
  await where('tab Count');

  const row = p.locator('[class*="count-page_row"]').first();
  if (await row.count()) {
    await row.click();
    await p.waitForTimeout(4000);
  }
  await where('push count entry');

  await tab('Stock');
  await where('tab Stock again');

  await tab('Stock');
  await where('RESELECT');
} finally {
  await browser.close();
}
