/**
 * THE SHOP'S OPENING INVENTORY, entered the way the app enters it.
 *
 * 103 distinct products from the stock sheet, with their shapes, what is on the shelf and when it goes
 * off. Through `create_product`, `save_product_units` and `open_stock_by_count` — the same RPCs
 * the product form calls — because an importer that writes rows directly succeeds while the app
 * is broken, which is the one thing an importer must never do.
 *
 *     node scripts/import-opening-inventory.mjs --dry     # print the plan, write nothing
 *     node scripts/import-opening-inventory.mjs           # do it
 *     node scripts/import-opening-inventory.mjs --resume  # finish an interrupted run safely
 *     node scripts/import-opening-inventory.mjs --sync-shapes
 *                                                   # repair shapes; preserve stock and prices
 *
 * ── WHAT A NUMBER IN A COLUMN MEANS ─────────────────────────────────────────────
 *
 * The sheet counts each product in whichever shapes it is stocked in, and a BLANK means that
 * shape does not apply to that product while a ZERO means it applies and there are none. Both are
 * kept: a shape with nothing in it is still a shape the shop sells in.
 *
 * Halves are real. "5.5 Crate(s)" is five crates and six bottles. The Can(s) column is cans, so
 * "19.5" is nineteen and a half cans; the shop deliberately permits halves in that shape.
 *
 * ── THE CONVERSIONS, AND WHERE THEY COME FROM ───────────────────────────────────
 *
 * Crates are twelve unless the shop said otherwise, and it named the exceptions. PET packs are
 * twelve, which the Nigerian market confirms — Coke, Fanta and Sprite 50cl and 60cl all ship
 * x12. Cans are their own selling/counting shape; the sheet does not describe trays.
 *
 * Sachet sizes are product-specific. The supplied Eagle Majesty carton confirms 24 sachets per
 * pack and 14 packs per carton; the Chelsea pouch confirms 24 per pack. Any conversion not shown
 * on an actual package remains `null`, so the importer never invents stock.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry');
const RESUME = process.argv.includes('--resume');
const SYNC_SHAPES = process.argv.includes('--sync-shapes');

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

// ── The conversions ─────────────────────────────────────────────────────────
//
// A crate holds twelve unless it is named here. The shop gave these from the shelf.
const CRATE = {
  'Desperado Bottle (450mL)': 20,
  'Heineken Small Bottle (450mL)': 20,          // "medium Heineken" — see the note at the end
  'Star Radler Bottle (45cl)': 20,
  'Smirnoff Ice Small Bottle (300mL)': 24,
  'Guinness Small Bottle (325mL)': 24,
  'Coca-Cola Small Bottle Black (35cl)': 24,
  'Coca-Cola Small Bottle Red (35cl)': 24,
  'Coca-Cola Big Bottle (50cl)': 24,
  'Maltina Classic Bottle (33cl)': 24,
  'Fayrouz Bottle (330mL)': 24,
  'Amstel Malta Bottle (330mL)': 24,
  'Pepsi Bottle (50cl)': 24,
  '7up Bottle (35cl)': 24,
};
const CRATE_DEFAULT = 12;
const PACK_PET = 12; // confirmed: Nigerian PET ships x12

// Sachets do not share one market-wide conversion.  These are the package markings supplied
// from the actual stock: both are 30mL x 24, while the Eagle Majesty carton says x 14 packs.
// Keep every unshown carton as `null` rather than making its opening count up.
const SACHET = {
  'Chelsea London Dry Gin Sachet (30mL)': { pack: 24, carton: null },
  'Eagle Original Aromatic Schnapps Majesty Sachet (30mL)': { pack: 24, carton: 24 * 14 },
};
// The corrected Action rows are cartons of twelve bottles. Their old arithmetic happened to total
// correctly, but it described the shelf as packs/pieces instead of the cartons/bottles it holds.
const CARTON = {
  'Action Bitters PET (200mL)': 12,
  'Action Bitters Bottle (325mL)': 12,
  // Hollandia 1L cartons are x10 (confirmed by Nigerian retailers).
  'Hollandia Yoghurt (1L)': 10,
};
// These products are carried in a crate but the shop does not sell their loose bottles.
const NOT_SOLD = {
  'Origin Bottle (60cl)': new Set(['Bottle']),
};

/*
 * The sheet, transcribed. `c` crate, `b` bottle, `ct` carton, `p` pack, `cn` can, `pc` piece.
 * `undefined` is a blank column; `0` is a shape with none in it. `x` is the expiry date.
 */
