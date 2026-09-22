/**
 * How often a waiting update asks again — the shop's own answer, kept (0158).
 *
 * Thirty minutes to begin with: long enough not to nag somebody serving a queue, short enough that
 * a fix reaches the counter the same morning. A shop that would rather be asked at closing time
 * chooses twelve hours. What is checked here is the part that can silently break — the column, the
 * save, and the read back — not the timer, which is a `setTimeout`.
 *
 *     node scripts/probe-update-reminder-setting.mjs [http://localhost:3101]
 */

import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3101';
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

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await db.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const { data: membership } = await db.rpc('my_membership');
const storeId = (membership.find((m) => m.store_name === env.SAMPLE_STORE) ?? membership[0]).store_id;
const before = (await db.rpc('ensure_store_settings', { p_store_id: storeId })).data;
check('a shop that has never chosen waits the default', before.update_reminder_minutes >= 5, `${before.update_reminder_minutes} minutes`);

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const chosen = () => p.locator('#update-reminder').inputValue();

try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(15000);

  console.log('  … signed in, at', (await p.url()).replace(BASE, ''));
  await p.screenshot({ path: 'C:/Users/ajibe/AppData/Local/Temp/claude/c--Users-ajibe-StudioProjects-academix-project/e777c9cb-0458-4485-8d5b-33a59e6c79c6/scratchpad/settings-stall.png' });
  const bar = await p.evaluate(() => [...document.querySelectorAll('.nav-item')].map((el) => ({
    text: (el.textContent || '').trim().slice(0, 10),
    shown: el.offsetParent !== null,
  })));
  console.log('  … nav bar:', JSON.stringify(bar));
  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(5000);
  console.log('  … on', (await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 60));
  check('the choice is on the settings screen', (await p.locator('#update-reminder').count()) > 0);
  check('and starts where the shop left it', (await chosen()) === String(before.update_reminder_minutes), await chosen());

  // Choose four hours and save it the way a shop does.
  await p.locator('#update-reminder').selectOption('240');
  await p.getByRole('button', { name: /Save settings/i }).locator('visible=true').first().click();
  await p.waitForTimeout(5000);

  const saved = (await db.rpc('ensure_store_settings', { p_store_id: storeId })).data;
  check('the shop’s answer reaches the database', saved.update_reminder_minutes === 240, `${saved.update_reminder_minutes} minutes`);

  // And comes back on the next look, which is what every other till will read.
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(12000);
  await p.locator('.nav-item').filter({ hasText: /^More$/ }).first().click();
  await p.waitForTimeout(6000);
  check('and is what the screen shows afterwards', (await chosen()) === '240', await chosen());
} catch (e) {
  console.log('STOPPED:', String(e).split('\n')[0]);
  failed += 1;
} finally {
  // Left as it was found: this is a real shop's settings.
  await db
    .from('store_settings')
    .update({ update_reminder_minutes: before.update_reminder_minutes })
    .eq('store_id', storeId);
  await browser.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
