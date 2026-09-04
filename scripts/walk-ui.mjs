/**
 * Open every page in a stack and photograph it.
 *
 * The evidence for [UI_TRACK.md](../UI_TRACK.md). It CLICKS rather than constructing URLs: the
 * navigation state is base64 in the address bar, and a hand-built one would prove that a component
 * renders rather than that a shop can get to it — which is the question being asked.
 *
 * Read-only wherever it can be. Where a page only exists after something is created — settling, a
 * count, an invitation — it stops at the door and says so rather than writing to a real shop.
 *
 *     node scripts/walk-ui.mjs                 # every stack
 *     node scripts/walk-ui.mjs stock sell      # just those
 *
 * Screenshots land in the scratchpad, one directory per stack. They are evidence for the session
 * that took them; a stale screenshot is worse than none, so they are not committed.
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.WALK_BASE ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/walk';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

/** When this walk began, so the tabs it opens can be told from the shop's own. */
const startedAt = new Date(Date.now() - 1000).toISOString();

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const body = async () => (await p.locator('body').innerText()).replace(/\s+/g, ' ');

/** What this run saw, printed at the end so a session can paste it into UI_TRACK. */
const seen = [];

/**
 * The tab bar has two states and a walk meets both: pushed off by the keyboard, or collapsed into
 * its floating button after a scroll. A wheel from the middle of the screen restores it — the bar
 * listens for a gesture, and `window.scrollTo` produces none.
 */
const tab = async (label) => {
  await p.evaluate(() => {
    (document.activeElement instanceof HTMLElement ? document.activeElement : null)?.blur();
  });
  await p.mouse.move(195, 420);
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(1000);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(3500);
};