const SHEET = [
  ['33 Bottle (600mL)', { c: 5.5 }, '2027-03-20'],
  ['5-Alive Pulpy Orange Small PET (30cl)', { p: 7 }, '2027-02-06'],
  ['5-Alive Pulpy Orange Big PET (85cl)', { p: 58 }, '2027-03-16'],
  ['7up Bottle (35cl)', { c: 5, b: 10 }, '2027-04-01'],
  ['7up PET (60cl)', { p: 37, pc: 2 }, '2026-09-11'],
  ['Action Bitters PET (200mL)', { ct: 12, pl: 12 }, '2029-01-18'],
  ['Action Bitters Bottle (325mL)', { ct: 3, b: 6 }, '2029-01-09'],
  ['Action Bitters Sachet (50mL)', { pc: 14 }, null],
  ['Aje Big Cola PET (250mL)', { p: 25 }, '2026-07-15'],
  ['American Cola PET (60cl)', { p: 1093, pc: 7 }, '2027-02-26'],
  ['Amstel Malta Bottle (330mL)', { c: 6, b: 23 }, '2027-05-21'],
  ['Amstel Malta Can (330mL)', { cn: 21 }, '2027-08-09'],
  ['Aqua Vie PET (750mL)', { p: 723, pc: 3 }, '2027-06-27'],
  ['Aquafina PET (75cl)', { p: 2 }, '2027-07-02'],
  ['Best London Dry Gin Sachet (30mL)', { ct: 0, p: 13, pc: 0 }, null],
  ['Bigi Apple PET (350mL)', { p: 184 }, '2027-02-04'],
  ['Bigi Bitter Lemon PET (600mL)', { p: 1 }, '2026-12-20'],
  ['Bigi Cola PET (350mL)', { p: 322 }, '2027-02-06'],
  ['Bigi Tropical PET (350mL)', { p: 361 }, '2027-01-25'],
  ['Bigi Water PET (750mL)', { p: 238 }, '2027-02-25'],
  ['Brixton PET (75cl)', { p: 4 }, '2027-08-20'],
  ['Budweiser Bottle (600mL)', { c: 11 }, '2027-02-05'],
  ['Cedaa Yoghurt PET (35cl)', { p: 40 }, '2026-12-07'],
  ['Chelsea London Dry Gin Sachet (30mL)', { ct: 4, p: 13, pc: 2 }, null],
  ['Chivita Active (1L)', { p: 5.5 }, '2027-05-11'],
  ['Chivita Active Zest Can (330mL)', { cn: 3 }, '2027-12-22'],
  ['Chivita Exotic (1L)', { p: 5.5 }, '2027-04-10'],
  ['Cielo PET (740mL)', { p: 34 }, '2026-12-22'],
  ['Coca-Cola Small Bottle Black (35cl)', { c: 10, b: 5 }, '2026-11-04'],
  ['Coca-Cola Small Bottle Red (35cl)', { c: 1.5 }, '2026-11-13'],
  ['Coca-Cola Small PET (50cl)', { p: 86 }, '2027-02-10'],
  ['Coca-Cola Big Bottle (50cl)', { c: 18, b: 9 }, '2027-06-01'],
  ['Coca-Cola Big PET (60cl)', { p: 123 }, '2027-01-24'],
  ['Desperado Bottle (450mL)', { c: 12.5 }, '2027-02-18'],
  ['Dispenser Water', { p: 47 }, null],
  ['Dudu Mixed Fruit Drink PET (500mL)', { p: 91 }, '2027-08-06'],
  ['Dudu Yoghurt PET (500mL)', { p: 39 }, '2027-03-06'],
  ['Dudu Yoghurt Can (500mL)', { cn: 30 }, '2027-01-22'],
  ['Eagle Original Aromatic Schnapps Majesty Sachet (30mL)', { ct: 3, p: 8, pc: 14 }, null],
  ['Eagle Aromatic Schnapps Bottle (750mL)', { b: 1, ct: 3 }, null],
  ['Eaglejie Sachet (50mL)', { pc: 8 }, null],
  ["Elder's Aromatic Schnapps Sachet (30mL)", { pc: 3 }, null],
  ['Eva Big PET (150cl)', { p: 4 }, '2027-06-20'],
  ['Eva Small PET (75cl)', { p: 19 }, '2027-07-27'],
  ['Fanta Small PET (50cl)', { p: 155 }, '2027-02-09'],
  ['Fanta Big PET (60cl)', { p: 67, pc: 6 }, '2027-01-20'],
  ['Fayrouz Bottle (330mL)', { c: 19.5 }, '2027-05-01'],
  ['Fayrouz Can (330mL)', { cn: 17 }, '2027-08-06'],
  ['Fearless Energy Drink PET (500mL)', { p: 124 }, '2027-01-25'],
  ['Fearless Energy Drink Can (500mL)', { cn: 1 }, null],
  ['Flying Fish Bottle (420mL)', { c: 1, b: 0 }, '2026-09-28'],
  ['Fresh Yo PET (375mL)', { p: 18 }, '2026-12-01'],
  ['Goldberg Can (500mL)', { cn: 21 }, '2027-06-13'],
  ['Goldberg Bottle (600mL)', { c: 137 }, '2027-05-22'],
  ['Guilder Bottle (600mL)', { c: 7.5 }, '2027-01-04'],
  ['Guinness Small Bottle (325mL)', { c: 13, b: 12 }, '2027-06-05'],
  ['Guinness Can (440mL)', { cn: 1 }, '2027-08-23'],
  ['Guinness Medium Bottle (450mL)', { c: 5 }, '2027-08-05'],
  ['Guinness Big Bottle (600mL)', { c: 56 }, '2027-07-29'],
  ['Heineken Small Bottle (450mL)', { c: 8.5 }, '2027-02-07'],
  ['Heineken Big Bottle (600mL)', { c: 56 }, '2027-02-11'],
  ['Heineken Original Can (33cl)', { cn: 19.5 }, '2027-09-02'],
  ['Hero Bottle (600mL)', { c: 13 }, null],
  ['Hollandia Yoghurt (1L)', { ct: 3.5 }, '2027-01-27'],
  ['La Casera PET (35cl)', { p: 288, pc: 11 }, '2027-01-20'],
  ['La Qua PET (75cl)', { p: 268 }, '2027-06-12'],
  ['Legend Extra Stout Bottle (60cl)', { c: 15 }, '2027-12-24'],
  ['Lite Can (599mL)', { cn: 3 }, '2026-11-27'],
  ['Castle Lite Bottle (600mL)', { c: 22.5 }, '2027-03-05'],
  ['Lucozade Boost PET (450mL)', { p: 6.5 }, '2027-04-15'],
  ['Malta Guinness Can (330mL)', { cn: 133.5 }, '2027-07-18'],
  ['Maltina Classic Bottle (33cl)', { c: 0.5 }, '2027-03-25'],
  ['Maltina Classic Can (33cl)', { cn: 20 }, '2027-06-25'],
  ['Maltina Classic Small PET (35cl)', { p: 170 }, '2026-12-26'],
  ['Maltina Classic Big PET (50cl)', { p: 75.5 }, '2027-02-07'],
  ['Mr. V PET (75cl)', { p: 180, pc: 11 }, '2027-09-02'],
  ['Nutri Choco PET (400mL)', { p: 94 }, '2027-05-12'],
  ['Nutri-Milk PET (500mL)', { p: 51 }, '2026-10-14'],
  ['Origin Bottle (60cl)', { c: 0.5, b: 6 }, '2027-07-24'],
  ['Origin Bitters PET (20cl)', { p: 1, pc: 6 }, '2028-06-19'],
  ['Origin Bitters Bottle (750mL)', { c: 3, b: 2 }, '2028-05-07'],
  ['Pepsi Bottle (50cl)', { c: 50, b: 6 }, '2027-06-01'],
  ['Pepsi PET (60cl)', { p: 590, pc: 6 }, '2027-03-15'],
  ['Predator Energy PET (400mL)', { p: 37 }, '2027-03-09'],
  ['Schweppes Can (25cl)', { cn: 2 }, '2026-12-05'],
  ['Schweppes PET (40cl)', { p: 16 }, '2026-12-01'],
  ['Smirnoff Ice Small Bottle (300mL)', { c: 15, b: 22 }, '2027-05-22'],
  ['Smirnoff Ice Can (440mL)', { cn: 14.5 }, '2027-04-01'],
  ['Smirnoff Ice Big Bottle (600mL)', { c: 6 }, '2027-07-06'],
  ['Sosa Big PET (1L)', { p: 92 }, '2027-02-20'],
  ['Sosa Small PET (35cl)', { p: 42 }, '2027-02-16'],
  ['Sprite PET (50cl)', { p: 1 }, '2027-02-02'],
  ['Star Radler Bottle (45cl)', { c: 1, b: 13 }, '2026-10-13'],
  ['Striker Bitters Sachet (50mL)', { ct: 0, p: 3, pc: 0 }, null],
  ['Supa Komando Bottle (25cl)', { c: 34, b: 17 }, '2027-02-01'],
  ['Supa Komando Small PET (30cl)', { p: 99 }, '2026-12-01'],
  ['Supa Komando Big PET (50cl)', { p: 9 }, '2026-11-27'],
  ['Teem PET (50cl)', { p: 81, pc: 8 }, '2027-03-15'],
  ['Trophy Can (500mL)', { cn: 29 }, '2027-02-07'],
  ['Trophy Bottle (600mL)', { c: 90.5 }, '2027-01-09'],
  ['Trophy Stout (600mL)', { c: 9, b: 3 }, '2027-03-14'],
  ['Turbo King Bottle (60cl)', { c: 13.5 }, '2028-01-26'],
  ['Vijn Milk Chocolate PET (500mL)', { p: 38 }, '2027-02-10'],
];

