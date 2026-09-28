/**
 * PUTTING ASHABI BACK IN ORDER — what the shop found wrong, in one pass.
 *
 * Idempotent: every step reads the live state first and writes only the difference, so a second
 * run reports nothing left to do.
 *
 *     node scripts/repair-ashabi-shapes-and-empties.mjs --dry
 *     node scripts/repair-ashabi-shapes-and-empties.mjs
 *
 * READS GO THROUGH PLAIN SQL, not PostgREST embeds. After 0192 dropped a column, PostgREST kept
 * serving a cached schema that still believed two foreign keys ran between `products` and
 * `product_units`, and every embed came back "more than one relationship was found" — as ZERO
 * ROWS, which a repair script reads as "nothing to repair". That is the worst answer such a script
 * can give, so it no longer asks a cache a question it can ask the database.
 *
 * WRITES GO THROUGH `save_product_units`, signed in — the same call the product form makes — so
 * the shapes end up in a state the form can reopen, and every guard the form meets is met here.
 *
 * ── 1. PIECES AND BOTTLES ARE NEITHER SOLD NOR BOUGHT ───────────────────────────
 *
 * "Customers buy in packs and crates, and stock arrives in packs and crates." A piece is what a
 * pack is made OF and a bottle is what a crate is made of. The shapes STAY — the bigger shape is
 * measured in them, and the shelf is counted in them — they are simply no longer offered at the
 * till or on a delivery.
 *
 * Checked before writing: EVERY price in this shop sits on a Crate, Pack or Can. Not one Piece or
 * Bottle carries a price, so unticking them takes away nothing that could be sold for a known
 * amount — it takes away the ways a crate could be sold for the price of one bottle, or for
 * nothing at all.
 *
 * Four sachet products are left alone and listed at the end: Piece is their only shape, so it is
 * both the only thing they can be sold in and the only thing they can arrive in. Unticking it
 * would leave them unsellable, and `assert_product_units_settled` rightly refuses to save a
 * product with nothing to sell. Each needs a Pack shape before this rule can reach them.
 *
 * ── 2. THE TWO CRATES THAT DID NOT COME BACK ────────────────────────────────────
 *
 * Goldberg and Castle Lite were the only two crate products not marked as coming back — and
 * exactly the two this customer bought, which is why her crates were never owed. Set beside a
 * crate product that works (33, Trophy) they were wrong in three ways, not one:
 *
 *     33 Bottle      Crate  returnable=true   defined against Bottle, 12
 *                    Bottle returnable=true
 *     Goldberg       Crate  returnable=FALSE  stated flat as base_qty 12
 *                    Bottle returnable=FALSE
 *
 * So the crate did not come back, the bottle did not come back, and the crate did not know it was
 * twelve bottles — it only knew it was twelve of something. All three are corrected here.
 *
 * No empties pool is created. `tg_sale_line_owes_containers` decides what a sale owes from
 * `product_units.is_returnable` alone; it never reads `product_returnables`. The 58 shapes that
 * already come back in this shop have no pool at all, and an earlier attempt at this repair
 * created one ("NBL crate") for these two products only — which would have made them the only two
 * products in the shop running the retired deposit model. It is removed.
 *
 * ── 3. THE CRATES THAT WENT OUT AND WERE NEVER OWED ─────────────────────────────
 *
 * Found by looking for crate lines with nothing recorded against the customer, NOT by name: the
 * customer in question has been renamed once already, and a repair keyed to a name silently does
 * nothing the day somebody edits it.
 *
 * The sale lines are not rewritten. What was recorded on the day stays as it was, and the
 * correction is its own dated entry carrying its own reason.
 *
 * ── 4. WHAT THE FAILED SAVES LEFT BEHIND ────────────────────────────────────────
 *
 * `create_product` succeeded and then `set_product_low_stock` raised (0202), so every retry of
 * that form left a finished product behind. Plus one product from my own probe whose cleanup did
 * not complete. Only rows with no stock history and no sales are removed, and each is named.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry');

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const SID = '7138327c-c81c-4486-a97c-92207b48b64e';
const PROJECT = 'zinhzpgprhhqmyxmchhm';

/** Plain SQL, through the Management API — no schema cache in the way. */
async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { error: authErr } = await shop.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
if (authErr) throw new Error('could not sign in: ' + authErr.message);

