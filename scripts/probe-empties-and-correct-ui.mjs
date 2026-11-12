/**
 * EMPTIES AND CORRECTING A RECEIPT (11 Nov) — looked at, never written.
 *
 *   1. The Empties list: figures at the top, Still out / All back / Everyone.
 *   2. One customer's empties: Still with them settled where it is read, the history with Undo.
 *   3. A receipt: its own empties as out and back with − and +, and "Empties" on the paper.
 *   4. Correcting it: the till's box, its compact lines, and the empties with it.
 *
 * Nothing is tapped that records: no All back, no Save, no Correct. Screenshots go to SHOTS.
 *
 *     node scripts/probe-empties-and-correct-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  process.env.SHOTS ??
  'C:/Users/ajibe/AppData/Local/Temp/claude/05612c5dd4a9e57e/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/empties';
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
const NEW_LOOK = 'e718d4b5-3560-4576-850a-f6504ca8f52f';
const RECEIPT = 'd1746e61-e417-44e3-8dba-423c1bfbbab1';

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
p.on('pageerror', (e) => console.log('  pageerror:', String(e).split('\n')[0]));
p.on('response', async (r) => {
  if (!r.url().includes('ensure_store_settings')) return;
  const body = await r.text().catch(() => '');
  console.log('  ensure_store_settings:', r.status(), (body.match(/"receipt_logo_path":[^,]*/) ?? ['no logo field'])[0]);
});
const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const shot = (name, full = true) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
/** Opens a page by pushing it, as a tap on a row would. */
const open = async (route, params) => {
  await p.evaluate(
    ([r, q]) => window.__axNav?.push?.(r, q),
    [route, params],
  );
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(7000);

  // ── 1. The list ──
  console.log('\n— Empties —');
  // The Sell tab's header: "Containers still to come back".
  await p.getByText('Sell', { exact: true }).first().click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: 'Containers still to come back' }).locator('visible=true').first().evaluate((el) => el.click());
  await top().getByText('Holding your containers', { exact: true }).waitFor({ timeout: 30000 });
  await p.waitForTimeout(2000);
  check('figures at the top', (await top().getByText('Holding your containers', { exact: true }).count()) > 0);
  check('who to show: Still out / All back / Everyone', (await top().getByRole('button', { name: /^Still out/ }).count()) > 0);
  await shot('1-list');

  // ── 2. New look ──
  // New look is all back on paper, so it is under Everyone, not Still out.
  await top().getByRole('button', { name: 'Everyone' }).first().evaluate((el) => el.click());
  await p.waitForTimeout(800);
  await top().getByRole('button', { name: /New look/ }).first().evaluate((el) => el.click());
  await top().getByRole('heading', { name: 'Everything that has happened' }).waitFor({ timeout: 30000 });
  await p.waitForTimeout(2500);
  check('history has Undo on returns', (await top().getByRole('button', { name: 'Undo' }).count()) > 0);
  check('history links receipts', (await top().getByRole('button', { name: 'See the receipt' }).count()) > 0);
  await shot('2-customer');

  // ── 3. Its receipt ──
  await top().getByRole('button', { name: 'See the receipt' }).first().evaluate((el) => el.click());
  await p.waitForTimeout(6000);
  const pageText = await top().innerText();
  // The breakdown is folded (11 Nov): its dropdown says the totals, "0 of 8 crates back".
  check('the receipt shows its empties out and back', /\bof [\d /]+ \w+ back\b/.test(pageText), (pageText.match(/[^\n]*\bof [\d /]+ \w+ back\b/) ?? [''])[0].trim());
  const paper = await top().locator('[aria-label="How this will print"]').first().innerText().catch(() => '');
  // One empties section (0281): Still with you, each line out · in · left.
  check(
    'the paper says Still with you as out · in · left, and nothing else of empties',
    /Still with you[\s\S]{0,200}?out\s+in\s+left/.test(paper) && !/Empties \(out\/back\)/.test(paper),
    paper.split('\n').filter((l) => /Still with you|crate/i.test(l)).slice(0, 4).map((l) => l.trim()).join(' | '),
  );
  const img = await top().locator('[aria-label="How this will print"] img').first().evaluate((i) => ({ done: i.complete, w: i.naturalWidth, src: i.src.slice(-40) })).catch(() => null);
  console.log('  logo on the paper:', JSON.stringify(img));
  console.log('  logo imgs anywhere:', await p.evaluate(() => [...document.querySelectorAll('img')].filter((i) => i.src.includes('receipt-logo')).map((i) => `${i.closest('[aria-label]')?.getAttribute('aria-label')}:${i.naturalWidth}`).join(', ')));
  console.log('  previews:', await p.evaluate(() => document.querySelectorAll('[aria-label="How this will print"]').length));
  console.log('  paper ends:', paper.split('\n').slice(-14).join(' / '));
  console.log('  buttons:', (await top().getByRole('button').allInnerTexts()).map((t) => t.trim()).filter(Boolean).slice(0, 30).join(' | '));
  await shot('3-receipt');
  // The receipt's own empties: two buttons saying what they do, the recorded one ticked and shut.
  const block = top().locator('section').filter({ has: p.getByRole('button', { name: /^(All|None) came back$/ }) }).first();
  await block.screenshot({ path: `${SHOTS}/3-receipt-empties.png` });
  const ticked = await block.getByRole('button', { name: /^(All|None) came back$/ }).evaluateAll((bs) => bs.map((b) => `${b.textContent.trim()}${b.disabled ? ' (shut)' : ''}`));
  check('the empties are two buttons, the recorded answer ticked and shut', ticked.length === 2 && ticked.some((t) => /shut/.test(t)), ticked.join(' | '));

  // ── 4. Correcting it ──
  const correct = top().getByRole('button', { name: 'Something on this is wrong' }).first();
  if (await correct.count()) {
    await correct.evaluate((el) => el.click());
    await top().getByText('Correct this receipt').first().waitFor({ timeout: 30000 });
    await p.waitForTimeout(4000);
    check('the till\u2019s own box', (await top().getByRole('searchbox', { name: /Add an item/ }).count()) > 0 || (await top().locator('input[placeholder^="Type to add"]').count()) > 0);
    check('the empties with it', (await top().getByRole('heading', { name: 'Empties with this receipt' }).count()) > 0);
    await shot('4-correct');
    await top().locator('section[aria-label="Empties with this receipt"]').screenshot({ path: `${SHOTS}/4-correct-empties.png` });
    const said = await top().locator('section[aria-label="Empties with this receipt"]').innerText();
    check('the empties say what went out, not 0', !/\b0 crates went out/.test(said), said.split('\n').filter((l) => /went out/.test(l)).join(' | '));
  } else {
    check('a way to correct the receipt', false, 'no Correct button found');
  }
} catch (e) {
  console.log('ERROR', e?.message ?? e);
  await shot('error').catch(() => {});
  failed += 1;
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} failed` : '\nAll passed');
process.exit(failed ? 1 : 0);