/*
 * The sheet lists "Fresh Yo PET (375mL)" twice with the same figures, at rows 52 and 53. Almost
 * certainly one line entered twice rather than two products of identical name, size and expiry —
 * and creating it twice would give the shop two rows nobody can tell apart in a picker. Imported
 * once; say so if it really is two.
 */

/** Which shapes a product has, largest first, and what each is worth in base units. */
function shapesFor(name, counts) {
  const crate = CRATE[name] ?? CRATE_DEFAULT;
  /*
   * A SACHET PACK IS NOT A PET PACK.
   *
   * The first version gave every Pack column the PET twelve, so thirteen packs of Best London
   * Dry Gin came in as 156 sachets on the strength of a number that is about Coca-Cola. A pack
   * of sachets is its own thing: use a package-marked conversion where supplied and otherwise
   * leave it unknown for correction rather than guess.
   *
   * Cartons are unknown for the same reason, and they are not even one thing: a carton of
   * sachets and a carton of 750mL bottles are different counts.
   */
  const isSachet = /sachet/i.test(name);
  const sachet = SACHET[name];
  const out = [];
  if (counts.ct !== undefined) {
    out.push({
      key: 'ct',
      unit: 'Carton',
      per: CARTON[name] ?? (isSachet ? (sachet?.carton ?? null) : null),
    });
  }
  if (counts.c !== undefined) out.push({ key: 'c', unit: 'Crate', per: crate });
  if (counts.p !== undefined) {
    out.push({ key: 'p', unit: 'Pack', per: isSachet ? (sachet?.pack ?? null) : PACK_PET });
  }
  if (counts.cn !== undefined) out.push({ key: 'cn', unit: 'Can', per: 1 });
  if (counts.b !== undefined) out.push({ key: 'b', unit: 'Bottle', per: 1 });
  if (counts.pl !== undefined) out.push({ key: 'pl', unit: 'Plastic', per: 1 });
  if (counts.pc !== undefined) out.push({ key: 'pc', unit: 'Piece', per: 1 });

  /*
   * A crate or a pack implies the thing it is made OF, even where the sheet shows no loose ones.
   * A shop that has only full crates today still sells single bottles tomorrow, and a product
   * with no small shape cannot be sold as one.
   */
  const hasSmall = out.some((s) => s.per === 1);
  if (!hasSmall && out.length > 0) {
    const looseUnit = out.some((s) => s.unit === 'Pack') ? 'Piece' : 'Bottle';
    out.push({ key: null, unit: looseUnit, per: 1 });
  }

  // Crated drinks arrive by crate. Individual bottles remain sellable/countable and returnable,
  // but are not a purchase shape. This keeps a receipt in the shape the supplier actually used.
  const isCrated = counts.c !== undefined;
  for (const shape of out) {
    shape.isBought = !(isCrated && shape.unit === 'Bottle');
    shape.isReturnable = isCrated;
    // A Piece is the arithmetic inside a pack, not something this shop sells. Keep it only
    // where it is the sole usable shape (for example, an individual sachet product).
    shape.isSold =
      !(shape.unit === 'Piece' && out.some((other) => other.unit === 'Pack')) &&
      !NOT_SOLD[name]?.has(shape.unit);
  }
  return out;
}

