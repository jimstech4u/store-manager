/**
 * WHO OWES WHAT, ON THE SCREEN.
 *
 * "Say Zitar: we look for the receipts that took it and payment has not been completed, so the record
 * can come out. And filters like customers with a deposit, or a balance above 100k."
 *
 * Reads the People filters and an item's Who took this page against what the database says for the
 * same question, as the same member. Writes nothing.
 *
 *     node scripts/probe-who-owes-ui.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const BASE = process.argv[2] ?? 'http://localhost:3100';
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

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const { data: mem } = await db.rpc('my_membership');
const storeId = mem[0].store_id;
const customers = async (filter, min = null) =>
  (await db.rpc('list_customers', { p_store_id: storeId, p_filter: filter, p_min_amount: min, p_limit: 100 })).data;

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e.stack ?? e).split('\n').slice(0, 4).join(' ')));
p.on('console', (m) => {
  if (m.type() === 'error' && !/Content Security Policy/.test(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`);
});
const top = () => p.locator('.group-stack-container[data-active="true"] .navstack-page').last();
const text = async () => ((await top().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
const chip = (name) => top().getByRole('tab', { name, exact: true });

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForURL(/\/main/, { timeout: 90000 });
  await p.waitForTimeout(8000);

  // ── People ──────────────────────────────────────────────────────────────────────────────
  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(3000);
  await top().getByRole('button', { name: /Everyone you sell to/ }).first().click();
  await p.waitForTimeout(5000);

  await chip('Owes you').click();
  await p.waitForTimeout(3000);
  check('choosing Owes you offers amounts', (await chip('Any amount').count()) === 1);
  await chip('₦100,000+').click();
  await p.waitForTimeout(3500);
  const over = await customers('owes', 100000);
  const shownOver = await text();
  check(
    '₦100,000+ shows those who owe that much, and only those',
    over.every((c) => shownOver.includes(c.display_name)) && (await top().locator('ul li').count()) === over.length,
    `${over.length} expected, ${await top().locator('ul li').count()} shown`,
  );

  await chip('Holding a deposit').click();
  await p.waitForTimeout(3500);
  const held = await customers('deposit');
  const shownHeld = await text();
  check('Holding a deposit lists them with what is held', held.length > 0 && held.slice(0, 5).every((c) => shownHeld.includes(c.display_name)) && /deposit ₦/.test(shownHeld), `${held.length} held`);

  await chip('Stopped buying').click();
  await p.waitForTimeout(3500);
  const quiet = await customers('quiet');
  const shownQuiet = await text();
  check('Stopped buying says when they last bought', quiet.slice(0, 5).every((c) => shownQuiet.includes(c.display_name)) && (quiet.length === 0 || /last bought/.test(shownQuiet)), `${quiet.length} quiet`);
  check('and asks no amount', (await chip('Any amount').count()) === 0);

  // ── An item ─────────────────────────────────────────────────────────────────────────────
  const { data: found } = await db.rpc('search_products', { p_store_id: storeId, p_query: 'Trophy Bottle', p_limit: 1, p_offset: 0 });
  const item = found[0];
  const { data: owing } = await db.rpc('who_owes_for_product', { p_store_id: storeId, p_product_id: item.id });
  const { data: bought } = await db.rpc('who_bought_product', { p_store_id: storeId, p_product_id: item.id });

  await p.locator('.nav-item').filter({ hasText: /^Stock$/ }).first().click();
  await p.waitForTimeout(3000);
  await p.getByRole('button', { name: /Search your stock/ }).locator('visible=true').first().click();
  await p.waitForTimeout(1500);
  await p.keyboard.type('tropy bottle');
  await p.waitForTimeout(3500);
  const hit = p.locator('.react-modal-sheet-container').getByText(/Trophy Bottle/).locator('visible=true').first();
  check('the app finds the item misspelt', (await hit.count()) > 0);
  await hit.click();
  await p.waitForTimeout(5000);
  await top().getByRole('button', { name: /^Who took this/ }).click();
  await p.waitForTimeout(4000);

  const page = await text();
  if (owing.length === 0) {
    check('nobody owing is said plainly', /Nobody owes for this/.test(page), page.slice(0, 120));
  } else {
    const names = [...new Set(owing.map((o) => o.customer_name))];
    check('Still owing names everyone with an open receipt', names.every((n) => page.includes(n)), names.join(', '));
    check('and the first receipt by its number', page.includes(owing[0].sale_id.slice(0, 8).toUpperCase()));
    check('and what they took', /Took \d/.test(page));
    await top().getByRole('button', { name: /^Took / }).first().click();
    await p.waitForTimeout(4000);
    check('a row opens its receipt', (await text()).includes('Receipt') || /#[0-9A-F]{8}/.test(await text()));
    await p.goBack();
    await p.waitForTimeout(2500);
  }
  await chip('Everyone who took it').click();
  await p.waitForTimeout(1500);
  const allPage = await text();
  check('Everyone who took it lists the buyers', bought.slice(0, 5).every((b) => allPage.includes(b.customer_name)), `${bought.length} buyers`);

  check('no page errors', errors.length === 0, errors[0]);
} catch (e) {
  console.log('  FAIL  probe crashed —', String(e).split('\n')[0]);
  failed += 1;
} finally {
  await browser.close();
}
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
