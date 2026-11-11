/**
 * WAITING FOR YOU, PRINTING, AND WHAT THE AGENT MAY DO (11 Nov).
 *
 *   1. Waiting for you no longer sends the owner's own entries back to the owner (0278): whatever is
 *      left names who made it, and no row is the signed-in owner's.
 *   2. Printing shows the shop's logo on file AND in the receipt preview; on a wide screen the
 *      preview sits beside the settings.
 *   3. A receipt opened from All sales and receipts carries the logo at its head.
 *   4. What the agent may do lists everything we switched on (0279), all on; a switch goes off and back
 *      on, and the count follows — leaving the shop as it was.
 *
 * Records nothing in the shop's books. Screenshots go to SHOTS.
 *
 *     node scripts/probe-review-print-agent-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  process.env.SHOTS ??
  'C:/Users/ajibe/AppData/Local/Temp/claude/05612c5dd4a9e57e/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/review-print';
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

async function signIn(viewport, mobile) {
  const p = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
  p.on('pageerror', (e) => console.log('  pageerror:', String(e).split('\n')[0]));
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(7000);
  return p;
}

const top = (p) => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const tap = (loc) => loc.first().evaluate((el) => el.click());
const toTab = async (p, name) => {
  await p.evaluate((n) => {
    const items = [...document.querySelectorAll('.nav-item, nav a, nav button')];
    items.find((el) => el.textContent.trim() === n)?.click();
  }, name);
  await p.waitForTimeout(2500);
};
const back = async (p) => {
  await tap(top(p).getByRole('button', { name: /^Back$|Go back/ }));
  await p.waitForTimeout(1500);
};

try {
  const p = await signIn({ width: 390, height: 844 }, true);
  const ownerName = env.SAMPLE_EMAIL.split('@')[0];

  // ── 1. Waiting for you ──
  console.log('\n— Waiting for you —');
  await toTab(p, 'More');
  await tap(top(p).getByRole('button', { name: 'Things waiting for you' }));
  await top(p).getByText(/Nothing to check|to check/).first().waitFor({ timeout: 30000 });
  await p.waitForTimeout(1500);
  const sub = await top(p).locator('header').first().innerText();
  const left = Number((sub.match(/(\d+) to check/) ?? [])[1] ?? 0);
  check('the owner’s own 742 entries are no longer waiting', left < 50, sub.replace(/\s+/g, ' ').trim());
  const makers = await top(p).locator('[class*="who"]').allInnerTexts();
  check('no row is the signed-in owner’s own', !makers.some((m) => m.trim() === ownerName), [...new Set(makers)].join(', ') || 'none');
  await p.screenshot({ path: `${SHOTS}/1-waiting.png`, fullPage: true });
  await back(p);

  // ── 2. Printing ──
  console.log('\n— Printing —');
  await tap(top(p).getByRole('button', { name: 'Receipt and printer' }));
  await top(p).getByRole('heading', { name: 'How a receipt comes out' }).waitFor({ timeout: 30000 });
  await p.waitForTimeout(2500);
  const thumb = await top(p).locator('img[alt="Your logo"]').evaluate((i) => i.complete && i.naturalWidth > 0).catch(() => false);
  check('the logo on file is shown', thumb);
  const inPreview = await top(p)
    .locator('[aria-label="How this will print"] img')
    .evaluate((i) => i.complete && i.naturalWidth > 0)
    .catch(() => false);
  check('the receipt preview starts with the logo', inPreview);
  check('the fine-tuning is folded away', (await top(p).locator('details').count()) <= 1);
  await p.screenshot({ path: `${SHOTS}/2-printing-phone.png`, fullPage: true });
  await back(p);

  // ── 4. What the agent may do ──
  console.log('\n— What the agent may do —');
  await tap(top(p).getByRole('button', { name: 'Store Manager on WhatsApp' }).or(top(p).getByRole('button', { name: 'Ask the shop from your chats' })));
  await p.waitForTimeout(2000);
  await tap(top(p).getByRole('button', { name: 'What the agent may do' }));
  await top(p).getByText(/switched on/).first().waitFor({ timeout: 30000 });
  await p.waitForTimeout(1000);
  const read = async () => {
    const t = await top(p).locator('header').first().innerText();
    const m = t.match(/(\d+) of (\d+) switched on/);
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  };
  const [on0, total] = await read();
  check('everything we offer is listed, and on', total >= 200 && on0 === total, `${on0} of ${total}`);
  const sw = top(p).getByRole('switch').first();
  const name = await sw.getAttribute('aria-label');
  await sw.evaluate((el) => el.click());
  await p.waitForTimeout(2500);
  const [on1] = await read();
  check(`switching "${name}" off counts one fewer`, on1 === on0 - 1, `${on1}`);
  await p.screenshot({ path: `${SHOTS}/4-agent-switch-off.png` });
  await sw.evaluate((el) => el.click());
  await p.waitForTimeout(2500);
  const [on2] = await read();
  check('and back on, as it was', on2 === on0, `${on2}`);
  await top(p).getByRole('button', { name: 'Changes records' }).evaluate((el) => el.click());
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${SHOTS}/4-agent-changes.png`, fullPage: true });

  // ── 2b. Printing, wide ──
  const w = await signIn({ width: 1440, height: 900 }, false);
  // The SideBar from 801px: its rows are found by their words.
  await w.getByText('More', { exact: true }).first().click();
  await w.waitForTimeout(2500);
  await w.screenshot({ path: `${SHOTS}/2-wide-more.png` });
  await tap(top(w).getByRole('button', { name: 'Receipt and printer' }));
  await top(w).getByRole('heading', { name: 'How a receipt comes out' }).waitFor({ timeout: 30000 });
  await w.waitForTimeout(2500);
  const [a, b] = await Promise.all([
    top(w).getByRole('heading', { name: 'Printer on this device' }).boundingBox(),
    top(w).getByRole('heading', { name: 'How a receipt comes out' }).boundingBox(),
  ]);
  check('wide: the preview sits beside the settings', !!a && !!b && b.x > a.x + 300 && Math.abs(b.y - a.y) < 80);
  await w.screenshot({ path: `${SHOTS}/2-printing-wide.png` });

  // ── 3. A receipt: Money → All sales and receipts → the newest ──
  console.log('\n— A receipt —');
  await w.getByText('Money', { exact: true }).first().click();
  await w.waitForTimeout(3000);
  await tap(w.getByRole('button', { name: 'All sales and receipts' }).locator('visible=true'));
  await w.waitForTimeout(5000);
  await tap(w.locator('ul[data-grid] li button').locator('visible=true'));
  await w.waitForTimeout(6000);
  const onReceipt = await w
    .locator('[aria-label="How this will print"] img')
    .locator('visible=true')
    .first()
    .evaluate((i) => i.complete && i.naturalWidth > 0)
    .catch(() => false);
  check('a receipt starts with the logo', onReceipt);
  await w.screenshot({ path: `${SHOTS}/3-receipt.png`, fullPage: true });
} catch (e) {
  console.log('ERROR', e?.message ?? e);
  failed += 1;
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : '\nAll passed');
process.exit(failed ? 1 : 0);
