/**
 * Close abandoned, EMPTY customer tabs.
 *
 * Every tab holds a spoken order code reserved against it, and the customer bar on the sell screen
 * is a horizontal strip a seller scrolls through. Hundreds of empty ones — mostly opened by probes
 * tapping "Start another customer" and never cleaned up — push the real ones off the end.
 *
 * ONLY EMPTY, AND ONLY OLD. A tab with a single line on it is somebody's sale and is never touched.
 * A tab opened in the last two hours is left alone too: it may be open on a counter right now with
 * a customer standing there deciding, and the cost of being wrong is a seller watching their order
 * vanish.
 *
 * THROUGH THE SHOP'S OWN RPC, not by writing the columns.
 *
 * Setting `status` and blanking `code` directly fails — `code` is NOT NULL — and that refusal is
 * the table saying the recycling is not a column edit. `cancel_draft_order` is what frees a code
 * for the next order, and it is the same path the Close button on the till uses, so this script
 * cannot get it subtly different from the app.
 *
 *     node scripts/close-empty-tabs.mjs           # says what it would do
 *     node scripts/close-empty-tabs.mjs --commit  # does it
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const COMMIT = process.argv.includes('--commit');

/** A tab younger than this could be open on a counter right now. */
const LEAVE_ALONE_HOURS = 2;

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

/*
 * Signed in as the shop, because cancelling is a permission-checked action.
 *
 * The service key can read whatever it likes; it must not be the thing that decides an order may
 * be cancelled. `cancel_draft_order` reads the caller from auth.uid() and answers for itself.
 */
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });

const cutoff = new Date(Date.now() - LEAVE_ALONE_HOURS * 3600_000).toISOString();

const { data: open, error } = await admin
  .from('draft_orders')
  .select('id, code, created_at, label')
  .eq('status', 'open')
  .lt('created_at', cutoff)
  .order('created_at');

if (error) {
  console.error('Could not read the open tabs:', error.message);
  process.exit(1);
}

const empty = [];
for (const d of open ?? []) {
  const { count } = await admin
    .from('draft_order_lines')
    .select('id', { count: 'exact', head: true })
    .eq('draft_order_id', d.id);
  if ((count ?? 0) === 0) empty.push(d);
}

console.log(`open tabs older than ${LEAVE_ALONE_HOURS}h: ${(open ?? []).length}`);
console.log(`  of those, empty: ${empty.length}`);
console.log(`  with something on them, so left alone: ${(open ?? []).length - empty.length}`);

if (!COMMIT) {
  console.log('\nNothing changed. Re-run with --commit to close the empty ones.');
  process.exit(0);
}

let closed = 0;
for (const d of empty) {
  const { error: err } = await shop.rpc('cancel_draft_order', { p_draft_id: d.id });
  if (err) {
    console.error(`  could not close ${d.code ?? d.id}: ${err.message}`);
  } else {
    closed += 1;
  }
}

console.log(`\nclosed ${closed} empty tab(s); their codes are free again`);