/** State each known large shape in terms of the next smaller shape, not just a bare base total. */
function relationFor(shape, shapes, unitIds) {
  const child =
    shape.unit === 'Crate' ? 'Bottle' :
    shape.unit === 'Carton'
      ? (shapes.some((s) => s.unit === 'Pack') ? 'Pack' : shapes.some((s) => s.unit === 'Plastic') ? 'Plastic' : 'Bottle')
      :
    shape.unit === 'Pack' ? 'Piece' :
    null;
  const childShape = child ? shapes.find((s) => s.unit === child) : null;
  if (!childShape || shape.per === null || childShape.per === null || childShape.per === 0) {
    return { defined_against: null, defined_qty: null };
  }
  return {
    defined_against: unitIds.get(child),
    defined_qty: shape.per / childShape.per,
  };
}

const unknown = [];

function planFor([name, counts, expiry]) {
  const shapes = shapesFor(name, counts);
  let base = 0;
  let uncertain = false;
  for (const s of shapes) {
    const n = s.key ? (counts[s.key] ?? 0) : 0;
    if (s.per === null) {
      if (n > 0) uncertain = true;
      continue;
    }
    base += n * s.per;
  }
  if (uncertain) unknown.push(name);
  return { name, shapes, base, expiry, uncertain };
}

