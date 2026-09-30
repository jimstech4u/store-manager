/**
 * A LIST PAGE'S SEARCH STAYS IN REACH AS IT SCROLLS, and its title makes room.
 *
 * "Stock page with the search input and export, filter button section should be pinned and scroll
 * away the header … sales, money and places that have that search." On each page: scroll the list
 * well down, then check the search box is at the top of the screen, the page title is not, and the
 * search box still opens the search.
 *
 *     node scripts/probe-pinned-tools-ui.mjs [http://localhost:3100]
 */

import { chromium, webkit } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/pinned';
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

const browser = await (process.env.ENGINE === 'webkit' ? webkit : chromium).launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const tab = async (label) => {
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(2500);
};

/** Scroll the visible page body down, then report where the search box and the title are. */
const scrollAndMeasure = (label, title) =>
  p.evaluate(
    async ({ label, title }) => {
      const active = document.querySelector('.group-stack-container[data-active="true"]');
      const bodies = [...(active?.querySelectorAll('.navstack-column-body') ?? [])].filter(
        (el) => el.getBoundingClientRect().width > 0,
      );
      const body = bodies[bodies.length - 1];
      if (!body) return { error: 'no body' };
      const room = body.scrollHeight - body.clientHeight;
      body.scrollTop = Math.min(room, 900);
      body.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 700));
      const search = [...body.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label') === label || b.textContent?.includes(label),
      );
      const h1 = [...body.querySelectorAll('h1')].find((h) => h.textContent?.trim() === title);
      const bodyTop = body.getBoundingClientRect().top;
      return {
        scrolled: body.scrollTop,
        room,
        searchTop: search ? Math.round(search.getBoundingClientRect().top - bodyTop) : null,
        titleBottom: h1 ? Math.round(h1.getBoundingClientRect().bottom - bodyTop) : null,
      };
    },
    { label, title },
  );

const page = async (name, open, label, title) => {
  console.log(name);
  await open();
  await p.waitForTimeout(2500);
  const m = await scrollAndMeasure(label, title);
  await p.screenshot({ path: `${SHOTS}/${name.replace(/\W+/g, '-')}.png` });
  if (m.error || m.room < 120) {
    console.log(`  (list too short to scroll here: ${JSON.stringify(m)})`);
    return;
  }
  check('the search box is pinned at the top', m.searchTop !== null && m.searchTop >= 0 && m.searchTop < 40, JSON.stringify(m));
  check('the title has scrolled away', m.titleBottom === null || m.titleBottom <= 0, JSON.stringify(m));
  await p.getByRole('button', { name: label }).locator('visible=true').first().click();
  await p.waitForTimeout(1500);
  const open2 = await p.evaluate(() =>
    [...document.querySelectorAll('.react-modal-sheet-container')].some((el) => el.getBoundingClientRect().height > 0),
  );
  check('and it still opens the search', open2);
  await p.goBack({ waitUntil: 'commit' }).catch(() => {});
  await p.waitForTimeout(1500);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(8000);

  await page('Stock', () => tab('Stock'), 'Search your stock', 'Stock');
  await page(
    'Sales',
    async () => {
      await tab('Money');
      await p.locator('button[aria-label="All sales and receipts"]').locator('visible=true').first().click();
    },
    'Search sales',
    'Sales',
  );
  // Back from Sales is Money. (The tab bar hides while a list scrolls, so it is not tapped here.)
  await page('Money', async () => { await p.goBack(); await p.waitForTimeout(1500); }, 'Search customers', 'Money');

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/crash.png` }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
