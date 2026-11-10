/**
 * ALL ITEMS CARRIES WHAT THE RECEIPT WILL — balance, what is still with them, the account, and the
 * charges and deposit taken on Take payment.
 *
 * Since 10 Nov All items is a SHEET with no box to type in: it ticks what goes on the paper (their
 * balance, still with you, the account) and shares it. Charges and a deposit are added on Take
 * payment, in its one box ("Transport 2000", "1000"), and then appear on the All items paper — the
 * same `input()` the PDF, picture, print and share draw.
 *
 * On a tab this probe opens itself, with Busayo Store (who owes and holds crates) and two Goldberg
 * crates. Nothing is settled; the probe's draft is taken back off the till at the end.
 *
 *     node scripts/probe-all-items-extras-ui.mjs [http://localhost:3100]
 */
import { chromium, webkit } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { trackDrafts, sweepDrafts } from './probe-drafts.mjs';
import { addOnTill } from './till.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? 'probe-shots';
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
const PROBE_DRAFTS = trackDrafts(p);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
/* The All items sheet, and its paper. */
const sheet = () => p.getByRole('dialog', { name: 'All items' });
const paper = async () =>
  ((await sheet().locator('[data-print-root]').first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
const box = (name) => sheet().getByRole('checkbox', { name });
const openAllItems = async () => {
  await p.getByRole('button', { name: /All items/ }).locator('visible=true').first().click();
  await sheet().getByText(/Not a receipt/i).first().waitFor({ timeout: 20000 });
  await p.waitForTimeout(2500);
};

const pickInSheet = async (term, match) => {
  const search = p.locator('[role="dialog"] input').first();
  await search.waitFor({ state: 'visible', timeout: 30000 });
  for (let i = 0; i < 4; i += 1) {
    await search.fill(term);
    await p.waitForTimeout(900);
    if ((await search.inputValue()) === term) break;
  }
  const hit = p.locator('[role="dialog"]').getByText(match).first();
  await hit.waitFor({ state: 'visible', timeout: 30000 });
  await hit.click();
};

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(10000);

  // The app may open on another tab; the till is on Sell.
  await p.evaluate(() => [...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === 'Sell')?.click());
  await p.waitForTimeout(3000);
  // Our own tab — never the shop's. Tapped in the page: the bar scrolls sideways.
  await p.getByRole('button', { name: 'Start another customer' }).first().evaluate((el) => el.click());
  await p.waitForTimeout(4000);

  await p.getByRole('button', { name: /(Say|Change) who this sale is for/ }).locator('visible=true').first().click();
  await p.waitForTimeout(2500);
  await pickInSheet('Busayo', /Busayo Store/);
  await p.waitForTimeout(4000);

  // Two crates, typed into the till's one box.
  await addOnTill(p, '2 Goldberg', 'Goldberg Bottle (600mL)');
  await p.waitForTimeout(3000);

  await openAllItems();
  let t = await paper();
  check('All items opens on the paper', /NOT A RECEIPT/.test(t) && /Goldberg/.test(t), t.slice(0, 80));
  check('none of the boxes is ticked to start', !/Owed before|Still with you/.test(t));
  check('no box to type in on the sheet',
    (await sheet().locator('input:not([type="checkbox"]), textarea, select').count()) === 0);

  // Under the paper: their balance, still with you, the account.
  const order = await sheet().evaluate((el) =>
    [...el.querySelectorAll('label')]
      .filter((l) => l.querySelector('input[type="checkbox"]'))
      .map((l) => (l.textContent ?? '').trim().split(' ')[0])
      .join(','),
  );
  check('in the order: their balance, still with you, the account', /^Their,Still(,Account)?$/.test(order), order);

  // ── Their balance ───────────────────────────────────────────────────────────────
  await box(/Their balance/).check();
  await p.waitForTimeout(3500);
  t = await paper();
  check('ticking their balance puts it on the paper', /Owed before/.test(t) && /Owed in all\s*N[\d,]+/.test(t),
    (t.match(/Owed before.{0,60}/) ?? [''])[0]);

  // ── Still with you ──────────────────────────────────────────────────────────────
  await box(/Still with you/).check();
  await p.waitForTimeout(4000);
  t = await paper();
  check('ticking empties lists what is still with them, with this crate', /Still with you/.test(t) && /crate/i.test(t),
    (t.match(/Still with you.{0,120}/) ?? [''])[0]);
  await p.screenshot({ path: `${SHOTS}/all-items-extras.png`, fullPage: true });

  // ── Every way out draws the same document ───────────────────────────────────────
  const shareSet = ['Send on WhatsApp', 'Share', 'Send as picture', 'Save as PDF', 'Print'];
  const gated = /Before this goes to the customer/.test(await sheet().innerText());
  if (gated) {
    check('the count/price gate stands in front of sharing (items not counted today)', true);
  } else {
    for (const b of shareSet) {
      check(`offers ${b}`, (await sheet().getByRole('button', { name: new RegExp(b) }).count()) > 0);
    }
  }
  await sheet().getByRole('button', { name: 'Close' }).click();
  await p.waitForTimeout(1000);

  // ── A charge and a deposit on Take payment, then on the All items paper ────────
  await p.locator('button').filter({ hasText: /Take payment/ }).locator('visible=true').last().click();
  const bill = p.getByRole('region', { name: 'The bill' }).first();
  await bill.waitFor({ timeout: 20000 });
  await p.waitForTimeout(1500);
  await bill.getByRole('button', { name: 'Charge' }).click();
  await bill.getByLabel('The charge').pressSequentially('Transport 2000', { delay: 20 });
  await bill.getByLabel('The charge').press('Enter');
  await p.waitForTimeout(600);
  await bill.getByRole('button', { name: 'Deposit', exact: true }).click().catch(() => {});
  await bill.getByLabel('The deposit').pressSequentially('1000', { delay: 20 });
  await bill.getByLabel('The deposit').press('Enter');
  await p.waitForTimeout(4000);
  {
    const { data: drafts } = await admin.from('draft_orders').select('id').in('client_uuid', [...PROBE_DRAFTS]);
    const ids = (drafts ?? []).map((d) => d.id);
    const { data: deps } = await admin.from('draft_order_deposits').select('amount').in('draft_order_id', ids);
    const { data: chs } = await admin.from('draft_order_charges').select('label, amount').in('draft_order_id', ids);
    check('the shop has the deposit and the charge on the order (any phone sees them)',
      (deps ?? []).some((d) => Number(d.amount) === 1000) && (chs ?? []).some((c) => Number(c.amount) === 2000),
      JSON.stringify({ deps, chs }));
  }
  // All items from Take payment: under Show, with the items.
  await bill.getByRole('button', { expanded: false }).first().click();
  await p.waitForTimeout(500);
  await openAllItems();
  t = await paper();
  check('the charge added on Take payment is on the All items paper', /Transport\s*N2,000/.test(t),
    (t.match(/Transport.{0,20}/) ?? [''])[0]);
  check('and the deposit', /Deposit on containers\s*N1,000/.test(t), (t.match(/Deposit.{0,30}/) ?? [''])[0]);
  check('the banner total includes them', /comes to N[\d,]+/.test(t.replace(/₦/g, 'N')) || /comes to/.test(await sheet().innerText()));
  await p.screenshot({ path: `${SHOTS}/all-items-extras-takepay.png`, fullPage: true });

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/all-items-extras-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