const PLAN = SHEET.map(planFor);

if (DRY) {
  const pad = (v, n) => String(v).slice(0, n).padEnd(n);
  const lpad = (v, n) => String(v).padStart(n);
  console.log(`${pad('PRODUCT', 40)} ${pad('SHAPES', 30)} ${lpad('ON HAND', 9)}  EXPIRY`);
  for (const p of PLAN) {
    const shapes = p.shapes.map((s) => `${s.unit}${s.per === null ? '(?)' : `x${s.per}`}`).join(' ');
    console.log(
      `${pad(p.name, 40)} ${pad(shapes, 30)} ${lpad(p.base, 9)}  ${p.expiry ?? '—'}` +
        (p.uncertain ? '   <- conversion unknown' : ''),
    );
  }
  console.log(`\n${PLAN.length} products. ${unknown.length} need a conversion before their count is right:`);
  for (const u of unknown) console.log('   ', u);
  console.log('\nNothing was written. Drop --dry to import.');
  process.exit(0);
}

// ── Doing it ────────────────────────────────────────────────────────────────
const { error: authErr } = await shop.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
if (authErr) throw new Error('could not sign in: ' + authErr.message);

const { data: stores } = await shop.from('stores').select('id, name').limit(1);
const store = stores[0];
console.log(`\nimporting into ${store.name}\n`);

/** The shop's measuring words, made once and reused. */
const unitIds = new Map();
for (const word of ['Carton', 'Crate', 'Pack', 'Can', 'Bottle', 'Plastic', 'Piece']) {
  const { data, error } = await shop.rpc('create_store_unit', {
    p_store_id: store.id,
    p_name: word,
    p_plural: `${word}s`,
  });
  if (error) throw new Error(`unit ${word}: ${error.message}`);
  unitIds.set(word, data);
}
console.log(`  ${unitIds.size} measuring words ready`);

let made = 0;
let skipped = 0;
let repaired = 0;
let synced = 0;
const failed = [];

// An interrupted import must never recreate a product or post its opening stock a second time.
// This is deliberately opt-in: a normal run still makes any duplicate-name failure conspicuous.
const existingProducts = new Map();
if (RESUME || SYNC_SHAPES) {
  const { data, error } = await shop.from('products').select('id, name').eq('store_id', store.id);
  if (error) throw new Error(`could not prepare recovery: ${error.message}`);
  for (const product of data) existingProducts.set(product.name, product.id);
  /* The sheet's Lite can is 599mL. Correct the old transcribed name before matching its shape,
     otherwise a shape sync would create a second product for the same stock. */
  const oldLiteName = 'Lite Can (500mL)';
  const correctedLiteName = 'Lite Can (599mL)';
  const oldLiteId = existingProducts.get(oldLiteName);
  if (oldLiteId && !existingProducts.has(correctedLiteName)) {
    const { error: renameError } = await shop.rpc('update_product', {
      p_product_id: oldLiteId,
      p_name: correctedLiteName,
      p_sku: null,
      p_barcode: null,
      p_category_id: null,
      p_list_price: null,
    });
    if (renameError) throw new Error(`could not correct Lite can name: ${renameError.message}`);
    existingProducts.delete(oldLiteName);
    existingProducts.set(correctedLiteName, oldLiteId);
  }
  if (RESUME) console.log(`  resuming: ${existingProducts.size} existing products will be left unchanged`);
}

