/**
 * A DELIVERY ENDS ON WHAT WAS RECORDED.
 *
 * "Record delivery is bad after saving — get a professional record delivery page." After the save,
 * the load stayed on the page with its crosses (looking still editable) and "50 pack". Now the form
 * is put away and the page is the delivery as a paper — numbered lines, each fee, the rebate, the
 * total paid, what each item really cost — with print and share, Record another, and Done.
 *
 * The save is ANSWERED BY THE PROBE (`record_purchase` intercepted): a delivery moves stock, and the
 * stock ledger cannot be taken back. So this checks the page, and that what it sent is the load.
 *
 *     node scripts/probe-delivery-summary-ui.mjs [http://localhost:3100]
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
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e.stack ?? e).split('\n').slice(0, 3).join(' ')));
const sent = [];
await p.route('**/rest/v1/rpc/record_purchase*', (route) => {
  sent.push(JSON.parse(route.request().postData() ?? '{}'));
  return route.fulfill({ status: 200, contentType: 'application/json', body: '"00000000-0000-0000-0000-000000000000"' });
});
await p.route('**/rest/v1/rpc/record_supplier_empties*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }));
const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const text = async () => ((await top().innerText()) ?? '').replace(/\s+/g, ' ').replace(/₦/g, 'N');

const addItem = async (term, match, qty, price) => {
  await top().getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(2500);
  const search = p.locator('[role="dialog"] input').first();
  for (let i = 0; i < 5; i += 1) {
    await search.fill(term);
    await p.waitForTimeout(1200);
    if ((await search.inputValue()) === term) break;
  }
  await p.waitForTimeout(2500);
  await p.locator('[role="dialog"] [class*="ProductPicker_name"]', { hasText: match }).first().click();
  await p.waitForTimeout(2500);
  await top().getByLabel(/How many/i).first().fill(String(qty));
  await top().getByLabel(/Price per/i).first().fill(String(price));
  await p.waitForTimeout(600);
  await top().getByRole('button', { name: /Put it on the load/ }).click();
  await p.waitForTimeout(1200);
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(8000);
  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: /record a delivery|receive/i }).first().click();
  await p.waitForTimeout(4000);

  await addItem('Eva Big Water', /Eva Big Water/, 50, 2400);
  await addItem('Eva Small Water', /Eva Small Water/, 1, 1800);
  let t = await text();
  check('the load says "50 packs" and "1 pack"', /50 packs/.test(t) && /1 pack\b/.test(t), (t.match(/\d+ packs?/g) ?? []).join(', '));

  // Who it came from — the page asks before it records.
  await top().locator('#who-from').click();
  await p.waitForTimeout(2500);
  await p.locator('[role="dialog"]').getByText(/^Random$/).first().click();
  await p.waitForTimeout(1500);

  await top().getByLabel(/What for/i).first().fill('Delivery');
  await top().getByLabel(/How much/i).first().fill('5000');
  await top().getByRole('button', { name: /Add this fee/i }).click();
  await p.waitForTimeout(1000);

  await top().getByRole('button', { name: /Record this delivery/ }).click();
  await p.waitForTimeout(6000);
  t = await text();
  check('it sent the load: two lines', (sent[0]?.p_lines ?? []).length === 2, JSON.stringify(sent[0]?.p_lines ?? []).slice(0, 160));
  check('the page says the delivery is recorded', /Delivery recorded/.test(t), t.slice(0, 100));
  check('and the form is gone: no crosses, no "Record this delivery"',
    (await top().getByRole('button', { name: /Take .* off this load/ }).count()) === 0 &&
      (await top().getByRole('button', { name: /Record this delivery/ }).count()) === 0);
  const paper = ((await top().locator('[aria-label="How this will print"]').innerText().catch(() => '')) ?? '')
    .replace(/\s+/g, ' ').replace(/₦/g, 'N');
  check('the delivery as a paper: numbered lines with what each came to',
    /DELIVERY/.test(paper) && /1\. Eva Big Water/.test(paper) && /2\. Eva Small Water/.test(paper) && /N120,000/.test(paper),
    paper.slice(0, 200));
  check('the fee and the total paid on it', /Delivery\s*N5,000/.test(paper) && /Total paid\s*N126,800/.test(paper),
    (paper.match(/Total paid\s*\S+/) ?? ['none'])[0]);
  check('and what each really cost', /Each really cost/.test(paper));
  for (const w of ['Share', 'Send on WhatsApp', 'Send as picture', 'Print', 'Save as PDF']) {
    check(`offers ${w}`, (await top().getByRole('button', { name: new RegExp(`^${w}`) }).count()) > 0);
  }
  await p.screenshot({ path: `${SHOTS}/delivery-summary.png`, fullPage: true });

  await top().getByRole('button', { name: /Record another delivery/ }).click();
  await p.waitForTimeout(2000);
  t = await text();
  check('Record another starts a fresh, empty load', /Add what came in/.test(t) && !/Eva Big Water/.test(t), t.slice(0, 120));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/delivery-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  console.log('  page errors:', errors.slice(0, 3).join(' || '));
  failed += 1;
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