/** Photograph where we are, and record the first line of it as a sanity check. */
const shot = async (stack, name, note = '') => {
  mkdirSync(`${SHOTS}/${stack}`, { recursive: true });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${SHOTS}/${stack}/${name}.png`, fullPage: true });
  const text = (await body()).slice(0, 80);
  seen.push({ stack, name, text, note });
  console.log(`  📷 ${name.padEnd(26)} ${text}`);
};

/** Back out of a pushed page, answering a discard prompt if one appears. */
const back = async () => {
  const b = p.getByRole('button', { name: 'Go back' }).first();
  if ((await b.count()) > 0) {
    await b.click();
    await p.waitForTimeout(2500);
    const discard = p.getByRole('button', { name: /^(Discard|Leave|Yes)/i }).first();
    if ((await discard.count()) > 0) {
      await discard.click();
      await p.waitForTimeout(2000);
    }
  }
};

/** Click something if it is there; say so if it is not, and carry on. */
const maybe = async (locator, what) => {
  if ((await locator.count()) === 0) {
    console.log(`  ..  no ${what} on this screen`);
    return false;
  }
  await locator.first().click();
  await p.waitForTimeout(3500);
  return true;
};

const notNow = async () => {
  const n = p.getByRole('button', { name: /^Not now$/ }).first();
  if ((await n.count()) > 0) {
    await n.click();
    await p.waitForTimeout(2500);
  }
};

// ─── The itineraries ────────────────────────────────────────────────────────────────

const walks = {
  sell: async () => {
    await tab('Sell');
    await shot('sell', '01-sell-page', 'the till at rest');

    await maybe(p.getByRole('button', { name: /^Add an item$/ }), '"Add an item"');
    await shot('sell', '02-product-picker', 'choosing what to sell');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(1500);

    if (await maybe(p.getByRole('button', { name: /Containers still to come back/i }), 'empties entry')) {
      await shot('sell', '03-empties-page', 'receipts with containers out');
      const card = p.locator('[class*="empties-page_card"]').first();
      if ((await card.count()) > 0) {
        await card.click();
        await p.waitForTimeout(3500);
        await shot('sell', '04-empties-settle', 'what came back');
        await back();
      }
      await back();
    }

    await tab('Sell');
    await maybe(p.getByRole('button', { name: /Take payment|Fix the quantity/i }), 'the payment button');
    await shot('sell', '05-take-payment', 'what is owed and how it is paid');
    await back();
  },

  stock: async () => {
    await tab('Stock');
    await shot('stock', '01-stock-page', 'what is on the shelf');

    const row = p.locator('[class*="stock-page_item"]').first();
    if ((await row.count()) > 0) {
      await row.click();
      await p.waitForTimeout(3500);
      await shot('stock', '02-product-page', 'one product');

      await maybe(p.getByRole('button', { name: /history|Stock history/i }), 'stock history');
      await shot('stock', '03-stock-history', 'what moved and why');
      await back();
      await back();
    }

    await tab('Stock');
    await maybe(p.getByRole('button', { name: 'Record a delivery' }), 'the delivery action');
    await shot('stock', '04-receive-page', 'a delivery being recorded');
    await back();

    await tab('Stock');
    await maybe(p.getByRole('button', { name: 'Add an item you sell' }), 'the add-item action');
    await shot('stock', '05-product-form', 'a new item, before any shape');
    await back();
  },

  count: async () => {
    await tab('Count');
    await shot('count', '01-count-page', 'the shelf against the records');

    const row = p.locator('[class*="count-page_item"], [class*="count-page_row"]').first();
    if ((await row.count()) > 0) {
      await row.click();
      await p.waitForTimeout(3500);
      await notNow();
      await shot('count', '02-count-entry', 'counting one item');
      await back();
    }
  },

  money: async () => {
    await tab('Money');
    await shot('money', '01-money-page', 'the money screen');

    for (const [name, label] of [
      ['02-sales', /Sales|What was sold/i],
      ['03-reports', /Reports|Worth|Stock worth/i],
      ['04-banks', /Bank|Accounts/i],
    ]) {
      await tab('Money');
      if (await maybe(p.getByRole('button', { name: label }), `"${label}"`)) {
        await shot('money', name);
        await back();
      }
    }
  },

  people: async () => {
    await tab('People');
    await shot('people', '01-people-page', 'everybody the shop knows');

    const row = p.locator('[class*="people-page_item"], [class*="people-page_row"]').first();
    if ((await row.count()) > 0) {
      await row.click();
      await p.waitForTimeout(3500);
      await shot('people', '02-account-page', "one customer's account");

      await maybe(p.getByRole('button', { name: /Take payment|Record a payment|Charge/i }), 'an account action');
      await shot('people', '03-account-action', 'money on an account');
      await back();
      await back();
    }

    await tab('People');
    await maybe(p.getByRole('button', { name: /Add (a )?(customer|somebody)/i }), 'add a customer');
    await shot('people', '04-customer-form', 'a new customer, before a name');
    await back();
  },

  settings: async () => {
    await tab('More');
    await shot('settings', '01-more', 'everything else');

    for (const [name, label] of [
      ['02-settings', /Receipts|Printing|Settings/i],
      ['03-staff', /Staff|Who can/i],
      ['04-banks', /Bank/i],
      ['05-units', /Units|Shapes/i],
      ['06-review', /Review|Variance/i],
      ['07-device', /This device/i],
    ]) {
      await tab('More');
      if (await maybe(p.getByRole('button', { name: label }), `"${label}"`)) {
        await shot('settings', name);
        await back();
      }
    }
  },

  public: async () => {
    const { data: links } = await admin
      .from('share_links')
      .select('token')
      .eq('kind', 'receipt')
      .is('revoked_at', null)
      .limit(1);
    if (links?.[0]) {
      await p.goto(`${BASE}/r/${links[0].token}`, { waitUntil: 'networkidle' });
      await shot('public', '01-shared-receipt', 'what a customer is sent');
    }

    const { data: orders } = await admin
      .from('draft_orders')
      .select('share_token, code')
      .not('share_token', 'is', null)
      .eq('status', 'settled')
      .limit(1);
    if (orders?.[0]) {
      await p.goto(`${BASE}/t/${orders[0].share_token}`, { waitUntil: 'networkidle' });
      await shot('public', '02-track-settled', 'an order after it is paid for');
    }

    await p.goto(`${BASE}/track`, { waitUntil: 'networkidle' });
    await shot('public', '03-track-entry', 'looking an order up by code');
  },
};

// ─── The walk ───────────────────────────────────────────────────────────────────────

const asked = process.argv.slice(2).filter((a) => walks[a]);
const todo = asked.length > 0 ? asked : Object.keys(walks);

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.locator('input[type="email"]').first().waitFor({ timeout: 90000 });
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  for (const name of todo) {
    console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 40 - name.length))}`);
    try {
      await walks[name]();
    } catch (e) {
      console.log(`  ✖  the walk stopped: ${String(e).split('\n')[0].slice(0, 110)}`);
    }
  }
} finally {
  await browser.close();

  /*
   * Close any tab this walk opened.
   *
   * Visiting the Sell tab starts a customer, so even a read-only walk leaves an empty draft behind.
   * Bounded by time rather than an id snapshot: PostgREST caps a response at 1,000 rows and this
   * shop has more drafts than that, so a snapshot silently truncates.
   */
  const { data: open } = await admin
    .from('draft_orders')
    .select('id')
    .eq('store_id', storeId)
    .eq('status', 'open')
    .gte('created_at', startedAt);
  for (const r of open ?? []) await shop.rpc('cancel_draft_order', { p_draft_id: r.id });
  console.log(`\n  ok  ${(open ?? []).length} draft tab(s) opened by this walk, closed again`);
}

console.log(`\n${seen.length} page(s) photographed into ${SHOTS}`);
if (errors.length > 0) {
  console.log(`\n${errors.length} page error(s) along the way:`);
  for (const e of [...new Set(errors)].slice(0, 8)) console.log('   ', e.slice(0, 120));
}
