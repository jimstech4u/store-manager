/**
 * Nobody meets a door they cannot open.
 *
 * «add one more layer permission protect to even hide the button or views that permission is
 *  blocked even before they get to the page to see the permission blocked»
 *
 * A staff login is made through the app's own route with a HAND-MADE set of boxes — counting added
 * (not in the staff role), deposits taken away (in it) — so this proves the screens follow the
 * server's per-person answer (`member_permissions`), not the role. Then, signed in as them:
 *
 *   LAYER 1  the buttons, header actions and rows for what they cannot do are not drawn, and the
 *            ones they can use still are;
 *   LAYER 2  a page they cannot use, reached anyway (an old link), says so under its one header;
 *   LAYER 3  the server refuses regardless (covered by the RPC probes, not repeated here).
 *
 * The login is deleted afterwards.
 *
 *     node scripts/probe-permission-gates.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { installNavDevtools, navStack } from '@academix-admin/navigation-stack/playwright';

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

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const owner = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { data: signedIn } = await owner.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
const { data: membership } = await owner.rpc('my_membership');
const home = membership.find((m) => m.store_name === env.SAMPLE_STORE) ?? membership[0];
const storeId = home.store_id;

const created = [];
const browser = await chromium.launch();

try {
  // ══ A staff login with its own boxes ══════════════════════════════════════════════
  const PERMS = ['sales.record', 'payments.record', 'stock.adjust', 'customers.manage', 'stock.count'];
  const res = await fetch(`${BASE}/api/create-staff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signedIn.session.access_token}` },
    body: JSON.stringify({
      storeId,
      firstName: 'Probe',
      lastName: `Gate${Date.now() % 100000}`,
      password: 'Sample@12345',
      roleCode: 'staff',
      permissions: PERMS,
    }),
  });
  const made = await res.json();
  check('a staff login is made with counting added and deposits removed', Boolean(made.email), made.error ?? made.email);
  const { data: row } = await admin
    .from('store_members')
    .select('user_id')
    .eq('store_id', storeId)
    .eq('login_email', made.email)
    .single();
  created.push(row.user_id);
  // Skip the "choose your own password" gate: that screen has its own probe.
  await admin.from('store_members').update({ must_change_password: false }).eq('user_id', row.user_id).eq('store_id', storeId);

  // ══ Signed in as them ═════════════════════════════════════════════════════════════
  const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await installNavDevtools(p);
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(made.email);
  await p.locator('input[type="password"]').first().fill('Sample@12345');
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(15000);

  const tab = async (label) => {
    await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
    await p.waitForTimeout(2500);
  };
  const shown = async (re) => (await p.getByRole('button', { name: re }).locator('visible=true').count()) > 0;

  console.log('\n— layer 1: what they cannot do is not drawn —');
  await tab('Stock');
  check('Stock: no "Record a delivery"', !(await shown(/Record a delivery/i)));
  check('Stock: no "Suppliers"', !(await shown(/Suppliers and what you owe them/i)));
  check('Stock: no "Add an item"', !(await shown(/Add an item you sell/i)));
  check('Stock: "What is going off" is there for everyone', await shown(/What is going off/i));
  check('Stock: Count IS there — ticked for them, though staff do not count', await shown(/^Count$/));

  await tab('Money');
  check('Money: no Reports', !(await shown(/Reports you can print or save/i)));
  check('Money: sales are there', await shown(/All sales and receipts/i));

  await tab('More');
  check('More: no "This shop"', !(await shown(/^This shop/i)));
  check('More: no "Words you measure in"', !(await shown(/Words you measure in/i)));
  check('More: no "What staff owe"', !(await shown(/What staff owe/i)));
  check('More: customers are there', await shown(/Everyone you sell to/i));

  await p.getByRole('button', { name: /Everyone you sell to/i }).locator('visible=true').first().click();
  await p.waitForTimeout(6000);
  check('People: "Add a customer" is there (customers.manage)', await shown(/Add a customer/i));
  await p.locator('.navstack-page').last().getByRole('button').filter({ hasText: /₦/ }).first().click();
  await p.waitForTimeout(7000);
  await p.getByRole('button', { name: /^Deposit$/ }).locator('visible=true').first().click();
  await p.waitForTimeout(6000);
  check('Deposit: no "Give some back" (deposits taken away)', !(await shown(/Give some back/i)));
  check('Deposit: no "Take more"', !(await shown(/Take more/i)));
  await p.getByRole('button', { name: /go back/i }).locator('visible=true').first().click();
  await p.waitForTimeout(2500);
  await p.getByRole('button', { name: /^Empties$/ }).locator('visible=true').first().click();
  await p.waitForTimeout(6000);
  check('Empties: no "They brought some back"', !(await shown(/They brought some back/i)));

  console.log('\n— layer 2: a page reached anyway says so, under one header —');
  await navStack(p, 'settings-stack').push('shop_page');
  await p.waitForTimeout(4000);
  const top = await p.evaluate(() => {
    const pages = [...document.querySelectorAll('.navstack-page')].filter((c) => c.offsetParent !== null);
    const el = pages[pages.length - 1] ?? document.body;
    return { text: el.innerText.replace(/\s+/g, ' '), headers: el.querySelectorAll('h1').length };
  });
  check('This shop, pushed directly, says it is not theirs', /Not part of your job here/.test(top.text), top.text.slice(0, 90));
  check('… and shows no form to fill in', !/Shop name/.test(top.text));

  await tab('Money');
  await navStack(p, 'money-stack').push('reports_page');
  await p.waitForTimeout(4000);
  const rep = await p.locator('.navstack-page').last().innerText();
  check('Reports, pushed directly, says it is not theirs', /Not part of your job here/.test(rep));

  console.log('\n— the per-person answer follows a change —');
  // The owner unticks counting for them; a reload reads the server's answer again.
  await owner.rpc('set_member_permissions', {
    p_store_id: storeId,
    p_user_id: row.user_id,
    p_allowed: PERMS.filter((x) => x !== 'stock.count'),
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(12000);
  await tab('Stock');
  check('Count is gone once the owner unticks it', !(await shown(/^Count$/)));
} catch (e) {
  console.log('STOPPED:', String(e).split('\n')[0]);
  failed += 1;
} finally {
  for (const id of created) await admin.auth.admin.deleteUser(id);
  if (created.length) console.log(`  (cleaned up ${created.length} test login)`);
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
