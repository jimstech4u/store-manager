/**
 * CHANGE AT THE TILL: the old balance, or change — given now, or owed on the receipt.
 *
 * "A name must be there. Before we mark as paid, a checkbox if there is an overpayment, whether it
 * clears the old balance — unchecked is change. We pick what we paid the change with."
 *
 * On a tab this probe opens: Busayo Store (who owes), one Goldberg crate (N9,000), N10,000 cash.
 * The box offers to clear her old balance; unticked, the N1,000 is change; "Owe it to them" is
 * chosen; Mark as paid sends the shop the change to settle. Both writers are answered by the probe,
 * so nothing is sold — the server side is rehearsed separately (0246).
 *
 *     node scripts/probe-change-ui.mjs [http://localhost:3100]
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

// Nothing is sold: the settle and the change are answered here, and what was sent is kept.
const sent = [];
await p.route('**/rest/v1/rpc/settle_draft_with_deposit*', (route) => {
  sent.push({ fn: 'settle', body: JSON.parse(route.request().postData() ?? '{}') });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify('00000000-0000-0000-0000-000000000000') });
});
await p.route('**/rest/v1/rpc/settle_sale_change*', (route) => {
  sent.push({ fn: 'change', body: JSON.parse(route.request().postData() ?? '{}') });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
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
  await p.waitForTimeout(3000);
  await p.getByRole('button', { name: /One more Goldberg/ }).first().click();
  await p.waitForTimeout(3000);

  await p.getByRole('button', { name: /Take payment/ }).first().click();
  await p.waitForTimeout(7000);
  const payBox = top().locator('section').filter({ hasText: 'How are they paying?' }).first();
  await payBox.getByRole('button', { name: /^Cash$/ }).first().click();
  await payBox.getByLabel('Amount').first().fill('10000');
  await p.waitForTimeout(1500);

  const clear = top().getByRole('checkbox', { name: /Use the extra to clear their old balance/ });
  check('the box offers to clear her old balance', (await clear.count()) === 1,
    ((await top().innerText()).match(/Use the extra.{0,60}/) ?? [''])[0]);
  check('ticked, the extra goes to her old balance', /Off what they owed\s*₦1,000/.test((await top().innerText()).replace(/\s+/g, ' ')));
  await clear.uncheck();
  await p.waitForTimeout(600);
  let t = (await top().innerText()).replace(/\s+/g, ' ');
  check('unticked, it is change', /Change to give\s*₦1,000/.test(t));
  check('change can be given by cash, transfer or POS', (await top().getByRole('group', { name: 'Change given by' }).count()) === 1);
  await top().getByRole('button', { name: 'Owe it to them' }).click();
  await p.waitForTimeout(600);
  t = (await top().innerText()).replace(/\s+/g, ' ');
  check('owed, it says so', /Change you owe them\s*₦1,000/.test(t) && /goes on the receipt as change owed/.test(t));
  await p.screenshot({ path: `${SHOTS}/change-owed.png`, fullPage: true });

  await top().getByRole('button', { name: /Mark as paid/ }).last().click();
  await p.waitForTimeout(6000);
  const change = sent.find((s) => s.fn === 'change');
  check('the shop is sent the change to settle: not her old balance, N1,000 owed',
    change && change.body.p_to_old_debt === false && Number(change.body.p_change_owed) === 1000 && Number(change.body.p_change_given) === 0,
    JSON.stringify(change?.body ?? sent.map((s) => s.fn)));
} catch (e) {
  await p.screenshot({ path: `${SHOTS}/change-crash.png`, fullPage: true }).catch(() => {});
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
  await sweepDrafts(admin, PROBE_DRAFTS);
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
