/**
 * A product belongs to several groups, and a shop can make one without leaving the form.
 *
 * «product group like NBL and Guiness … selectable in selectionviewer and new added mid addition
 *  just like customerpicker and product picker … each can even have multiple top groups»
 *
 * `product_categories` held three rows from the day the shop was seeded and every product form sent
 * `p_category_id: null`, so a category was displayed on the stock list and could never be chosen on
 * the form that owns it. A field that cannot change anything is worse than a missing one, because
 * it looks answered.
 *
 * The half a scan could never have found is the SHAPE: one category per product cannot say what a
 * shop means. Goldberg is a Beer, it comes in a PET bottle, and it is an NBL product — three
 * groupings answering three different questions, and a distributor uses all of them.
 *
 * WRITES a group and links, and cleans both up: `product_category_links` is an ordinary table, not
 * a ledger, so it can be undone honestly.
 *
 *     node scripts/probe-product-groups.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

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

const NAME = `Probe brewery ${Date.now().toString().slice(-5)}`;
let made = null;
let subject = null;
let before = [];

try {
  // ══ What was already there ════════════════════════════════════════════════════════
  console.log('— what the shop already meant —');
  const { data: existing, error: readErr } = await shop.rpc('store_product_groups', {
    p_store_id: storeId,
  });
  check('the shop can read its own groups', !readErr, readErr?.message ?? '');
  if (readErr) throw readErr;
  console.log(`      ${(existing ?? []).map((g) => `${g.name} (${g.products})`).join(', ')}`);

  /*
   * The three seeded categories carry their products, which proves the backfill.
   *
   * `products.category_id` was the single category and 0093 turned each one into a link. If that
   * had silently done nothing, every count here would be zero and the shop would have quietly lost
   * the only grouping it had.
   */
  check(
    'the categories it already had kept their products',
    (existing ?? []).some((g) => Number(g.products) > 0),
    (existing ?? []).map((g) => `${g.name}:${g.products}`).join(' '),
  );

  // ══ Making one, the way the picker does ═══════════════════════════════════════════
  console.log('\n— making one from inside the form —');
  const { data: id, error: makeErr } = await shop.rpc('create_product_group', {
    p_store_id: storeId,
    p_name: NAME,
  });
  check('a group can be made', !makeErr, makeErr?.message ?? '');
  if (makeErr) throw makeErr;
  made = id;

  /*
   * ASKING FOR IT AGAIN RETURNS THE SAME ONE.
   *
   * This is called by somebody typing "NBL" into a picker who does not know whether it exists. An
   * error there would be the app telling a shop off for not remembering its own data, and a second
   * row would leave two groups with one name and no way to tell the products apart.
   */
  const { data: again } = await shop.rpc('create_product_group', {
    p_store_id: storeId,
    p_name: NAME.toLowerCase(),
  });
  check('asking again returns the same one, whatever the casing', again === made, `${again}`);

  // ══ Several at once, which is the whole point ═════════════════════════════════════
  console.log('\n— a product is in more than one —');
  const { data: products } = await shop
    .from('products')
    .select('id, name, category_id')
    .eq('store_id', storeId)
    .eq('status', 'active')
    .limit(1);
  subject = products?.[0];
  check('there is a product to put in them', subject != null, subject?.name ?? '');
  if (!subject) throw new Error('no product');

  before = ((await shop.rpc('product_groups_for', { p_product_id: subject.id })).data ?? []).map(
    (g) => g.id,
  );

  const wanted = [made, ...(existing ?? []).slice(0, 2).map((g) => g.id)];
  const { error: setErr } = await shop.rpc('set_product_groups', {
    p_product_id: subject.id,
    p_group_ids: wanted,
  });
  check('several groups save at once', !setErr, setErr?.message ?? '');
  if (setErr) throw setErr;

  const { data: nowIn } = await shop.rpc('product_groups_for', { p_product_id: subject.id });
  check(
    'and all of them come back',
    (nowIn ?? []).length === wanted.length,
    (nowIn ?? []).map((g) => g.name).join(', '),
  );

  /*
   * AND THE OLD COLUMN IS KEPT IN STEP.
   *
   * The stock list, the product page and `list_products` all still read `products.category_id`.
   * `set_product_groups` points it at the first group so those screens go on working — one writer,
   * named, which is the only kind of denormalisation worth having.
   */
  const { data: row } = await admin
    .from('products')
    .select('category_id')
    .eq('id', subject.id)
    .single();
  check(
    'the column the stock list still reads points at the first group',
    row?.category_id === wanted[0],
    `${row?.category_id}`,
  );

  // ══ Somebody else's group is refused ══════════════════════════════════════════════
  console.log('\n— and the server does not take anything it is given —');
  const { error: foreign } = await shop.rpc('set_product_groups', {
    p_product_id: subject.id,
    p_group_ids: ['00000000-0000-0000-0000-000000000001'],
  });
  check(
    'a group that is not this shop’s is refused',
    foreign != null,
    foreign?.message?.slice(0, 60) ?? 'it was ACCEPTED',
  );

  // ══ Retiring ══════════════════════════════════════════════════════════════════════
  console.log('\n— retiring one —');
  const { error: archErr } = await shop.rpc('archive_product_group', {
    p_category_id: made,
    p_restore: false,
  });
  check('a group can be retired', !archErr, archErr?.message ?? '');

  const { data: offered } = await shop.rpc('store_product_groups', { p_store_id: storeId });
  check(
    'it stops being offered',
    !(offered ?? []).some((g) => g.id === made),
    `${(offered ?? []).length} still offered`,
  );

  const { data: stillOn } = await shop.rpc('product_groups_for', { p_product_id: subject.id });
  check(
    'but the product keeps it — a receipt that says it should go on saying it',
    (stillOn ?? []).some((g) => g.id === made),
    (stillOn ?? []).map((g) => g.name).join(', '),
  );
} finally {
  console.log('\n— putting it back —');
  if (subject) {
    const { error } = await shop.rpc('set_product_groups', {
      p_product_id: subject.id,
      p_group_ids: before,
    });
    console.log(`  ${error ? 'FAIL' : 'ok'}  the product's groups restored${error ? ` — ${error.message}` : ''}`);
    if (error) failed += 1;
  }
  if (made) {
    // `product_categories` is an ordinary table, not a ledger, so the probe's own row goes.
    const { error } = await admin.from('product_categories').delete().eq('id', made);
    console.log(`  ${error ? 'FAIL' : 'ok'}  probe group removed${error ? ` — ${error.message}` : ''}`);
    if (error) failed += 1;
  }
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
