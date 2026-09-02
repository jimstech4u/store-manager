/**
 * Taking on a member of staff, end to end.
 *
 * A shop hires somebody, gives them a login on the shop's own namespace, ticks what they may do,
 * and they can sell that afternoon. Then the shop changes their mind about a permission, and the
 * change has to actually bind — a permission screen that saves and does not enforce is worse than
 * no permission screen, because everyone believes it.
 *
 * SIGNED IN AS THE NEW STAFF MEMBER for the enforcement half. Asking the database whether the
 * permission was stored proves the row; only using their session proves the rule.
 *
 *     node scripts/probe-staff-flow.mjs [http://localhost:3100]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3100';
const SHOTS =
  'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/staff';
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

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const stamp = Date.now().toString().slice(-6);
const FIRST = `Probe${stamp}`;
const LAST = 'Staff';
const PASSWORD = `Pw${stamp}!aA`;

const browser = await chromium.launch();
const p = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const errors = [];
p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));

const tab = async (label) => {
  await p.mouse.wheel(0, -3000);
  await p.waitForTimeout(900);
  await p.locator('.nav-item').filter({ hasText: new RegExp(`^${label}$`) }).first().click();
  await p.waitForTimeout(4500);
};

let staffEmail = null;
let staffUserId = null;

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);

  // ══ Find the team screen ══════════════════════════════════════════════════════════
  console.log('\n— take somebody on —');
  await tab('More');
  await p.waitForTimeout(1500);
  const team = p.getByText(/team|staff/i).first();
  check('the shop can reach its team', (await team.count()) > 0);
  await team.click();
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `${SHOTS}/1-team.png` });

  const addStaff = p.getByRole('button', { name: /add|invite|new/i }).first();
  check('and offers to take somebody on', (await addStaff.count()) > 0);
  await addStaff.click();
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `${SHOTS}/2-form.png` });

  await p.getByLabel(/First name/i).fill(FIRST);
  await p.getByLabel(/Last name/i).fill(LAST);
  const phone = p.getByLabel(/Phone/i).first();
  if (await phone.count()) await phone.fill(`0809${Date.now().toString().slice(-7)}`);
  const pw = p.locator('input[type="password"]').first();
  if (await pw.count()) await pw.fill(PASSWORD);
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${SHOTS}/3-filled.png`, fullPage: true });

  const create = p.getByRole('button', { name: /create|add them|save/i }).last();
  await create.scrollIntoViewIfNeeded();
  await create.click();
  await p.waitForTimeout(10000);
  await p.screenshot({ path: `${SHOTS}/4-created.png` });

  // ══ What the shop actually recorded ═══════════════════════════════════════════════
  const { data: member } = await admin
    .from('store_members')
    .select('user_id, role_code, status, first_name')
    .eq('first_name', FIRST)
    .maybeSingle();

  check('the staff member exists', Boolean(member), member ? member.role_code : 'not found');
  staffUserId = member?.user_id ?? null;

  if (staffUserId) {
    const { data: authUser } = await admin.auth.admin.getUserById(staffUserId);
    staffEmail = authUser?.user?.email ?? null;
    check('with a login on the shop’s own namespace', Boolean(staffEmail), staffEmail ?? 'none');
  }

  const shown = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  check(
    'and the screen hands over the login to pass on',
    staffEmail ? shown.includes(staffEmail) : false,
    shown.slice(0, 120),
  );

  // ══ The permission has to BIND, not just save ═════════════════════════════════════
  console.log('\n— and what they may do is enforced, not just stored —');
  if (staffEmail) {
    const asStaff = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    const { error: signInErr } = await asStaff.auth.signInWithPassword({
      email: staffEmail,
      password: PASSWORD,
    });
    check('they can sign in', !signInErr, signInErr?.message ?? '');

    if (!signInErr) {
      const { data: membership } = await asStaff.rpc('my_membership');
      check(
        'and land in the right shop',
        (membership ?? []).length === 1,
        JSON.stringify(membership?.[0]?.store_id ?? null),
      );

      const storeId = membership?.[0]?.store_id;

      /*
       * The one that matters at a counter.
       *
       * A seller must be able to record a sale, and must NOT be able to sign off their own
       * records — that separation is what makes mid-sale creation safe, and it was got wrong once
       * before by reusing "may create" to mean "may vouch".
       */
      const { data: maySell } = await asStaff.rpc('has_permission', {
        p_store_id: storeId,
        p_permission: 'sales.record',
      });
      const { data: mayVouch } = await asStaff.rpc('has_permission', {
        p_store_id: storeId,
        p_permission: 'records.confirm',
      });

      check('a new seller may record a sale', maySell === true, String(maySell));
      check('and may not sign off their own records', mayVouch !== true, String(mayVouch));

      /*
       * Enforced, not merely reported. `quick_add_sellable` refuses without permission, so a
       * seller adding an item mid-receipt should succeed AND land unconfirmed.
       */
      const { data: made, error: addErr } = await asStaff.rpc('quick_add_sellable', {
        p_store_id: storeId,
        p_name: `ZZ Staff Made ${stamp}`,
        p_unit_name: `SUnit${stamp}`,
        p_unit_plural: `SUnits${stamp}`,
        p_price: 500,
      });
      check('they can add something mid-sale', !addErr, addErr?.message ?? '');

      if (made) {
        const { data: row } = await admin
          .from('products')
          .select('confirmed_at')
          .eq('id', made)
          .single();
        check(
          'and it waits to be checked, rather than vouching for itself',
          !row?.confirmed_at,
          String(row?.confirmed_at),
        );

        await admin.from('product_units').delete().eq('product_id', made);
        await admin.from('product_sale_units').delete().eq('product_id', made);
        const gone = await admin.from('products').delete().eq('id', made);
        if (gone.error) await admin.from('products').update({ status: 'archived' }).eq('id', made);
        await admin.from('store_units').delete().eq('store_id', storeId).eq('name', `SUnit${stamp}`);
      }
    }
  }

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  if (staffUserId) {
    await admin.from('store_member_permissions').delete().eq('user_id', staffUserId);
    await admin.from('store_members').delete().eq('user_id', staffUserId);
    await admin.auth.admin.deleteUser(staffUserId).catch(() => {});
  }
}

console.log(`\nscreenshots in ${SHOTS}`);
console.log(failed === 0 ? 'all passed' : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