// Shape repair changes only the schema of a product's measuring words. Preserve a price the
// owner already entered for the same word; a stock import must never erase a deliberate price.
const existingUnits = new Map();
if (SYNC_SHAPES) {
  const ids = [...existingProducts.values()];
  const { data, error } = await shop
    .from('product_units')
    .select('id, product_id, store_unit_id, sell_price')
    .in('product_id', ids);
  if (error) throw new Error(`could not read existing shapes: ${error.message}`);
  for (const unit of data) existingUnits.set(`${unit.product_id}:${unit.store_unit_id}`, unit);
  console.log(`  syncing the shapes of ${existingProducts.size} existing products; prices stay as entered`);
}

for (const p of PLAN) {
  try {
    let productId = existingProducts.get(p.name) ?? null;
    let repairing = false;
    if (productId && SYNC_SHAPES) {
      synced += 1;
    } else if (productId) {
      skipped += 1;
      continue;
    }
    if (!productId) {
      const { data, error: pErr } = await shop.rpc('create_product', {
        p_store_id: store.id,
        p_name: p.name,
        // `base_unit` is the database's physical stock basis (a sachet, bottle or can is one
        // piece).  `Bottle` and `Can` below are product shapes, not database base-unit names.
        p_base_unit: 'piece',
        p_pack_name: null,
        p_pack_qty: null,
        p_list_price: null,
        p_price_per_pack: false,
      });
      if (pErr) throw new Error(pErr.message);
      productId = data;
    }

    const { error: uErr } = await shop.rpc('save_product_units', {
      p_product_id: productId,
      p_units: p.shapes.map((s) => ({
        id: SYNC_SHAPES ? (existingUnits.get(`${productId}:${unitIds.get(s.unit)}`)?.id ?? null) : null,
        store_unit_id: unitIds.get(s.unit),
        is_bought: s.isBought,
        is_counted: true,
        is_deposit: false,
        is_sold: s.isSold,
        sell_price: SYNC_SHAPES
          ? (existingUnits.get(`${productId}:${unitIds.get(s.unit)}`)?.sell_price ?? null)
          : null,
        is_returnable: s.isReturnable,
        /*
         * COUNTED, because a crate comes in ones and halves of one — it is not weighed.
         *
         * This said `false`, which is "any amount at all", and it went out over all 104 products.
         * `partsFor` returns no part-buttons for a weighed thing, so every shape showed "Halves
         * too" in the product form and offered no half at the till, while accepting 0.43 crates
         * from anyone who typed it. 0204 corrects the rows and makes the server refuse the
         * combination; this is where it was written.
         */
        whole_digit: true,
        allow_quarter: false,
        // Halves everywhere: the sheet has 5.5 crates and 133.5 can trays, and the shop confirmed
        // both are real.
        allow_half: true,
        allow_three_quarter: false,
        ...relationFor(s, p.shapes, unitIds),
        base_qty: s.per ?? 1,
      })),
    });
    if (uErr) throw new Error(uErr.message);

    if (p.base > 0 && !SYNC_SHAPES) {
      const { error: sErr } = await shop.rpc('open_stock_by_count', {
        p_store_id: store.id,
        p_product_id: productId,
        p_qty: p.base,
        p_unit_cost: null,
        p_note: 'Opening inventory',
        p_batches: p.expiry ? [{ qty: p.base, expires_on: p.expiry }] : null,
      });
      if (sErr) throw new Error(sErr.message);
    }

    if (!repairing) made += 1;
    process.stdout.write(`\r  ${made}/${PLAN.length} products`);
  } catch (e) {
    failed.push(`${p.name}: ${String(e.message ?? e).slice(0, 90)}`);
  }
}

/*
 * The original can quantities were correct; `--sync-shapes` changes only their shape label.
 * the missing base units — never replace or hide an opening record. The guard makes this idempotent
 */
console.log(`\n\n  ${made} created, ${synced} shapes synced, ${skipped} left unchanged, ${failed.length} failed`);
for (const f of failed) console.log('   FAIL', f);
if (unknown.length) {
  console.log('\n  these came in with their shapes but a conversion still to set:');
  for (const u of unknown) console.log('   ', u);
}
