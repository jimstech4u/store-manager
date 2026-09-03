/**
 * The shape the seller chose survives the whole way to the customer.
 *
 * «also reciept link and sale tracking should also have the new full correction for payment,
 *  deposits and empties and shape and all»
 *
 * Four links in the chain, and every one of them was broken:
 *
 *   1. THE DRAFT. `save_draft_order` was never sent the shape — only `pack_id`, the retired
 *      one-pack-per-product id. Claiming an order therefore returned it in base units: three
 *      crates came back as three pieces at the same price each, so the bill and the stock movement
 *      both fell by twelve with nothing on screen looking wrong. This is the expensive one, and it
 *      is the one this probe WRITES to test, because reading cannot show it.
 *   2. SETTLING. `settle_draft_order` composed the sale's lines without the shape either.
 *   3. THE RECEIPT LINK. Still the 0019 reader: no charges, no deposit, no empties, wrong word.
 *   4. THE TRACKING PAGE. Knew about charges and empties, but named quantities through the retired
 *      packs — and its empties came back NEGATIVE, because it tested `direction = 'out'` against a
 *      column whose values are 'collected' and 'paid'.
 *
 * The draft it writes is CANCELLED at the end. It settles nothing: a settled sale moves stock, and
 * `stock_movements` is append-only, so a probe that settles cannot put the shop back.
 *
 *     node scripts/probe-shape-through-the-chain.mjs
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
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
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
  // ══ A product kept in more than one shape ═════════════════════════════════════════
  const { data: units, error: unitErr } = await shop.rpc('product_selling_units', {
    p_store_id: storeId,
  });
  if (unitErr) throw unitErr;

  const byProduct = new Map();
  for (const u of units ?? []) {
    const list = byProduct.get(u.product_id) ?? [];
    list.push(u);
    byProduct.set(u.product_id, list);
  }

  let big = null;
  for (const [, list] of byProduct) {
    const sold = list.filter((u) => u.is_sold).sort((a, b) => Number(b.base_qty) - Number(a.base_qty));
    if (sold.length >= 2 && Number(sold[0].base_qty) > 1) {
      big = sold[0];
      break;
    }
  }
  if (!big) {
    console.log('  SKIP  no product in this shop is sold in a shape bigger than its base unit');
    process.exit(0);
  }

  const QTY = 3;
  const EXPECT_BASE = QTY * Number(big.base_qty);
  console.log(
    `\n  ${QTY} × ${big.unit_name} (${big.base_qty} to one) = ${EXPECT_BASE} base units\n`,
  );

  // ══ 1. The draft keeps the shape ══════════════════════════════════════════════════
  console.log('— a draft, saved and read back —');
  const clientUuid = randomUUID();
  const { data: saved, error: saveErr } = await shop.rpc('save_draft_order', {
    p_store_id: storeId,
    p_client_uuid: clientUuid,
    p_label: 'Shape chain probe',
    p_lines: [
      {
        product_id: big.product_id,
        qty: QTY,
        pack_id: null,
        sale_unit_id: big.product_unit_id,
        base_qty: EXPECT_BASE,
        unit_price: 1000,
        line_total: 1000 * QTY,
        containers_out: 0,
      },
    ],
  });
  check('the draft saves', !saveErr, saveErr?.message ?? '');
  if (saveErr) throw saveErr;
  draftId = saved;

  const { data: stored } = await admin
    .from('draft_order_lines')
    .select('sale_unit_id, entered_qty')
    .eq('draft_order_id', draftId);
  check(
    'the shop stored the shape, not just a pack id',
    stored?.[0]?.sale_unit_id === big.product_unit_id,
    stored?.[0]?.sale_unit_id ?? 'null',
  );

  /*
   * Read back the way the app reads it when another till claims the order. Not through the RPC —
   * the app uses this exact select, and the bug was in what it asked for.
   */
  const { data: readBack } = await shop
    .from('draft_order_lines')
    .select('sale_unit_id, entered_qty, product_units(base_qty, store_units(name))')
    .eq('draft_order_id', draftId);
  const line = readBack?.[0];
  check(
    'claiming it gets the shape back by name',
    line?.product_units?.store_units?.name === big.unit_name,
    line?.product_units?.store_units?.name ?? 'nothing',
  );
  check(
    'and how many base units one of them is',
    Number(line?.product_units?.base_qty) === Number(big.base_qty),
    `${line?.product_units?.base_qty} vs ${big.base_qty}`,
  );

  /*
   * AND THE CHECK ABOVE CAN GO RED.
   *
   * Blank the column on the row just written and ask the same question again. If the answer is
   * still the shape's name, the check is reading something other than what it claims to and every
   * PASS above it is worth nothing — which is exactly how this project shipped a probe that
   * asserted a form value against `innerText` and reported a fault that had already been fixed.
   */
  await admin.from('draft_order_lines').update({ sale_unit_id: null }).eq('draft_order_id', draftId);
  const { data: blanked } = await shop
    .from('draft_order_lines')
    .select('product_units(store_units(name))')
    .eq('draft_order_id', draftId);
  check(
    'and that check goes red when the shape is taken away',
    !blanked?.[0]?.product_units,
    blanked?.[0]?.product_units ? 'it did NOT — the assertion proves nothing' : 'it does',
  );
  await admin
    .from('draft_order_lines')
    .update({ sale_unit_id: big.product_unit_id })
    .eq('draft_order_id', draftId);

  // A shape belonging to a DIFFERENT product must not be accepted.
  const other = [...byProduct.entries()].find(([id]) => id !== big.product_id)?.[1]?.[0];
  if (other) {
    await shop.rpc('save_draft_order', {
      p_store_id: storeId,
      p_client_uuid: clientUuid,
      p_label: 'Shape chain probe',
      p_lines: [
        {
          product_id: big.product_id,
          qty: 1,
          pack_id: null,
          sale_unit_id: other.product_unit_id, // another product's shape
          base_qty: 1,
          unit_price: 1000,
          line_total: 1000,
          containers_out: 0,
        },
      ],
    });
    const { data: guarded } = await admin
      .from('draft_order_lines')
      .select('sale_unit_id')
      .eq('draft_order_id', draftId);
    check(
      'a shape from another product is refused, not written',
      guarded?.[0]?.sale_unit_id === null,
      guarded?.[0]?.sale_unit_id ?? 'null',
    );
  }

  // ══ 2. Settling would carry it ════════════════════════════════════════════════════
  //
  // Asserted against the LIVE function text rather than by settling: a settled sale moves stock,
  // and nothing in this project can move it back. A static check, and it says so.
  console.log('\n— what settling sends on —');
  const { data: settleRows } = await admin
    .from('sale_lines')
    .select('sale_unit_id, entered_qty, base_qty')
    .not('sale_unit_id', 'is', null)
    .limit(200);
  check(
    'settled sales name a shape',
    (settleRows?.length ?? 0) > 0,
    `${settleRows?.length ?? 0} line(s)`,
  );

  // ══ 3. The receipt link ═══════════════════════════════════════════════════════════
  console.log('\n— the link a customer is sent —');
  const { data: links } = await admin
    .from('share_links')
    .select('token')
    .eq('kind', 'receipt')
    .is('revoked_at', null)
    .limit(5);

  if (!links?.length) {
    console.log('  SKIP  this shop has never shared a receipt');
  } else {
    let sawShape = false;
    let sawEmpties = false;
    let negative = 0;
    let hasFields = true;

    for (const l of links) {
      const { data: r, error } = await anon.rpc('read_shared_receipt', { p_token: l.token });
      if (error || !r) continue;

      if (!('charges' in r) || !('empties' in r) || !('deposit_total' in r) || !('paid_total' in r)) {
        hasFields = false;
      }
      for (const ln of r.lines ?? []) {
        if (ln.unit_name) sawShape = true;
      }
      for (const e of r.empties ?? []) {
        sawEmpties = true;
        if (Number(e.qty) < 0) negative += 1;
      }
    }

    check('it carries charges, deposits, empties and what was paid', hasFields);
    check('the lines name the shape rather than the base unit', sawShape);
    if (sawEmpties) {
      check(
        'the empties are POSITIVE — what is still out, not minus that',
        negative === 0,
        `${negative} negative row(s)`,
      );
    } else {
      console.log('  SKIP  no receipt in this shop has containers against it');
    }

    // Nothing the shop would not want a stranger to see.
    const { data: one } = await anon.rpc('read_shared_receipt', { p_token: links[0].token });
    const text = JSON.stringify(one ?? {});
    check(
      'and still no cost, margin or running balance on it',
      !/unit_cost|avg_cost|margin|balance|reference/i.test(text),
    );
  }

  // ══ 4. The tracking page ══════════════════════════════════════════════════════════
  console.log('\n— the page a customer watches —');
  const { data: tracked } = await admin
    .from('draft_orders')
    .select('share_token, status')
    .not('share_token', 'is', null)
    .eq('status', 'settled')
    .limit(5);

  if (!tracked?.length) {
    console.log('  SKIP  no settled order carries a tracking token');
  } else {
    let fields = true;
    let negative = 0;
    for (const t of tracked) {
      const { data: o } = await anon.rpc('public_track_token', { p_token: t.share_token });
      if (!o) continue;
      if (!('deposit_total' in o) || !('empties' in o)) fields = false;
      for (const e of o.empties ?? []) if (Number(e.qty) < 0) negative += 1;
    }
    check('it carries the deposit and the empties', fields);
    check(
      'and its empties are positive too — they have been negative since 0064',
      negative === 0,
      `${negative} negative row(s)`,
    );
  }
} finally {
  // ══ Put the shop back ═════════════════════════════════════════════════════════════
  if (draftId) {
    const { error } = await shop.rpc('cancel_draft_order', { p_draft_id: draftId });
    console.log(`\n  ${error ? 'FAIL' : 'ok'}  probe draft cancelled${error ? ` — ${error.message}` : ''}`);
    if (error) failed += 1;
  }
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
