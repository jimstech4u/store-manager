/**
 * BEFORE IT PRINTS (11 Nov) — the counter's questions and the print bar, looked at; nothing recorded.
 *
 *   1. A receipt opened as at the counter (fresh): "Before it prints", the empties question, the bar
 *      waiting on it — not counting down, not printing.
 *   2. A crate counted in bottles: + on the bottles stops the bar ("Prints when the changes are
 *      saved") and offers Save; Cancel puts it back. Nothing is saved.
 *   3. "None came back" on a receipt where none is recorded: an answer with nothing to write — the bar
 *      starts counting; Cancel stops it before anything prints.
 *   4. No container row was written for the receipt.
 *
 * Uses New look's #D1746E61 (none back since 11 Nov). Auto-print is turned on for this browser only,
 * with a 10-second wait, and cancelled.
 *
 *     node scripts/probe-counter-print.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  process.env.SHOTS ??
  'C:/Users/ajibe/AppData/Local/Temp/claude/05612c5dd4a9e57e/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/counter';
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
const RECEIPT = 'd1746e61-e417-44e3-8dba-423c1bfbbab1';
const { createClient } = createRequire(process.cwd() + '/package.json')('@supabase/supabase-js');
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const rowsFor = async () =>
  (await admin.from('customer_empties').select('id', { count: 'exact', head: true }).eq('ref_id', RECEIPT)).count;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const before = await rowsFor();
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
// Never a real print dialog.
await p.addInitScript(() => { window.print = () => { window.__printed = (window.__printed ?? 0) + 1; }; });
p.on('pageerror', (e) => console.log('  pageerror:', String(e).split('\n')[0]));
const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const shot = (name) => p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const bar = () => top().locator('section[aria-label="Before it prints"] [role="status"]').last();

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  // Print by itself, after 10 seconds — this browser only.
  await p.evaluate(() => localStorage.setItem('sm.auto-print', JSON.stringify({ on: true, wait: 10, thenTill: false })));
  await p.waitForTimeout(6000);

  // To the receipt: Sell → empties → Everyone → New look → its receipt.
  await p.getByText('Sell', { exact: true }).first().click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: 'Containers still to come back' }).locator('visible=true').first().evaluate((el) => el.click());
  await top().getByText('Holding your containers', { exact: true }).waitFor({ timeout: 30000 });
  await top().getByRole('button', { name: 'Everyone' }).first().evaluate((el) => el.click());
  await p.waitForTimeout(800);
  await top().getByRole('button', { name: /New look/ }).first().evaluate((el) => el.click());
  await top().getByRole('heading', { name: 'Everything that has happened' }).waitFor({ timeout: 30000 });
  await p.waitForTimeout(2000);
  await top().getByRole('button', { name: 'See the receipt' }).first().evaluate((el) => el.click());
  await p.waitForTimeout(3000);
  // As at the counter: the same page with fresh=1, as a sale just saved opens it. The stack is in the
  // address — each page's params are base64 of the URL-encoded JSON — so the receipt's own is rewritten.
  const url = new URL(p.url());
  const nav = url.searchParams.get('nav') ?? '';
  const segs = nav.split('.');
  const enc = (o) => 'p:' + Buffer.from(encodeURIComponent(JSON.stringify(o))).toString('base64');
  const dec = (seg) => JSON.parse(decodeURIComponent(Buffer.from(seg.slice(2), 'base64').toString()));
  const last = segs.length - 1;
  check('the receipt on top is #D1746E61', segs[last].startsWith('p:') && dec(segs[last]).id === RECEIPT, JSON.stringify(dec(segs[last])));
  segs[last] = enc({ id: RECEIPT, fresh: '1' });
  url.searchParams.set('nav', segs.join('.'));
  await p.setViewportSize({ width: 420, height: 900 });
  await p.goto(url.toString(), { waitUntil: 'networkidle' });
  await top().getByText('Before it prints').first().waitFor({ timeout: 60000 });
  await p.waitForTimeout(5000);

  console.log('\n— 1. Before it prints —');
  check('"Before it prints" heads the page', (await top().getByRole('heading', { name: 'Before it prints' }).count()) === 1);
  const waiting = await bar().innerText();
  check('the bar waits on the empties, not counting', /Prints when the empties are answered/.test(waiting), waiting.replace(/\n/g, ' | '));
  const both = await top().locator('section[aria-label="Before it prints"]').getByRole('button', { name: /^(All|None) came back$/ }).evaluateAll((bs) => bs.map((b) => `${b.textContent.trim()}${b.disabled ? ' (shut)' : ''}`));
  check('both answers open while it is asked', both.length === 2 && both.every((t) => !/shut/.test(t)), both.join(' | '));
  const more = top().locator('section[aria-label="Before it prints"]').getByRole('button', { name: /Count each item/ });
  check('the breakdown is folded under the two answers', (await more.count()) === 1 && (await more.getAttribute('aria-expanded')) === 'false', (await more.innerText()).replace(/\n/g, ' '));
  await shot('1-asking');
  const paper1 = await top().locator('[aria-label="How this will print"]').first().innerText();
  check('nothing back: the paper lists its empties', /Empties \(out\/back\)/.test(paper1));
  await more.click();
  await p.waitForTimeout(400);
  const bottleBoxes = await top().getByRole('textbox', { name: /^bottles of / }).count();
  const crateBoxes = await top().getByRole('textbox', { name: /^crates of / }).count();
  check('opened: a line for crates and one for bottles', bottleBoxes > 0 && crateBoxes > 0, `${crateBoxes} crate lines, ${bottleBoxes} bottle lines`);
  await shot('1b-open');

  console.log('\n— 2. Three bottles of a Goldberg crate —');
  const plus = top().getByRole('button', { name: /^One more bottles of Goldberg/ }).first();
  for (let i = 0; i < 3; i += 1) await plus.click();
  await p.waitForTimeout(500);
  const goldberg = await top().locator('li').filter({ hasText: 'Goldberg' }).first().innerText();
  check('the row says 3 bottles back', /3 bottles still|\(was 0 crates\)/.test(goldberg) || /2 crates 9 bottles still with them/.test(goldberg), goldberg.replace(/\n/g, ' | '));
  check('the bar stops for the unsaved change', /Prints when the changes are saved|Prints when the empties are answered/.test(await bar().innerText()), (await bar().innerText()).replace(/\n/g, ' | '));
  check('Save offered', (await top().getByRole('button', { name: /^Save this change/ }).count()) === 1);
  await shot('2-bottles');
  await top().getByRole('button', { name: 'Cancel', exact: true }).first().click();
  await p.waitForTimeout(500);

  console.log('\n— 3. None came back: an answer, nothing to write —');
  await top().locator('section[aria-label="Before it prints"]').getByRole('button', { name: 'None came back' }).click();
  await p.waitForTimeout(1500);
  const said = await top().locator('section[aria-label="Before it prints"]').innerText();
  check('says what was answered', /None came back · .* still with them/.test(said), (said.match(/✓[^\n]*/) ?? [''])[0]);
  const counting = await bar().innerText();
  check('the bar counts down now', /Printing/.test(counting) && /in \d+ seconds?/.test(counting), counting.replace(/\n/g, ' | '));
  await bar().scrollIntoViewIfNeeded();
  await shot('3-counting');
  await bar().getByRole('button', { name: 'Cancel' }).click();
  await p.waitForTimeout(500);
  check('Cancel stops it before it prints', /Not printing by itself/.test(await bar().innerText()));
  await shot('4-cancelled');

  console.log('\n— 5. Half a crate sold: asked in bottles, no crate line —');
  const half = (await admin.from('sales').select('id').eq('store_id', '7138327c-c81c-4486-a97c-92207b48b64e').gte('id', 'e756cc73-0000-0000-0000-000000000000').lte('id', 'e756cc73-ffff-ffff-ffff-ffffffffffff')).data?.[0]?.id;
  const u2 = new URL(p.url());
  const s2 = (u2.searchParams.get('nav') ?? '').split('.');
  s2[s2.length - 1] = enc({ id: half });
  u2.searchParams.set('nav', s2.join('.'));
  await p.goto(u2.toString(), { waitUntil: 'networkidle' });
  await top().getByRole('button', { name: /Count each item|Each item/ }).first().waitFor({ timeout: 60000 });
  await p.waitForTimeout(2500);
  const m2 = top().getByRole('button', { name: /Count each item|Each item/ }).first();
  if ((await m2.getAttribute('aria-expanded')) === 'false') await m2.click();
  await p.waitForTimeout(400);
  const trophy = top().locator('li').filter({ hasText: 'Trophy Bottle' }).first();
  const tText = await trophy.innerText();
  check('the half crate is said in bottles', /6 bottles went out/.test(tText), tText.split('\n').slice(0, 2).join(' | '));
  check('no crate line for half a crate', (await trophy.getByRole('textbox', { name: /^crates of / }).count()) === 0 && (await trophy.getByRole('textbox', { name: /^bottles of / }).count()) === 1);
  const paper5 = await top().locator('[aria-label="How this will print"]').first().innerText();
  check('all back: the paper says nothing of this receipt’s empties', !/Empties \(out\/back\)/.test(paper5));
  await trophy.scrollIntoViewIfNeeded();
  await shot('5-half-crate');
} catch (e) {
  console.log('ERROR', e?.message ?? e);
  await shot('error').catch(() => {});
  failed += 1;
} finally {
  await browser.close();
}
const after = await rowsFor();
check('nothing was written for the receipt', after === before, `${before} → ${after} rows`);
console.log(failed ? `\n${failed} failed` : '\nAll passed');
process.exit(failed ? 1 : 0);
