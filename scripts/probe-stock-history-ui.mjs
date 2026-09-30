/**
 * AN ITEM'S STOCK HISTORY READS ON A PHONE.
 *
 * "stock history ui is bad" — four columns side by side left the middle one a few characters wide:
 * the date broke a word to a line, "Opening balance" was drawn over the shelf figure, a full email
 * stood for the person, and an opening offered "See the record" that went nowhere.
 *
 * For three items — one sold all day, one only opened, one with a count that matched — this checks
 * that no entry's text overlaps another's, the date sits on one line, the person is a name, "See the
 * receipt" is on sales only, and a matched count says so.
 *
 *     node scripts/probe-stock-history-ui.mjs [http://localhost:3100]
 */

import { chromium, webkit } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad';
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
const PROBE_DRAFTS = trackDrafts(p);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const tab = async (label) => {
  await p.evaluate(() => { for (const b of document.querySelectorAll('.navstack-column-body')) b.scrollTop = 0; });
  await p.waitForTimeout(800);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(2500);
};
const openHistory = async (search, name) => {
  await tab('Stock');
  await p.getByRole('button', { name: /Search your stock/ }).locator('visible=true').first().click();
  await p.waitForTimeout(1500);
  await p.keyboard.type(search);
  await p.waitForTimeout(3500);
  await p.locator('.react-modal-sheet-container').getByText(name, { exact: false }).locator('visible=true').first().click();
  await p.waitForTimeout(4000);
  await p.getByText(/Stock history|Last changed/i).locator('visible=true').first().click();
  await p.waitForTimeout(4000);
};

/** Every visible entry: its text boxes, and whether any two of them overlap. */
const entries = () =>
  p.evaluate(() => {
    const active = document.querySelector('.group-stack-container[data-active="true"]');
    const pages = [...(active?.querySelectorAll('.navstack-page') ?? [])];
    const page = pages[pages.length - 1];
    const rows = [...(page?.querySelectorAll('ol > li') ?? [])].filter((li) => li.getBoundingClientRect().top < innerHeight);
    return rows.slice(0, 6).map((li) => {
      const parts = [...li.querySelectorAll('span, button, strong')].filter((el) => el.children.length === 0 && (el.textContent ?? '').trim());
      const boxes = parts.map((el) => el.getBoundingClientRect());
      let overlap = false;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (x > 2 && y > 2 && !(parts[i].contains(parts[j]) || parts[j].contains(parts[i]))) overlap = true;
        }
      }
      const who = li.querySelector('[class*="who"]');
      const whoBox = who?.getBoundingClientRect();
      const lineHeight = who ? parseFloat(getComputedStyle(who).lineHeight) || 18 : 18;
      return {
        text: (li.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 110),
        overlap,
        whoLines: whoBox ? Math.round(whoBox.height / lineHeight) : 0,
        email: /@/.test(li.textContent ?? ''),
        link: [...li.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()),
        kind: (li.querySelector('[class*="what"]')?.textContent ?? '').trim(),
      };
    });
  });

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 60000 });
  await p.waitForTimeout(8000);

  for (const [search, name, file] of [
    ['American Cola', 'American Cola PET', 'history-american-cola'],
    ['33 Bottle', '33 Bottle', 'history-33-bottle'],
    ['Chivita Active Zest', 'Chivita Active Zest Can', 'history-chivita'],
  ]) {
    console.log(name);
    await openHistory(search, name);
    const rows = await entries();
    await p.screenshot({ path: `${SHOTS}/${file}.png` });
    check('entries are shown', rows.length > 0, `${rows.length}`);
    check('no text is drawn over other text', rows.every((r) => !r.overlap), rows.filter((r) => r.overlap).map((r) => r.text).join(' | '));
    check('the date and person sit on one line', rows.every((r) => r.whoLines <= 1), rows.map((r) => r.whoLines).join(','));
    check('a person is a name, not an email', rows.every((r) => !r.email));
    check('"See the receipt" on sales only', rows.every((r) => (r.kind.startsWith('Sold') ? true : r.link.length === 0)), rows.map((r) => `${r.kind}:${r.link.join('/')}`).join(' | '));
    if (name.startsWith('Chivita')) {
      check('the matched count says Matched', rows.some((r) => /^Counted/.test(r.kind) && /Matched/.test(r.text)), rows.map((r) => r.text).join(' | '));
    }
    await p.goBack({ waitUntil: 'commit' }).catch(() => {});
    await p.waitForTimeout(1500);
    await p.goBack({ waitUntil: 'commit' }).catch(() => {});
    await p.waitForTimeout(1500);
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/history-crash.png` }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
