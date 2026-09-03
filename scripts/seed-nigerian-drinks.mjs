/**
 * Real stock for a Nigerian drinks distributor, entered as SHAPES.
 *
 * Every product here is a shape tree — a bottle, and a crate or pack that holds twelve of them —
 * and everything else points at a shape rather than redefining one: bought in the crate, sold in
 * the crate AND the bottle, counted in the crate, returned in the crate.
 *
 * ── ON THE PRICES ──────────────────────────────────────────────────────────────────
 *
 * The web could not give current figures. Indexed Nigerian wholesale pages return prices that are
 * mutually inconsistent and clearly years stale — ₦2,500 for a crate of 24 Gulder, ₦5,000–6,000
 * for Star, figures from roughly 2018–2020 presented as current. Seeding those would put numbers
 * in a shop's database that are wrong by a factor of three, and wrong figures that LOOK researched
 * are worse than obvious placeholders.
 *
 * So: the structure is exact — real brands, real bottle sizes, real pack counts, correct returnable
 * pools by brewer — and the money is an explicit ESTIMATE at 2026 levels, flagged as such in the
 * database. `cost_is_estimated` is already how this app says "the owner's guess, corrected by the
 * next real delivery", and every cost here is set through the path that raises that flag.
 *
 * Correct the sell prices in one place — the item's units screen — and the shop is straight.
 *
 *     node scripts/seed-nigerian-drinks.mjs [--clean]
 *
 * `--clean` also archives the probe litter this shop has accumulated (121 products named
 * "AAA …", "ZZ …", "Test …"), which is most of its catalogue.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const CLEAN = process.argv.includes('--clean');

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

const storeId = (await admin.from('stores').select('id, name').limit(1).single()).data.id;

/*
 * ── The catalogue ──────────────────────────────────────────────────────────────────
 *
 * `pool` names the empties category. Beer is returnable and the pool is per BREWER, because that is
 * the real rule: a Nigerian Breweries crate does not settle an International Breweries obligation,
 * however similar they look. PET drinks are not returnable at all — the bottle leaves with the
 * customer.
 *
 * `crateSell` / `bottleSell` are the ESTIMATES described above. `costRatio` is the distributor's
 * side of it — what the load costs against what it sells for — and 0.85 is a 15% margin, which is
 * the ordinary shape of this trade.
 */
const CATALOGUE = [
  // ── Nigerian Breweries ───────────────────────────────────────────────────────────
  { name: 'Star Lager 60cl',            outer: 'Crate', per: 12, crateSell: 15000, bottleSell: 1400, pool: 'NBL', cost: 0.85 },
  { name: 'Gulder 60cl',                outer: 'Crate', per: 12, crateSell: 15000, bottleSell: 1400, pool: 'NBL', cost: 0.85 },
  { name: 'Life Continental Lager 60cl',outer: 'Crate', per: 12, crateSell: 12500, bottleSell: 1150, pool: 'NBL', cost: 0.86 },
  { name: 'Legend Extra Stout 60cl',    outer: 'Crate', per: 12, crateSell: 16500, bottleSell: 1500, pool: 'NBL', cost: 0.85 },
  { name: 'Heineken 60cl',              outer: 'Crate', per: 12, crateSell: 19500, bottleSell: 1750, pool: 'NBL', cost: 0.87 },

  // ── International Breweries ──────────────────────────────────────────────────────
  { name: 'Trophy Lager 60cl',          outer: 'Crate', per: 12, crateSell: 11000, bottleSell: 1000, pool: 'IB',  cost: 0.86 },
  { name: 'Hero Lager 60cl',            outer: 'Crate', per: 12, crateSell: 12000, bottleSell: 1100, pool: 'IB',  cost: 0.86 },

  // ── Guinness Nigeria ─────────────────────────────────────────────────────────────
  { name: 'Guinness Foreign Extra Stout 60cl', outer: 'Crate', per: 12, crateSell: 19000, bottleSell: 1700, pool: 'GUIN', cost: 0.87 },

  // ── PET soft drinks — nothing comes back ─────────────────────────────────────────
  { name: 'Coca-Cola PET 50cl',         outer: 'Pack', per: 12, crateSell: 5400, bottleSell: 500, pool: null, cost: 0.88 },
  { name: 'Fanta Orange PET 50cl',      outer: 'Pack', per: 12, crateSell: 5400, bottleSell: 500, pool: null, cost: 0.88 },
  { name: 'Sprite PET 50cl',            outer: 'Pack', per: 12, crateSell: 5400, bottleSell: 500, pool: null, cost: 0.88 },
  { name: 'Pepsi PET 50cl',             outer: 'Pack', per: 12, crateSell: 5200, bottleSell: 480, pool: null, cost: 0.88 },
  { name: '7Up PET 50cl',               outer: 'Pack', per: 12, crateSell: 5200, bottleSell: 480, pool: null, cost: 0.88 },
  { name: 'Bigi Cola PET 50cl',         outer: 'Pack', per: 12, crateSell: 4200, bottleSell: 400, pool: null, cost: 0.89 },
  { name: 'Bigi Chapman PET 50cl',      outer: 'Pack', per: 12, crateSell: 4200, bottleSell: 400, pool: null, cost: 0.89 },
  { name: 'La Casera Apple PET 50cl',   outer: 'Pack', per: 12, crateSell: 4800, bottleSell: 450, pool: null, cost: 0.88 },
];

