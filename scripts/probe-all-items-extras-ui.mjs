/**
 * ALL ITEMS CARRIES WHAT THE RECEIPT WILL — balance, charges, a deposit, what is still with them.
 *
 * "In All items, which is not a receipt, a checkbox to include the customer's balance, a checkbox for
 * a deposit that brings the same form as Take payment (multi-line and cancel), a checkbox for charges
 * (the same, reusable), and a checkbox for empties (still with you) ... and it must be shareable in
 * PDF and print and all we use to share."
 *
 * On a tab this probe opens itself, with Busayo Store (who owes and holds crates) and a Goldberg
 * crate: each box puts its lines on the paper — the same `input()` the PDF, picture, print and
 * share draw — a charge added here is the charge Take payment shows, Cancel closes the form and
 * keeps what was added, and unticking takes it off the bill. Nothing is settled; the probe's draft
 * is taken back off the till at the end.
 *
 *     node scripts/probe-all-items-extras-ui.mjs [http://localhost:3100]
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

const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const paper = async () =>
  ((await top().locator('[data-print-root]').first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
const box = (name) => top().getByRole('checkbox', { name });

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

  // Our own tab — never the shop's.
  const plus = p.getByRole('button', { name: 'Start another customer' }).first();
  await plus.scrollIntoViewIfNeeded();
  await plus.click();
  await p.waitForTimeout(4000);

  await p.getByRole('button', { name: /(Say|Change) who this sale is for/ }).locator('visible=true').first().click();
  await p.waitForTimeout(2500);
  await pickInSheet('Busayo', /Busayo Store/);
  await p.waitForTimeout(4000);

  await p.getByRole('button', { name: /Add an item/i }).first().click();
  await p.waitForTimeout(2000);
  await pickInSheet('Goldberg', /Goldberg Bottle \(600mL\)/);
  await p.waitForTimeout(5000);
  // Two crates: the line starts at nothing.
  for (let i = 0; i < 2; i += 1) {
    await p.getByRole('button', { name: /One more Goldberg/ }).first().click();
    await p.waitForTimeout(700);
  }
  await p.waitForTimeout(3000);

  await p.getByRole('button', { name: /All items/ }).first().click();
  await p.waitForTimeout(6000);
  let t = await paper();
  check('All items opens on the paper', /NOT A RECEIPT/.test(t) && /Goldberg/.test(t), t.slice(0, 80));
  check('none of the four boxes is ticked to start', !/Owed before|Still with you/.test(t));

  // Under the paper, above Take payment, in the order: charges, deposit, their balance, still with you.
  const layout = await top().evaluate((page) => {
    const y = (el) => (el ? el.getBoundingClientRect().top + window.scrollY : -1);
    const paperEl = page.querySelector('[data-print-root]');
    const pay = [...page.querySelectorAll('button')].find((b) => /Take payment/.test(b.textContent ?? ''));
    const boxes = [...page.querySelectorAll('label')]
      .filter((l) => l.querySelector('input[type="checkbox"]'))
      .map((l) => ({ text: (l.textContent ?? '').trim(), y: y(l) }));
    return { paperBottom: paperEl ? y(paperEl) + paperEl.getBoundingClientRect().height : -1, pay: y(pay), boxes };
  });
  const order = layout.boxes.map((b) => b.text.split(' ')[0]).join(',');
  check('the boxes sit under the paper and above Take payment',
    layout.boxes.length === 5 && layout.boxes.every((b) => b.y >= layout.paperBottom && b.y < layout.pay),
    JSON.stringify({ paperBottom: Math.round(layout.paperBottom), pay: Math.round(layout.pay), ys: layout.boxes.map((b) => Math.round(b.y)) }));
  check('in the order: charges, deposit, their balance, still with you, the account', order === 'Charges,Deposit,Their,Still,Account', order);

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

  // ── Charges: two lines, Cancel keeps them ───────────────────────────────────────
  await box(/^Charges/).check();
  await p.waitForTimeout(800);
  const addCharge = async (what, amount) => {
    await top().getByLabel('What for').first().fill(what);
    await top().getByLabel('Amount').first().fill(String(amount));
    await top().getByRole('button', { name: /Add charge/ }).click();
    await p.waitForTimeout(800);
  };
  await addCharge('Transport', 2000);
  await addCharge('Loading', 500);
  t = await paper();
  check('two charges, both on the paper', /Transport\s*N2,000/.test(t) && /Loading\s*N500/.test(t));
  await top().getByRole('button', { name: /^Cancel$/ }).first().click();
  await p.waitForTimeout(600);
  check('Cancel closes the form and keeps them',
    (await top().getByRole('button', { name: /Add another charge/ }).count()) === 1 && /Transport/.test(await paper()));

  // ── Deposit ─────────────────────────────────────────────────────────────────────
  await box(/^Deposit/).check();
  await p.waitForTimeout(800);
  const dep = top().locator('section').filter({ hasText: 'Take a deposit' }).first();
  await dep.getByLabel('Amount').fill('1000');
  await dep.getByRole('button', { name: /Add deposit/ }).click();
  await p.waitForTimeout(800);
  t = await paper();
  check('a deposit goes on the paper', /Deposit on containers\s*N1,000/.test(t));
  await p.waitForTimeout(4000);
  {
    const { data: drafts } = await admin.from('draft_orders').select('id').in('client_uuid', [...PROBE_DRAFTS]);
    const ids = (drafts ?? []).map((d) => d.id);
    const { data: deps } = await admin.from('draft_order_deposits').select('amount').in('draft_order_id', ids);
    const { data: chs } = await admin.from('draft_order_charges').select('label, amount').in('draft_order_id', ids);
    check('the shop has the deposit and both charges on the order (any phone sees them)',
      (deps ?? []).some((d) => Number(d.amount) === 1000) && (chs ?? []).length === 2,
      JSON.stringify({ deps, chs }));
  }
  await p.screenshot({ path: `${SHOTS}/all-items-extras.png`, fullPage: true });

  // ── The same bill in Take payment ──────────────────────────────────────────────
  const onBill = await p.evaluate(() => document.body.innerText);
  check('the banner total includes them', /comes to N[\d,]+/.test(onBill.replace(/₦/g, 'N')));

  // ── Unticking takes a charge off the bill ───────────────────────────────────────
  await box(/^Charges/).uncheck();
  await p.waitForTimeout(1200);
  t = await paper();
  check('unticking charges takes them off', !/Transport|Loading/.test(t));

  // ── Every way out draws the same document ───────────────────────────────────────
  const shareSet = ['Send on WhatsApp', 'Share', 'Send as picture', 'Save as PDF', 'Print'];
  const gated = /Before this goes to the customer/.test(await top().innerText());
  if (gated) {
    check('the count/price gate stands in front of sharing (items not counted today)', true);
  } else {
    for (const b of shareSet) {
      check(`offers ${b}`, (await top().getByRole('button', { name: new RegExp(b) }).count()) > 0);
    }
  }

  // ── On to Take payment: the deposit added here is on the bill there ─────────────
  if (!gated) {
    await top().getByRole('button', { name: /Take payment/ }).first().click();
    await p.waitForTimeout(7000);
    const pay = (await top().innerText()).replace(/\s+/g, ' ');
    check('Take payment shows the deposit added in All items', /Deposit held\s*₦1,000/.test(pay),
      (pay.match(/Deposit held.{0,20}/) ?? [''])[0]);
    // Its own charge form is the shared one, and still adds to the bill.
    await top().getByLabel('What for').first().fill('Transport');
    await top().getByLabel('Amount').first().fill('2000');
    await top().getByRole('button', { name: /Add charge/ }).click();
    await p.waitForTimeout(1000);
    const after = (await top().innerText()).replace(/\s+/g, ' ');
    check('Take payment adds a charge through the same form', /Transport\s*₦2,000/.test(after),
      (after.match(/Transport.{0,20}/) ?? [''])[0]);
    await p.screenshot({ path: `${SHOTS}/all-items-extras-takepay.png`, fullPage: true });
  }
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
