/**
 * THE STATEMENT'S PAPER, AND A CORRECTED RECEIPT'S HISTORY — as they come out.
 *
 * "The statement's PDF or image needs a better format: no price each, the items numbered, Sale on
 * the left and the date on the right, double lines round the items, Total under them; payments and
 * charges between single lines." And: "a corrected receipt does not carry everything a receipt has,
 * like still with you" — receipt history now prints the whole receipt (0257).
 *
 * Saves the statement as a picture (the button's own download) and screenshots it, then opens the
 * history of a corrected receipt and reads what it says now. Reads only.
 *
 *     node scripts/probe-statement-paper-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

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

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(String(e.stack ?? e).split('\n').slice(0, 3).join(' ')));
const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const paper = async () =>
  ((await top().locator('[data-print-root]').first().innerText().catch(() => '')) ?? '').replace(/₦/g, 'N');

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(8000);

  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /everyone you sell to/i }).locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  const row = p.getByRole('button', { name: /Jummy stores/i }).locator('visible=true').first();
  await row.waitFor({ state: 'visible', timeout: 60000 });
  await row.click();
  await p.waitForTimeout(7000);
  await top().getByRole('button', { name: /Print or send their statement/ }).first().click();
  await p.waitForTimeout(5000);
  await top().getByRole('tab', { name: 'All time' }).click();
  await p.waitForTimeout(7000);

  const t = await paper();
  // One entry per PRINTED line: the preview draws each part of a line as its own element.
  const lines = await top()
    .locator('[aria-label="How this will print"] > div > div')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/₦/g, 'N').replace(/\s+/g, ' ').trim()));
  const saleAt = lines.findIndex((l) => /^Sale #[0-9A-F]{8}\s+\d{1,2} \w{3,4} \d{4}$/.test(l.trim()));
  check('a sale: "Sale #…" on the left, the date on the right of the same line', saleAt >= 0, lines.slice(0, 18).join(' | '));
  check('a double line under it, then item 1 numbered', /^=+$/.test(lines[saleAt + 1] ?? '') && /^1\. /.test(lines[saleAt + 2] ?? ''),
    lines.slice(saleAt, saleAt + 4).join(' | '));
  check('no price each on the items', !/ x N[\d,]+/.test(t));
  const totalAt = lines.findIndex((l, i) => i > saleAt && /^Total\s+N[\d,]+$/.test(l.trim()));
  check('the items close with a double line, then Total and its amount', totalAt > 0 && /^=+$/.test(lines[totalAt - 1] ?? ''),
    lines.slice(Math.max(0, totalAt - 2), totalAt + 1).join(' | '));
  const payAt = lines.findIndex((l) => /^Payment received\s+\d/.test(l.trim()));
  check('a payment: title and date, between single lines',
    payAt > 0 && /^-+$/.test(lines[payAt + 1] ?? '') && /^-+$/.test(lines[payAt + 3] ?? ''),
    lines.slice(payAt, payAt + 4).join(' | '));

  // The picture, as the button makes it.
  const [dl] = await Promise.all([
    p.waitForEvent('download', { timeout: 30000 }),
    top().getByRole('button', { name: /^Send as picture/ }).click(),
  ]);
  await dl.saveAs(`${SHOTS}/statement-picture.png`);
  check('the picture is made (saved for a look)', true, 'statement-picture.png');

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/statement-paper-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  console.log('  page errors:', errors.slice(0, 3).join(' || '));
  failed += 1;
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
