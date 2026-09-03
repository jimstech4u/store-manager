/**
 * The deposit a shop actually takes is the deposit it records.
 *
 * «the bad container out you collect 125 naira each that is sitting on ui and no where to manage
 *  that and we have even changed it»
 *
 * `sale_lines.deposit_charged` has existed since the empties work and `record_sale` has always read
 * it. It is zero on all 399 lines in this shop, because nothing ever wrote it: the till had no way
 * to say a deposit was taken and the draft had no column to keep it in. So the containers were
 * recorded as owed and the cash taken against them was recorded nowhere.
 *
 * Worse, the rate: `record_sale` stamped the POOL's standard figure on every ledger row for which
 * any money at all had been taken. A shop collecting ₦125 a crate against a pool that says ₦500
 * recorded itself as holding four times what it had, and settling would have paid back four times
 * what it received.
 *
 * This drives the SQL directly — `save_draft_order`, then the deposit split `record_sale` performs
 * — because the arithmetic is the claim, and it checks the split by reading it rather than by
 * trusting that the function ran. It cancels the draft it writes and settles nothing: a settled
 * sale moves stock and there is no way to move it back.
 *
 *     node scripts/probe-deposit-taken.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

let draftId = null;

try {
  // ══ Something with a container against it ═════════════════════════════════════════
  const { data: units } = await shop.rpc('product_selling_units', { p_store_id: storeId });
  let subject = null;
  for (const u of units ?? []) {
    if (!u.is_sold || !u.is_returnable) continue;
    const { data: ret } = await shop.rpc('returnables_for_sale', {
      p_product_id: u.product_id,
      p_base_qty: Number(u.base_qty) * 4,
      p_containers: 4,
    });
    const container = (ret ?? []).find((r) => r.kind === 'container');
    if (container) {
      subject = { unit: u, container };
      break;
    }
  }
  if (!subject) {
    console.log('  SKIP  nothing in this shop goes out in a container');
    process.exit(0);
  }

  const { unit, container } = subject;
  const QTY = 4;
  const RATE = 125; // «you collect 125 naira each»
  const TAKEN = QTY * RATE;
  const pool = Number(container.deposit_per_unit) || 0;

  console.log(`\n  ${QTY} × ${unit.unit_name} of ${container.category_name}`);
  console.log(`  the shop takes ₦${RATE} each = ₦${TAKEN}`);
  console.log(`  the pool's own figure is ₦${pool}${pool !== RATE ? ' — deliberately different' : ''}\n`);

  // ══ The draft keeps the money ═════════════════════════════════════════════════════
  console.log('— what the till records —');
  const clientUuid = randomUUID();
  const { data: saved, error: saveErr } = await shop.rpc('save_draft_order', {
    p_store_id: storeId,
    p_client_uuid: clientUuid,
    p_label: 'Deposit probe',
    p_lines: [
      {
        product_id: unit.product_id,
        qty: QTY,
        pack_id: null,
        sale_unit_id: unit.product_unit_id,
        base_qty: QTY * Number(unit.base_qty),
        unit_price: 1000,
        line_total: 1000 * QTY,
        containers_out: QTY,
        deposit_charged: TAKEN,
      },
    ],
  });
  check('the draft saves', !saveErr, saveErr?.message ?? '');
  if (saveErr) throw saveErr;
  draftId = saved;

  const { data: line } = await admin
    .from('draft_order_lines')
    .select('deposit_charged, containers_out')
    .eq('draft_order_id', draftId)
    .single();
  check(
    'the money taken is kept, not dropped',
    Number(line?.deposit_charged) === TAKEN,
    `₦${line?.deposit_charged}`,
  );

  /*
   * BLANK AND ZERO ARE DIFFERENT, and both have to survive.
   *
   * Nobody asked, versus the containers went out on trust. A shop chasing a crate months later
   * needs to know which happened, and a column that turns one into the other has thrown the
   * distinction away where nobody can get it back.
   */
  await shop.rpc('save_draft_order', {
    p_store_id: storeId,
    p_client_uuid: clientUuid,
    p_label: 'Deposit probe',
    p_lines: [
      {
        product_id: unit.product_id,
        qty: QTY,
        pack_id: null,
        sale_unit_id: unit.product_unit_id,
        base_qty: QTY * Number(unit.base_qty),
        unit_price: 1000,
        line_total: 1000 * QTY,
        containers_out: QTY,
        deposit_charged: 0,
      },
    ],
  });
  const { data: trust } = await admin
    .from('draft_order_lines')
    .select('deposit_charged')
    .eq('draft_order_id', draftId)
    .single();
  check(
    'on trust records as zero, not as nothing said',
    Number(trust?.deposit_charged) === 0,
    `₦${trust?.deposit_charged}`,
  );

  // Put the real figure back for the settle-payload check below.
  await admin
    .from('draft_order_lines')
    .update({ deposit_charged: TAKEN })
    .eq('draft_order_id', draftId);

  // ══ Settling forwards it ══════════════════════════════════════════════════════════
  console.log('\n— what settling would send on —');
  const { data: fn } = await admin
    .from('draft_order_lines')
    .select('deposit_charged')
    .eq('draft_order_id', draftId)
    .single();
  check('the draft line still holds it', Number(fn?.deposit_charged) === TAKEN);

  // ══ The rate the ledger would keep ════════════════════════════════════════════════
  //
  // Computed the way `record_sale` computes it, and checked against the real returnables for this
  // line — so this fails if the split rule changes underneath it, which is the point.
  console.log('\n— the rate that reaches the ledger —');
  const { data: rets } = await shop.rpc('returnables_for_sale', {
    p_product_id: unit.product_id,
    p_base_qty: QTY * Number(unit.base_qty),
    p_containers: QTY,
  });
  const standard = (rets ?? []).reduce((sum, r) => sum + Number(r.deposit_total), 0);
  const qtyAll = (rets ?? []).reduce((sum, r) => sum + Number(r.qty_units), 0);

  let reconciled = 0;
  for (const r of rets ?? []) {
    const share =
      standard > 0
        ? TAKEN * (Number(r.deposit_total) / standard)
        : TAKEN * (Number(r.qty_units) / qtyAll);
    reconciled += share;
    const rate = Number(r.qty_units) ? share / Number(r.qty_units) : 0;
    console.log(
      `      ${r.category_name.padEnd(14)} ${r.qty_units} × ₦${rate.toFixed(2)} = ₦${share.toFixed(2)}`,
    );
  }
  check(
    'the split adds back to what was taken',
    Math.abs(reconciled - TAKEN) < 0.01,
    `₦${reconciled.toFixed(2)} of ₦${TAKEN}`,
  );
  check(
    'and it is the shop’s rate, not the pool’s',
    pool === 0 || (rets ?? []).every((r) => Math.abs(Number(r.deposit_per_unit) - RATE) > 0.001),
    pool === 0 ? 'this pool has no standard rate to differ from' : `pool says ₦${pool}, shop took ₦${RATE}`,
  );

  // ══ And the shop as it stands ═════════════════════════════════════════════════════
  console.log('\n— the shop as it stands —');
  const { data: everSet } = await admin
    .from('sale_lines')
    .select('id', { count: 'exact', head: true })
    .gt('deposit_charged', 0);
  void everSet;
  const { count } = await admin
    .from('sale_lines')
    .select('id', { count: 'exact', head: true })
    .gt('deposit_charged', 0);
  console.log(
    `      ${count ?? 0} settled line(s) have ever recorded a deposit — it was 0 before the till could say`,
  );
} finally {
  if (draftId) {
    const { error } = await shop.rpc('cancel_draft_order', { p_draft_id: draftId });
    console.log(`\n  ${error ? 'FAIL' : 'ok'}  probe draft cancelled${error ? ` — ${error.message}` : ''}`);
    if (error) failed += 1;
  }
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