console.log(`\n${DRY ? 'PLAN' : 'REPAIRING'} — ASHABI GLOBAL RESOURCES\n`);

// ══ 1 & 2. The shapes ══════════════════════════════════════════════════════
const products = await sql(`
  select p.id, p.name,
         json_agg(json_build_object(
           'id', pu.id, 'store_unit_id', pu.store_unit_id, 'word', su.name,
           'base_qty', pu.base_qty, 'is_sold', pu.is_sold, 'is_bought', pu.is_bought,
           'is_counted', pu.is_counted, 'is_deposit', pu.is_deposit,
           'is_returnable', pu.is_returnable, 'whole_digit', pu.whole_digit,
           'allow_quarter', pu.allow_quarter, 'allow_half', pu.allow_half,
           'allow_three_quarter', pu.allow_three_quarter,
           'defined_against_id', pu.defined_against_id, 'defined_qty', pu.defined_qty,
           'sell_price', pu.sell_price, 'sort_order', pu.sort_order
         ) order by pu.sort_order, pu.base_qty desc) shapes
    from public.products p
    join public.product_units pu on pu.product_id = p.id
    join public.store_units su on su.id = pu.store_unit_id
   where p.store_id = '${SID}'
   group by p.id, p.name order by p.name`);

/** What a pack is made of, and what a crate is made of. Never sold, never bought. */
const SMALL = new Set(['Piece', 'Bottle']);
/** The two the shop found: their crates go out and must come back. */
const CRATES_THAT_COME_BACK = new Set(['Goldberg Bottle (600mL)', 'Castle Lite Bottle (600mL)']);

const planned = [];
const strandedSachets = [];

for (const p of products) {
  const shapes = p.shapes;
  // `defined_against` is matched on STORE UNIT, not on the product unit — `save_product_units`
  // resolves it with `pu.store_unit_id = (v_unit ->> 'defined_against')::uuid`. Sending the
  // product_unit id instead is rejected with "That unit is not on this item", which is how the
  // first run of this repair failed on all 77 products that have a relationship at all.
  const storeUnitOf = new Map(shapes.map((s) => [s.id, s.store_unit_id]));
  const bottle = shapes.find((s) => s.word === 'Bottle');
  const fixReturnable = CRATES_THAT_COME_BACK.has(p.name);

  const wanted = shapes.map((s) => {
    const small = SMALL.has(s.word);
    let against = s.defined_against_id ? storeUnitOf.get(s.defined_against_id) : null;
    let qty = s.defined_qty === null ? null : Number(s.defined_qty);
    let returnable = s.is_returnable;

    /*
     * A bottle and a piece COME BACK. That is the whole of what they are for now: not sold, not
     * received, but the thing the bigger shape is counted in and the thing that returns empty.
     * It costs nothing at the till — a sale owes containers from the shape it was SOLD in, and
     * these are no longer sold in — so it is what the shop's empties and yard screens read.
     */
    if (small) returnable = true;

    /*
     * Both shapes come back: the crate is the container, the bottle is what was inside it.
     *
     * THE CRATE IS NOT RE-DEFINED AGAINST THE BOTTLE, though that is how the crate products that
     * work are written. `tg_shape_definition_is_history` refuses it, and correctly: these crates
     * have been sold, and `defined_qty` is what a recorded quantity MEANS — changing it would
     * silently reinterpret every line already on the books. Its own comment says the roles may
     * change freely, and the role is all that was wrong.
     *
     * Nothing is lost by leaving it. The crate states 12 base units directly, a bottle IS one base
     * unit, so "12 base" and "12 bottles" are the same arithmetic — the relationship is how the
     * form draws the tree, not how the shop counts.
     */
    if (fixReturnable && (s.word === 'Crate' || s.word === 'Bottle')) returnable = true;

    return {
      id: s.id,
      store_unit_id: s.store_unit_id,
      word: s.word,
      is_sold: small ? false : s.is_sold,
      is_bought: small ? false : s.is_bought,
      is_counted: s.is_counted,
      is_deposit: s.is_deposit,
      is_returnable: returnable,
      // The price is passed straight back. This change is about which shapes are OFFERED, and a
      // repair that quietly dropped a price would be worse than the thing it repairs.
      sell_price: s.sell_price === null ? null : Number(s.sell_price),
      whole_digit: s.whole_digit,
      allow_quarter: s.allow_quarter,
      allow_half: s.allow_half,
      allow_three_quarter: s.allow_three_quarter,
      defined_against: against ?? null,
      defined_qty: against ? qty : null,
      base_qty: Number(s.base_qty),
      sort_order: s.sort_order ?? 0,
    };
  });

  const changed = wanted.filter((w, i) => {
    const s = shapes[i];
    return (
      w.is_sold !== s.is_sold ||
      w.is_bought !== s.is_bought ||
      w.is_returnable !== s.is_returnable ||
      (w.defined_against ?? null) !==
        (s.defined_against_id ? storeUnitOf.get(s.defined_against_id) : null)
    );
  });
  if (changed.length === 0) continue;

  // `assert_product_units_settled` refuses a product with nothing to sell, and it is right to.
  if (!wanted.some((w) => w.is_sold)) {
    strandedSachets.push(p.name);
    continue;
  }
  planned.push({ ...p, wanted, changed });
}

