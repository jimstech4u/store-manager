/**
 * RECEIPTS PUT TOGETHER, AND A CUSTOMER'S STATEMENT — both read, nothing written.
 *
 * "Merging receipts does not touch the data; it is for printing or sharing, its own page. Same
 * customer: 20 Bigi and 5 Bigi is 25 Bigi, the balance once, the charges, still with you and all the
 * money." And: "a detailed account statement from the account page's header, to print or share like
 * a receipt — payments, sales, items — with what to include and a range of dates." (0254, 0255)
 *
 * On Busayo Store: from the ₦9,200 receipt, Put receipts together, tick the ₦6,500 one — one paper
 * of ₦15,700 naming both, with every way a receipt is sent; and the sales table is exactly as it was.
 * Then the account's statement: all time ends at the account's own balance; unticking payments takes
 * them off the paper but not off the closing figure; items show under each sale.
 *
 *     node scripts/probe-together-statement-ui.mjs [http://localhost:3100]
 */
import { chromium, webkit } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad';
const CUSTOMER = 'c40c32ed-1b49-4b30-b592-4ddadadf8b53';
const OLDER = '26ee2fb7-2376-42cb-99a9-21a9aba89d7a';
const NEWER = 'a7ca72a5-5ef8-4e50-a94b-761de6e35503';
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
p.on('pageerror', (e) => errors.push(String(e.stack ?? e).split('\n').slice(0, 3).join(' ')));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const text = async () => ((await top().innerText()) ?? '').replace(/\s+/g, ' ');
const paper = async () =>
  ((await top().locator('[data-print-root]').first().innerText().catch(() => '')) ?? '')
    .replace(/\s+/g, ' ')
    .replace(/₦/g, 'N');
const tag = (id) => `#${id.slice(0, 8).toUpperCase()}`;
const offersAll = async () => {
  for (const w of ['Share', 'Send on WhatsApp', 'Send as picture', 'Print', 'Save as PDF']) {
    if ((await top().getByRole('button', { name: new RegExp(`^${w}`) }).count()) === 0) return false;
  }
  return true;
};
const salesNow = async () => {
  const { data } = await admin.from('sales').select('id, total, status, revision, updated_at').in('id', [OLDER, NEWER]).order('id');
  return JSON.stringify(data);
};

try {
  const before = await salesNow();
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
  const row = p.getByRole('button', { name: /Busayo Store/ }).locator('visible=true').first();
  await row.waitFor({ state: 'visible', timeout: 60000 });
  await row.click();
  await p.waitForTimeout(7000);

  // ── Put together ────────────────────────────────────────────────────────────────────────
  await top().getByRole('button', { name: /N?₦?9,200/ }).filter({ hasText: /items? ·/ }).first().evaluate((el) => el.click());
  await p.waitForTimeout(7000);
  await top().getByRole('button', { name: /Put receipts together/ }).click();
  await p.waitForTimeout(5000);
  let t = await text();
  check('the page lists Busayo’s receipts, this one ticked',
    t.includes(tag(NEWER)) && (await top().locator('label', { hasText: tag(OLDER) }).locator('input').isChecked()), t.slice(0, 120));
  await top().locator('label', { hasText: tag(NEWER) }).locator('input').check();
  await p.waitForTimeout(6000);
  let pp = await paper();
  check('one paper of both: ₦15,700', /Total\s*N15,700/.test(pp), (pp.match(/Total\s*\S+/) ?? [''])[0]);
  check('naming both receipts', /2 receipts put together/.test(pp) && pp.includes(tag(OLDER)) && pp.includes(tag(NEWER)),
    (pp.match(/2 receipts put together.{0,60}/) ?? [''])[0]);
  check('the balance said once', (pp.match(/Total owed/g) ?? []).length === 1, (pp.match(/Total owed\s*\S+/) ?? ['none'])[0]);
  check('with every way a receipt is sent', await offersAll());
  await p.screenshot({ path: `${SHOTS}/together.png`, fullPage: true });
  check('and nothing about either sale changed', (await salesNow()) === before);

  // ── The statement ───────────────────────────────────────────────────────────────────────
  await p.goBack();
  await p.waitForTimeout(3000);
  await p.goBack();
  await p.waitForTimeout(4000);
  await top().getByRole('button', { name: /Print or send their statement/ }).first().click();
  await p.waitForTimeout(6000);
  await top().getByRole('tab', { name: 'All time' }).click();
  await p.waitForTimeout(6000);
  pp = await paper();
  // As the shop, the way the app asks: the reader checks membership, so the admin key is not it.
  const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
  const { data: bal } = await shop.rpc('customer_balance_total', { p_store_customer_id: CUSTOMER });
  const owed = Number(bal ?? 0).toLocaleString('en-NG');
  check('all time ends at the account’s own balance', new RegExp(`Owed at the end\\s*N${owed}`).test(pp),
    `${(pp.match(/Owed at the end\s*\S+/) ?? ['none'])[0]} vs N${owed}`);
  check('payments and items are on it', /Payment/i.test(pp) && /x N[\d,]+ = N[\d,]+/.test(pp));
  await top().getByRole('checkbox', { name: 'Payments' }).uncheck();
  await p.waitForTimeout(1200);
  const noPay = await paper();
  check('unticking payments takes them off the paper, not off the closing figure',
    !/^Payment|Payment received/i.test(noPay.split('Sold')[0] ?? '') &&
      new RegExp(`Owed at the end\\s*N${owed}`).test(noPay));
  check('the statement offers every way a receipt is sent', await offersAll());
  await p.screenshot({ path: `${SHOTS}/statement.png`, fullPage: true });

  await top().getByRole('tab', { name: 'Pick dates' }).click();
  await p.waitForTimeout(800);
  await top().getByLabel('From').fill('2026-10-01');
  await top().getByLabel('To').fill('2026-10-02');
  await p.waitForTimeout(6000);
  pp = await paper();
  check('a range of dates: owed at the start, and the end of that range',
    /Owed at the start\s*N42,250/.test(pp) && /Owed at the end\s*N42,950/.test(pp),
    `${(pp.match(/Owed at the start\s*\S+/) ?? ['none'])[0]} … ${(pp.match(/Owed at the end\s*\S+/) ?? ['none'])[0]}`);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/together-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  console.log('  page errors:', errors.slice(0, 3).join(' || '));
  failed += 1;
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