/** Pools, by brewer. Content = the bottle itself; container = the crate it travels in. */
const POOLS = {
  NBL:  { bottle: 'NBL bottle',      crate: 'NBL crate',      bottleDeposit: 200, crateDeposit: 2500 },
  IB:   { bottle: 'IB bottle',       crate: 'IB crate',       bottleDeposit: 200, crateDeposit: 2400 },
  GUIN: { bottle: 'Guinness bottle', crate: 'Guinness crate', bottleDeposit: 250, crateDeposit: 2800 },
};

const say = (m) => console.log(`  ${m}`);

// ══ Units the shop keeps ═══════════════════════════════════════════════════════════
async function unitId(name, plural) {
  const { data: found } = await admin
    .from('store_units').select('id').eq('store_id', storeId).ilike('name', name).maybeSingle();
  if (found) return found.id;
  const { data, error } = await admin
    .from('store_units').insert({ store_id: storeId, name, plural }).select('id').single();
  if (error) throw error;
  return data.id;
}

// ══ Pools ══════════════════════════════════════════════════════════════════════════
async function poolId(name, kind, deposit) {
  const { data: found } = await admin
    .from('empties_categories').select('id').eq('store_id', storeId).ilike('name', name).maybeSingle();
  if (found) return found.id;
  const { data, error } = await admin
    .from('empties_categories').insert({ store_id: storeId, name, kind, deposit }).select('id').single();
  if (error) throw error;
  return data.id;
}

console.log('\n— clearing the way —');
if (CLEAN) {
  /*
   * ARCHIVED, NEVER DELETED.
   *
   * `stock_movements` is append-only and refuses a delete, so a product that has ever traded cannot
   * be removed — and should not be: its history is somebody's receipt. Archiving takes it out of
   * every picker and leaves the record intact, which is exactly what the status column is for.
   */
  const { data: junk } = await admin
    .from('products').select('id, name').eq('store_id', storeId).eq('status', 'active');
  const litter = (junk ?? []).filter((p) =>
    /^(AAA|ZZ|Test|Cost probe|Probe|FIFO sale probe|H)\b/i.test(p.name) || p.name.trim() === 'H',
  );
  for (const p of litter) {
    await admin.from('products').update({ status: 'archived' }).eq('id', p.id);
  }
  say(`archived ${litter.length} probe products`);

  const { data: units } = await admin.from('store_units').select('id, name').eq('store_id', storeId);
  const junkUnits = (units ?? []).filter((u) =>
    /^(RCrate|RKeg|PLitre|PBag|TCase|MUnit|FUnit|SUnit|Test)/i.test(u.name),
  );
  let removed = 0;
  for (const u of junkUnits) {
    const { error } = await admin.from('store_units').delete().eq('id', u.id);
    if (!error) removed += 1; // one still referenced by an archived product simply stays
  }
  say(`removed ${removed} of ${junkUnits.length} probe units`);
} else {
  say('(pass --clean to archive the probe litter too)');
}

console.log('\n— the shapes every product is built from —');
const shapes = {
  Bottle: await unitId('Bottle', 'Bottles'),
  Crate: await unitId('Crate', 'Crates'),
  Pack: await unitId('Pack', 'Packs'),
};
say(`Bottle, Crate, Pack`);