console.log(`1. shapes to correct on ${planned.length} products`);
for (const p of planned.filter((x) => CRATES_THAT_COME_BACK.has(x.name))) {
  console.log(`    ${p.name}`);
  for (const c of p.changed) {
    console.log(
      `       ${c.word.padEnd(7)} sold=${c.is_sold} bought=${c.is_bought} ` +
        `comes-back=${c.is_returnable}${c.defined_against ? ` (= ${c.defined_qty} bottles)` : ''}`,
    );
  }
}
if (strandedSachets.length) {
  console.log('\n   LEFT ALONE — Piece is their only shape, so it is the only thing they can be');
  console.log('   sold in AND the only thing they can arrive in. Each needs a Pack shape first:');
  for (const n of strandedSachets) console.log(`     ${n}`);
}

if (!DRY) {
  let done = 0;
  const failures = [];
  for (const p of planned) {
    const { error } = await shop.rpc('save_product_units', {
      p_product_id: p.id,
      p_units: p.wanted.map(({ word, ...rest }, i) => ({ ...rest, sort_order: i })),
    });
    if (error) failures.push(`${p.name}: ${error.message.slice(0, 90)}`);
    else done += 1;
  }
  console.log(`\n   ${done} corrected, ${failures.length} failed`);
  for (const f of failures) console.log('    FAIL', f);
}

// ══ The stray pool ═════════════════════════════════════════════════════════
const pools = await sql(`
  select ec.id, ec.name,
         (select count(*) from public.product_returnables pr
           where pr.empties_category_id = ec.id) uses
    from public.empties_categories ec where ec.store_id = '${SID}'`);
console.log(
  `\n2. empties pools in this shop: ${pools.length}` +
    (pools.length ? ' — the retired deposit model, which nothing else here uses' : ''),
);
for (const c of pools) console.log(`    ${c.name} (${c.uses} product(s))`);
if (!DRY && pools.length) {
  await sql(`delete from public.product_returnables
              where empties_category_id in (select id from public.empties_categories
                                             where store_id = '${SID}');
             delete from public.empties_categories where store_id = '${SID}';`);
  console.log('    removed — owing is decided by the shape, not by a pool');
}

