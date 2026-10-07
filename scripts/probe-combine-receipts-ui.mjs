/**
 * TWO RECEIPTS, SENT AND PRINTED AS ONE.
 *
 * "Merging receipts: I have done one for the customer and then another one, and sending two that
 * both carry the balance and still with you makes the customer think it is more than it is." The
 * newest stays; the options are chosen per merge; any receipts of the customer combine. (0253)
 *
 * On Busayo Store's two receipts of 2 Oct (₦9,200 then ₦6,500): from the older one, "Combine with
 * other receipts", tick the newer, combine — and the NEWER one now prints both (₦15,700, every line,
 * one balance) while the older says it is part of it. Then taken apart again from the newer, and the
 * probe's rows in `receipt_combines` are removed, so the shop's records are as they were.
 *
 *     node scripts/probe-combine-receipts-ui.mjs [http://localhost:3100]
 */
import { chromium, webkit } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad';
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
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const started = new Date().toISOString();

const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const text = async () => ((await top().innerText()) ?? '').replace(/\s+/g, ' ');
const paper = async () =>
  ((await top().locator('[data-print-root]').first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
const tag = (id) => `#${id.slice(0, 8).toUpperCase()}`;

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(8000);

  // ── The older receipt, from Busayo's account ────────────────────────────────────────────
  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /everyone you sell to/i }).locator('visible=true').first().click();
  await p.waitForTimeout(5000);
  const row = p.getByRole('button', { name: /Busayo Store/ }).locator('visible=true').first();
  await row.waitFor({ state: 'visible', timeout: 60000 });
  await row.click();
  await p.waitForTimeout(7000);
  // Its receipts, newest first: the ₦9,200 one is the older of the two on 2 Oct.
  await top().getByRole('button', { name: /N?₦?9,200/ }).filter({ hasText: /items? ·/ }).first().evaluate((el) => el.click());
  await p.waitForTimeout(7000);
  let t = await text();
  check('the older receipt opens', t.includes(tag(OLDER)) || /9,200/.test(t), t.slice(0, 100));

  await top().getByRole('button', { name: /Combine with other receipts/ }).click();
  await p.waitForTimeout(5000);
  t = await text();
  check('Combine lists Busayo’s receipts, this one ticked',
    t.includes(tag(OLDER)) && t.includes(tag(NEWER)) &&
      (await top().locator('label', { hasText: tag(OLDER) }).locator('input').isChecked()),
    t.slice(0, 160));
  await top().locator('label', { hasText: tag(NEWER) }).locator('input').check();
  await p.waitForTimeout(800);
  t = await text();
  check('it says the newest is the one that stays', new RegExp(`print and share as ${tag(NEWER)}`).test(t),
    (t.match(/print and share as.{0,40}/) ?? [''])[0]);
  await p.screenshot({ path: `${SHOTS}/combine-page.png`, fullPage: true });
  await top().getByRole('button', { name: /^Combine 2 receipts$/ }).click();
  await p.waitForTimeout(8000);

  // ── The newer one now prints both ───────────────────────────────────────────────────────
  t = await text();
  const pp = await paper();
  check('it lands on the newest receipt, saying it combines 2', /This receipt combines 2/.test(t), t.slice(0, 160));
  check('the paper names both receipts', pp.includes(tag(OLDER)) && pp.includes(tag(NEWER)), (pp.match(/Combines.{0,80}/) ?? [''])[0]);
  check('and its total is both of them: ₦15,700', /Total\s*N15,700/.test(pp.replace(/₦/g, 'N')), (pp.match(/Total\s*\S+/) ?? [''])[0]);
  const { data: rows } = await admin.from('receipt_combines').select('into_sale_id, from_sale_id, undone_at')
    .gte('created_at', started);
  check('the shop records it: the older into the newer',
    (rows ?? []).some((r) => r.into_sale_id === NEWER && r.from_sale_id === OLDER && !r.undone_at), JSON.stringify(rows));
  await p.screenshot({ path: `${SHOTS}/combine-receipt.png`, fullPage: true });

  // ── The older one says where it went ────────────────────────────────────────────────────
  await p.goBack();
  await p.waitForTimeout(5000);
  t = await text();
  check('the older receipt says it is combined into the newer', new RegExp(`Combined into ${tag(NEWER)}`).test(t),
    (t.match(/Combined into.{0,30}/) ?? ['none'])[0]);
  await top().getByRole('button', { name: /Open the combined receipt/ }).click();
  await p.waitForTimeout(6000);
  check('and opens it', /This receipt combines 2/.test(await text()));

  // ── Taken apart, from the newer ─────────────────────────────────────────────────────────
  await top().getByRole('button', { name: /Combine with other receipts/ }).click();
  await p.waitForTimeout(5000);
  await top().getByRole('button', { name: /Take them all apart/ }).click();
  await p.waitForTimeout(7000);
  t = await text();
  check('taken apart, it is one receipt again', !/combines 2/.test(t) && !/N15,700/.test((await paper()).replace(/₦/g, 'N')),
    (await paper()).slice(0, 80));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/combine-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  // The probe's own rows go: whatever it combined is taken apart and its trace removed.
  const { data: mine } = await admin.from('receipt_combines').select('id')
    .gte('created_at', started).in('from_sale_id', [OLDER, NEWER]);
  if ((mine ?? []).length > 0) {
    await admin.from('receipt_combines').delete().in('id', mine.map((r) => r.id));
  }
  const { data: left } = await admin.from('receipt_combines').select('id').in('from_sale_id', [OLDER, NEWER]).is('undone_at', null);
  console.log(`  (removed ${mine?.length ?? 0} probe row(s); ${left?.length ?? 0} active combine(s) left on these receipts)`);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