console.log('\n— the pools empties settle against —');
const pools = {};
for (const [key, p] of Object.entries(POOLS)) {
  pools[key] = {
    bottle: await poolId(p.bottle, 'content', p.bottleDeposit),
    crate: await poolId(p.crate, 'container', p.crateDeposit),
  };
  say(`${p.bottle} · ${p.crate}`);
}

console.log('\n— the catalogue —');
let added = 0;
let updated = 0;

for (const item of CATALOGUE) {
  const { data: existing } = await admin
    .from('products').select('id').eq('store_id', storeId).ilike('name', item.name).maybeSingle();

  let productId = existing?.id;
  if (!productId) {
    const { data, error } = await admin
      .from('products')
      .insert({
        store_id: storeId,
        name: item.name,
        base_unit: 'piece',
        status: 'active',
        // Seeded by the owner, so it needs no review — the same rule `create_product` applies when
        // the caller may sign off their own records.
        confirmed_at: new Date().toISOString(),
        avg_unit_cost: Math.round((item.bottleSell * item.cost) * 100) / 100,
        cost_is_estimated: true,
      })
      .select('id').single();
    if (error) { console.log(`  FAILED ${item.name}: ${error.message}`); continue; }
    productId = data.id;
    added += 1;
  } else {
    updated += 1;
  }

  /*
   * ── The shape tree ───────────────────────────────────────────────────────────────
   *
   * The BOTTLE is the root: base_qty 1, defined against nothing. The crate is defined AS twelve of
   * them — `defined_against_id` + `defined_qty` — and `base_qty` is derived from that by a trigger,
   * never typed. One sentence, "a crate is 12 bottles", and every other screen reads it: stock,
   * cost, counting, deposits.
   */
  await admin.from('product_units').delete().eq('product_id', productId);

  const { data: bottle, error: bErr } = await admin
    .from('product_units')
    .insert({
      product_id: productId,
      store_unit_id: shapes.Bottle,
      base_qty: 1,
      is_bought: false,
      is_sold: true,
      sell_price: item.bottleSell,
      is_returnable: Boolean(item.pool),
      whole_digit: true,
      sort_order: 1,
    })
    .select('id').single();
  if (bErr) { console.log(`  FAILED ${item.name} bottle: ${bErr.message}`); continue; }

  const { error: cErr } = await admin.from('product_units').insert({
    product_id: productId,
    store_unit_id: item.outer === 'Crate' ? shapes.Crate : shapes.Pack,
    base_qty: item.per,
    defined_against_id: bottle.id,
    defined_qty: item.per,
    is_bought: true,
    is_sold: true,
    sell_price: item.crateSell,
    is_returnable: Boolean(item.pool),
    /*
     * WHOLE ONES AND HALVES — 1, 1.5, 2, 2.5.
     *
     * A shop that sells half crates says so once, here, and every sale screen then offers exactly
     * those quantities and refuses the rest. That is what stops "4.3 crates" reaching a receipt.
     */
    whole_digit: true,
    allow_half: item.outer === 'Crate',
    sort_order: 0,
  });
  if (cErr) { console.log(`  FAILED ${item.name} ${item.outer}: ${cErr.message}`); continue; }

  // ── What comes back ────────────────────────────────────────────────────────────
  if (item.pool) {
    const p = pools[item.pool];
    await admin.from('product_returnables').delete().eq('product_id', productId);
    await admin.from('product_returnables').insert([
      // One bottle back per bottle sold — derived from the quantity.
      { product_id: productId, empties_category_id: p.bottle, qty_per_base_unit: 1 },
      // The crate is declared at the till: six loose bottles may or may not leave in one.
      { product_id: productId, empties_category_id: p.crate, qty_per_base_unit: null },
    ]);
  }

  say(
    `${item.name.padEnd(38)} ${item.outer.toLowerCase()} of ${item.per} · ` +
      `₦${item.crateSell.toLocaleString()} / ₦${item.bottleSell.toLocaleString()}` +
      (item.pool ? ` · ${POOLS[item.pool].crate}` : ' · not returnable'),
  );
}

console.log(`\n  ${added} added, ${updated} already there and re-shaped.`);
console.log(
  '\n  Prices are ESTIMATES at 2026 levels — the web has no reliable current Nigerian wholesale\n' +
    '  figures, only 2018–2020 numbers presented as current. Structure, brands, sizes, pack counts\n' +
    '  and pools are exact. Correct the money on each item’s units screen.',
);
