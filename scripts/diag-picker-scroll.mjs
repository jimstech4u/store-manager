/**
 * Which element scrolls inside an open selection viewer — measured, not assumed.
 *
 *     node scripts/diag-picker-scroll.mjs [http://localhost:3100]
 */
import { chromium } from '@playwright/test';
import { trackDrafts } from './probe-drafts.mjs';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

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
const startedAt = new Date().toISOString();

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
// Only the tabs THIS browser saves are ever cleaned up — never the shop's own (see probe-drafts).
const PROBE_DRAFTS = trackDrafts(p);
try {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  await p.locator('input[type="email"]').first().fill(env.SAMPLE_EMAIL);
  await p.locator('input[type="password"]').first().fill(env.SAMPLE_PASSWORD);
  await p.locator('button[type="submit"]').first().click();
  await p.waitForTimeout(12000);
  const addItem = p.getByRole('button', { name: /Add an item/i }).first();
  await addItem.waitFor({ state: 'visible', timeout: 120000 });
  await addItem.click();
  await p.waitForTimeout(6000);

  const chain = await p.evaluate(() => {
    const c = [...document.querySelectorAll('.selection-viewer-content')].find(
      (el) => el.getBoundingClientRect().height > 0,
    );
    const out = [];
    for (let el = c; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      out.push({
        cls: (el.className || el.tagName).toString().slice(0, 60),
        sh: el.scrollHeight,
        ch: el.clientHeight,
        oy: cs.overflowY,
        h: Math.round(el.getBoundingClientRect().height),
      });
    }
    return out;
  });
  console.table(chain);
} finally {
  await browser.close();
  const { data: mine } = await admin
    .from('draft_orders').select('id').eq('status', 'open').in('client_uuid', [...PROBE_DRAFTS]);
  const ids = (mine ?? []).map((d) => d.id);
  if (ids.length) {
    await admin.from('draft_order_lines').delete().in('draft_order_id', ids);
    await admin.from('draft_orders').delete().in('id', ids);
  }
}
