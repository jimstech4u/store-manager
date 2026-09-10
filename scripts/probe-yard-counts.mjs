/**
 * The yard can be counted, and the count reaches the figure.
 *
 * Two faults, both of which put a WRONG NUMBER on screen rather than leaving a feature missing.
 *
 * `empties_counts` was keyed by the retired pool, and `yard_empties` reached a count through
 * `product_returnables` — where eight of the sample shop's ten rows have a null `product_unit_id`.
 * So every count the shop had entered was unreachable, every shape reported `counted = 0`, and the
 * yard was a bare movement sum:
 *
 *     Goldberg Crates: in_yard = -4587, counted = 0, out_to_customers = 4760
 *
 * And the yard weighed five of the nine ways a container moves. `scripts/probe-supplier-account.mjs`
 * recorded a `they_hold` `out` of 25 and then asserted the yard had moved by −20 — the answer
 * WITHOUT that movement. It passed, and it was encoding the gap as the expected result.
 *
 * MUTATION TEST. Restore either half of the old function and this fails:
 *   · drop the `product_unit_id` branch from `yard_empties`'s `shape_count` → "a count reaches the
 *     yard" fails, because the figure stays null after counting.
 *   · drop the four added movement classes → "every way a container moves is weighed" fails.
 *
 *     node scripts/probe-yard-counts.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const NL = String.fromCharCode(10);

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
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/** One shape's row out of the yard reader. */
const yardFor = async (shapeId) =>
  ((await shop.rpc('yard_empties', { p_store_id: storeId })).data ?? []).find(
    (y) => y.product_unit_id === shapeId,
  );

const groupRow = async (groupId, unitId) =>
  ((await shop.rpc('yard_empties_by_group', { p_store_id: storeId })).data ?? []).find(
    (g) => g.group_id === groupId && g.store_unit_id === unitId,
  );

const stamp = Date.now().toString().slice(-6);
let supplierId = null;
let customerId = null;