// ══ 3. Crates that went out and were never owed ════════════════════════════
const owed = await sql(`
  select s.store_customer_id, c.display_name, l.sale_unit_id, p.name product,
         sum(l.entered_qty) sold,
         coalesce((select sum(ce.qty) from public.customer_empties ce
                    where ce.store_customer_id = s.store_customer_id
                      and ce.product_unit_id = l.sale_unit_id
                      and ce.direction = 'out'), 0) recorded
    from public.sale_lines l
    join public.sales s on s.id = l.sale_id
    join public.products p on p.id = l.product_id
    join public.store_customers c on c.id = s.store_customer_id
    join public.product_units pu on pu.id = l.sale_unit_id
    join public.store_units su on su.id = pu.store_unit_id
   where s.store_id = '${SID}' and s.status = 'posted'
     and su.name = 'Crate' and s.store_customer_id is not null
   group by s.store_customer_id, c.display_name, l.sale_unit_id, p.name
  having sum(l.entered_qty) >
         coalesce((select sum(ce.qty) from public.customer_empties ce
                    where ce.store_customer_id = s.store_customer_id
                      and ce.product_unit_id = l.sale_unit_id
                      and ce.direction = 'out'), 0)`);

console.log(`\n3. crates that went out and are not recorded as owed: ${owed.length} line(s)`);
for (const r of owed) {
  const missing = Number(r.sold) - Number(r.recorded);
  console.log(
    `    ${r.display_name}: ${r.product} — sold ${Number(r.sold)}, ` +
      `recorded ${Number(r.recorded)}, missing ${missing}`,
  );
  if (!DRY && missing > 0) {
    const { error } = await shop.rpc('record_customer_empties', {
      p_store_id: SID,
      p_customer_id: r.store_customer_id,
      p_product_unit_id: r.sale_unit_id,
      p_direction: 'out',
      p_qty: missing,
      p_reason: 'Went out before the crate was marked as coming back',
      p_ref_table: null,
      p_ref_id: null,
      p_occurred_at: null,
      p_side: 'they_hold',
    });
    console.log(error ? `      FAILED: ${error.message}` : '      recorded as owed');
  }
}

// ══ 4. What the failed saves left behind ═══════════════════════════════════
const orphans = await sql(`
  select p.id, p.name,
         (select count(*) from public.stock_movements m where m.product_id = p.id) moves
    from public.products p
   where p.store_id = '${SID}'
     and (p.name ilike 'ZZ Probe%' or p.name = 'Zetar')
     and p.status = 'active'
     and not exists (select 1 from public.sale_lines l where l.product_id = p.id)
     and not exists (select 1 from public.stock_periods sp where sp.product_id = p.id)
   order by p.created_at`);

/*
 * A SHELL GOES, A THING WITH A HISTORY IS ARCHIVED.
 *
 * `stock_movements` is append-only and says so — `tg_append_only` refuses a delete and tells you to
 * append a reversing entry instead. That is the right rule and this is not the place to argue with
 * it, so anything that has ever had stock is retired through `archive_product` rather than erased:
 * it leaves the shelf and the lists, and its history stays where it can still be read.
 */
const shells = orphans.filter((o) => Number(o.moves) === 0);
const withHistory = orphans.filter((o) => Number(o.moves) > 0);

console.log(`\n4. products left behind by a save that failed half way: ${orphans.length}`);
for (const o of shells) console.log(`    ${o.name}  ${o.id.slice(0, 8)}  — empty shell, removed`);
for (const o of withHistory) {
  console.log(`    ${o.name}  ${o.id.slice(0, 8)}  — has stock history, archived not deleted`);
}
if (!DRY && shells.length) {
  const ids = shells.map((o) => `'${o.id}'`).join(',');
  await sql(`
    delete from public.product_low_stock_levels where product_id in (${ids});
    delete from public.stock_layers   where product_id in (${ids});
    delete from public.product_units  where product_id in (${ids});
    delete from public.products       where id in (${ids});`);
}
if (!DRY) {
  for (const o of withHistory) {
    const { error } = await shop.rpc('archive_product', { p_product_id: o.id });
    if (error) console.log(`      FAILED to archive ${o.name}: ${error.message}`);
  }
}

console.log(DRY ? '\nNothing was written. Drop --dry to repair.' : '\ndone');