try {
  // ── What there is to count ────────────────────────────────────────────────────────
  console.log(NL + '— what comes back —');
  const { data: countable, error: ce } = await shop.rpc('countable_empties', {
    p_store_id: storeId,
  });
  check('the shop can be asked what it has to count', !ce, ce?.message ?? '');
  if (ce) throw new Error(ce.message);

  /*
   * A shape in a GROUP with at least one sibling, because the group half of this probe needs one.
   * Picked from the shop's own answer rather than named here — a probe that hard-codes "Goldberg"
   * stops testing anything the day somebody retires it.
   */
  const byGroup = new Map();
  for (const c of countable) {
    if (!c.group_id) continue;
    const key = `${c.group_id}::${c.store_unit_id}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(c);
  }
  const family = [...byGroup.values()].sort((a, b) => b.length - a.length)[0];
  check('there is something that comes back', (countable ?? []).length > 0, `${countable.length} shapes`);
  if (!family || family.length < 2) {
    console.log('  SKIP  no group with two shapes in it — the group half cannot be proved here');
  }
  const shape = family[0];
  const sibling = family[1];

  // ── Never counted is not zero ─────────────────────────────────────────────────────
  console.log(NL + '— before anybody counts —');

  /*
   * THE BUG, STATED AS A FIGURE.
   *
   * Before this migration a shape nobody had ever counted reported a number: the movements alone,
   * which for Goldberg crates is −4,587 in a shop that has never been short of a crate. A position
   * nobody has established is not a position, and reporting one is how a shop is told it has lost
   * four thousand crates it never lost.
   */
  const virgin = (countable ?? []).find(
    (c) => c.product_unit_id !== shape.product_unit_id && c.product_unit_id !== sibling?.product_unit_id,
  );
  if (virgin) {
    const row = await yardFor(virgin.product_unit_id);
    check(
      'a yard nobody has counted says so, rather than inventing a figure',
      row && row.in_yard === null && row.counted === null && row.counted_grain === null,
      `in_yard=${row?.in_yard} counted=${row?.counted}`,
    );
  }

  // ── A count reaches the yard ──────────────────────────────────────────────────────
  console.log(NL + '— counting a stack —');
  const { error: c1 } = await shop.rpc('count_empties', {
    p_store_id: storeId,
    p_parts: [{ product_unit_id: shape.product_unit_id, qty: 40 }],
    p_note: `probe ${stamp}`,
  });
  check('a shape can be counted', !c1, c1?.message ?? '');
  if (c1) throw new Error(c1.message);

  const counted = await yardFor(shape.product_unit_id);
  check(
    'a count reaches the yard',
    counted && Number(counted.counted) === 40 && Number(counted.in_yard) === 40,
    `counted=${counted?.counted} in_yard=${counted?.in_yard} grain=${counted?.counted_grain}`,
  );
  check(
    'and it is stamped with when, because the date is half the fact',
    !!counted?.counted_at,
    counted?.counted_at ?? 'no date',
  );

  /*
   * ZERO IS AN ANSWER and a blank is not.
   *
   * "None in the yard" and "nobody looked" are different facts. The writer takes the first and
   * refuses the second rather than quietly turning it into a nought.
   */
  const { error: blank } = await shop.rpc('count_empties', {
    p_store_id: storeId,
    p_parts: [{ product_unit_id: shape.product_unit_id }],
  });
  check('a count with no quantity is refused', !!blank, blank?.message ?? 'it was accepted');

  // ── Every way a container moves ───────────────────────────────────────────────────
  console.log(NL + '— the nine movements —');

  const { data: sid } = await shop.rpc('upsert_supplier', {
    p_store_id: storeId,
    p_name: `ZZ Yard ${stamp}`,
  });
  supplierId = sid;

  const { data: people } = await shop.rpc('list_customers', {
    p_store_id: storeId,
    p_limit: 1,
  });
  customerId = people?.[0]?.id ?? null;

  /*
   * FOUR OF THESE WERE NOT WEIGHED AT ALL, and each is a real thing a yard does.
   *
   * Their crates handed back, theirs broken here, ours gone out on a lorry, ours come back. The
   * expected column is the physical answer: did the crate arrive in this yard, or leave it.
   */
  const moves = [
    { who: 'supplier', side: 'we_hold', direction: 'out', qty: 10, effect: +10, says: "their crates arrive with a load" },
    { who: 'supplier', side: 'we_hold', direction: 'returned', qty: 4, effect: -4, says: 'their crates go back' },
    { who: 'supplier', side: 'we_hold', direction: 'damaged', qty: 1, effect: -1, says: 'one of theirs breaks here' },
    { who: 'supplier', side: 'they_hold', direction: 'out', qty: 6, effect: -6, says: 'ours go out on a lorry' },
    { who: 'supplier', side: 'they_hold', direction: 'returned', qty: 2, effect: +2, says: 'ours come back' },
    { who: 'customer', side: 'they_hold', direction: 'out', qty: 5, effect: -5, says: 'ours go out with a sale' },
    { who: 'customer', side: 'they_hold', direction: 'returned', qty: 3, effect: +3, says: 'a customer brings ours back' },
    { who: 'customer', side: 'we_hold', direction: 'out', qty: 7, effect: +7, says: 'a customer leaves their own' },
    { who: 'customer', side: 'we_hold', direction: 'returned', qty: 2, effect: -2, says: 'we hand theirs back' },
  ];

  let expected = 40;
  let allWeighed = true;
  const misweighed = [];

  for (const mv of moves) {
    const before = Number((await yardFor(shape.product_unit_id))?.in_yard);

    const { error: me } =
      mv.who === 'supplier'
        ? await shop.rpc('record_supplier_empties', {
            p_store_id: storeId,
            p_product_unit_id: shape.product_unit_id,
            p_qty: mv.qty,
            p_supplier_id: supplierId,
            p_side: mv.side,
            p_direction: mv.direction,
          })
        : await shop.rpc('record_customer_empties', {
            p_store_id: storeId,
            p_customer_id: customerId,
            p_product_unit_id: shape.product_unit_id,
            p_direction: mv.direction,
            p_qty: mv.qty,
            p_side: mv.side,
            p_reason: `probe ${stamp}`,
          });

    if (me) {
      misweighed.push(`${mv.says}: ${me.message}`);
      allWeighed = false;
      continue;
    }

    const after = Number((await yardFor(shape.product_unit_id))?.in_yard);
    expected += mv.effect;
    if (after - before !== mv.effect) {
      allWeighed = false;
      misweighed.push(`${mv.says} moved the yard by ${after - before}, not ${mv.effect}`);
    }
  }

  check(
    'every way a container moves is weighed',
    allWeighed,
    misweighed.length ? misweighed.join('; ') : `all nine`,
  );

  const settled = await yardFor(shape.product_unit_id);
  check(
    'and the yard is the count plus everything since',
    Number(settled?.in_yard) === expected,
    `${settled?.in_yard}, expected ${expected}`,
  );

  // ── Counted by group ──────────────────────────────────────────────────────────────
  if (sibling) {
    console.log(NL + '— counting the stack, not the labels —');

    /*
     * A yard has a stack of NBL crates. They are the same physical crate whether the beer in them
     * was Goldberg or Gulder, so a group count is a first-class answer — authoritative for the
     * GROUP total, and honest about not knowing the split.
     */
    const { error: g1 } = await shop.rpc('count_empties', {
      p_store_id: storeId,
      p_parts: [
        { category_id: shape.group_id, store_unit_id: shape.store_unit_id, qty: 500 },
      ],
      p_note: `probe group ${stamp}`,
    });
    check('a group can be counted as one stack', !g1, g1?.message ?? '');

    const afterGroup = await yardFor(shape.product_unit_id);
    check(
      'the newer group count takes over from the shape count',
      afterGroup?.counted_grain === 'group',
      `grain=${afterGroup?.counted_grain}`,
    );
    check(
      'and the shape stops claiming a position it cannot know',
      afterGroup?.in_yard === null,
      `in_yard=${afterGroup?.in_yard}`,
    );

    const grp = await groupRow(shape.group_id, shape.store_unit_id);
    check(
      'the group carries the number instead',
      grp && Number(grp.counted) === 500 && grp.counted_grain === 'group',
      `counted=${grp?.counted} grain=${grp?.counted_grain}`,
    );

    /*
     * And a movement after the group count still moves the group figure. A count that could not be
     * added to would be a photograph, not a position.
     */
    const gBefore = Number((await groupRow(shape.group_id, shape.store_unit_id))?.in_yard);
    await shop.rpc('record_supplier_empties', {
      p_store_id: storeId,
      p_product_unit_id: shape.product_unit_id,
      p_qty: 9,
      p_supplier_id: supplierId,
      p_side: 'we_hold',
      p_direction: 'out',
    });
    const gAfter = Number((await groupRow(shape.group_id, shape.store_unit_id))?.in_yard);
    check(
      'and the group figure moves with the yard',
      gAfter - gBefore === 9,
      `${gBefore} -> ${gAfter}`,
    );
  }

  // ── It is this shop's yard, and nobody else's ─────────────────────────────────────
  console.log(NL + '— whose yard —');
  const { error: theirs } = await shop.rpc('count_empties', {
    p_store_id: storeId,
    p_parts: [{ product_unit_id: '00000000-0000-0000-0000-000000000001', qty: 5 }],
  });
  check(
    'a shape from another shop is refused',
    !!theirs,
    theirs?.message ?? 'it was accepted',
  );
} catch (e) {
  console.log(`  FAIL  the probe could not finish — ${e.message}`);
  failed += 1;
} finally {
  /*
   * WHAT IS LEFT BEHIND, said out loud rather than assumed.
   *
   * `empties_counts` and both empties ledgers are append-only and refuse deletes, so this probe
   * cannot tidy after itself — the rows it wrote are real counts and real movements in a real
   * shop's yard. Retiring the supplier is the one thing it can do, and the rest is reported so
   * nobody reads a clean finish as a clean database.
   */
  if (supplierId) await shop.rpc('archive_supplier', { p_supplier_id: supplierId });
  const { count } = await shop
    .from('empties_counts')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', storeId)
    .like('note', `%${stamp}%`);
  console.log(
    NL +
      `  left behind: ${count ?? '?'} counts and 10 container movements, all append-only. ` +
      `Supplier retired.`,
  );
}

console.log(NL + (failed === 0 ? 'ALL PASS' : `${failed} FAILED`));
process.exit(failed === 0 ? 0 : 1);
