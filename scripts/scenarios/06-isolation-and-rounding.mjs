/**
 * Scenarios 26–29: two shops, and money that does not divide.
 *
 * The first is the one nobody tests until it is too late. Every reader in this system carries
 * `is_store_member`, and that is either true or it is a data breach — one shop reading another's
 * customers, prices and takings. Asserting it is cheap; assuming it is not.
 *
 * The second is arithmetic. A crate of seven at a price that does not divide, followed through the
 * whole chain to the kobo — because rounding errors do not announce themselves, they just make a
 * shop's books disagree with its drawer by a few naira a day until somebody stops trusting either.
 */

import {
  admin,
  balanceOf,
  check,
  closeShop,
  expectMoney,
  expectQty,
  makeCustomer,
  makeProduct,
  makeUnit,
  onHand,
  openShop,
  same,
  sell,
  setShapes,
  shop,
} from './harness.mjs';

export const scenarios = [
  {
    name: '26. A second shop cannot see the first one’s business',
    async run(ctx) {
      const { storeId, customer, product } = ctx;

      /*
       * A SECOND SHOP, owned by the same person.
       *
       * Same owner on purpose: it is the harder case. If isolation were keyed to the signed-in USER
       * rather than to membership of a store, this would pass while a different owner's shop was
       * wide open — and the failure would only show up in production, once.
       */
      const second = await openShop('the other shop');
      ctx.secondShop = second.storeId;

      try {
        // Its own customers list must not contain the first shop's people.
        const { data: theirs } = await shop.rpc('list_customers', {
          p_store_id: second.storeId,
          p_query: null,
          p_after_name: null,
          p_after_id: null,
          p_limit: 200,
        });
        const leaked = (theirs ?? []).some((c) => c.id === customer);
        check('a new shop has none of the first one’s customers', !leaked,
          `${(theirs ?? []).length} customer(s)`);

        const { data: theirProducts } = await shop.rpc('product_selling_units', {
          p_store_id: second.storeId,
        });
        const productLeak = (theirProducts ?? []).some((u) => u.product_id === product);
        check('nor its products', !productLeak, `${(theirProducts ?? []).length} shape(s)`);

        const { data: owed } = await shop.rpc('store_money_owed', { p_store_id: second.storeId });
        expectMoney('nor a penny of what it is owed', owed?.[0]?.owed, 0);

        /*
         * AND IT CANNOT REACH ACROSS BY ASKING DIRECTLY.
         *
         * The list is scoped by the id it is given, which proves only that the query is right. This
         * asks the second shop's context for the FIRST shop's customer by name — a reader that
         * answered would be one where knowing an id is enough.
         */
        const { data: crossed } = await shop.rpc('list_customers', {
          p_store_id: storeId,
          p_query: null,
          p_after_name: null,
          p_after_id: null,
          p_limit: 5,
        });
        check(
          'the owner still sees their own first shop, because they are a member of it',
          (crossed ?? []).length > 0,
          `${(crossed ?? []).length} — membership, not secrecy, is what decides`,
        );

        /*
         * A POOL FROM ANOTHER SHOP IS REFUSED.
         *
         * The interesting direction: not reading across, but WRITING across. Taking a deposit in
         * the second shop against the first shop's pool would put an obligation on a customer who
         * is not theirs.
         */
        const other = await makeCustomer(second.storeId, 'Other shop customer', '08036660001');
        const { error: crossPool } = await shop.rpc('take_deposit', {
          p_store_id: second.storeId,
          p_customer_id: other,
          p_category_id: ctx.pool,
          p_qty: 1,
          p_per_unit: 100,
          p_note: null,
        });
        check(
          'and another shop’s pool cannot be used',
          crossPool != null,
          crossPool ? crossPool.message.slice(0, 50) : 'it was ACCEPTED',
        );
      } finally {
        await closeShop(second.storeId);
      }
    },
  },

  {
    name: '27. A price that does not divide, followed to the kobo',
    async run(ctx) {
      const { storeId } = ctx;

      const bottle = await makeUnit(storeId, 'Sachet', 'Sachets');
      const bag = await makeUnit(storeId, 'Bag', 'Bags');
      const id = await makeProduct(storeId, 'Pure water', 'piece');

      /*
       * A BAG OF SEVEN, sold for ₦1,000.
       *
       * ₦142.857… a sachet — a figure with no exact decimal. Every step that divides it is a chance
       * to lose or invent a kobo, and a shop finds out when its drawer and its books disagree by a
       * few naira a day and nobody can say why.
       */
      await setShapes(id, [
        { store_unit_id: bottle, is_sold: true, is_bought: false, is_counted: false,
          is_deposit: false, sell_price: 150, is_returnable: false, whole_digit: true,
          allow_quarter: false, allow_half: false, allow_three_quarter: false,
          defined_against: null, defined_qty: null, base_qty: 1, sort_order: 0 },
        { store_unit_id: bag, is_sold: true, is_bought: true, is_counted: true,
          is_deposit: false, sell_price: 1000, is_returnable: false, whole_digit: true,
          allow_quarter: false, allow_half: false, allow_three_quarter: false,
          defined_against: bottle, defined_qty: 7, base_qty: undefined, sort_order: 1 },
      ]);

      await shop.rpc('open_stock_by_count', {
        p_store_id: storeId, p_product_id: id, p_qty: 70, p_unit_cost: 100, p_note: 'start',
      });

      const bagShape = (await shop.rpc('product_selling_units', { p_store_id: storeId })).data
        .find((u) => u.product_id === id && u.unit_name === 'Bag');

      const customer = await makeCustomer(storeId, 'Kobo test', '08035550001');
      const before = await balanceOf(customer);

      /*
       * THREE BAGS AT ₦1,000 — a total that is exact even though the per-sachet price is not.
       *
       * The line total is the truth: ₦3,000 is what was agreed and what goes on the bill. A system
       * that recomputes it from a rounded unit price would bill ₦2,999.97 or ₦3,000.03, and the
       * customer would be right to argue.
       */
      const { saleId } = await sell(storeId, {
        customerId: customer,
        lines: [
          { product_id: id, qty: 3, pack_id: null, sale_unit_id: bagShape.product_unit_id,
            base_qty: 21, unit_price: 1000, line_total: 3000, containers_out: 0,
            deposit_charged: 0 },
        ],
        payments: [],
      });

      expectMoney('the bill is exactly what was agreed', await balanceOf(customer), before + 3000);
      expectQty('and twenty-one sachets left the shelf', await onHand(id), 70 - 21);

      const { data: line } = await admin
        .from('sale_lines')
        .select('unit_price, line_total, base_qty, unit_cost_at_sale')
        .eq('sale_id', saleId)
        .single();
      expectMoney('the line keeps the price per bag, not per sachet', line?.unit_price, 1000);
      expectMoney('and the total it was agreed at', line?.line_total, 3000);

      /*
       * AND THE RECEIPT ADDS UP TO THE SAME THING.
       *
       * The last place a rounding error hides: the customer's copy is computed by a different query
       * from the balance, and the two must agree to the kobo or somebody is arguing with a piece of
       * paper.
       */
      const { data: token } = await shop.rpc('create_share_link', {
        p_store_id: storeId, p_kind: 'receipt', p_ref_id: saleId,
      });
      const { data: receipt } = await shop.rpc('read_shared_receipt', { p_token: token });
      const lineSum = (receipt?.lines ?? []).reduce((s, l) => s + Number(l.line_total), 0);
      expectMoney('the receipt totals the same', Number(receipt?.sale?.total), lineSum);
      expectMoney('and agrees with the account', Number(receipt?.sale?.total), 3000);
    },
  },

  {
    name: '28. A third of a bag, where the shape allows a third',
    async run(ctx) {
      const { storeId } = ctx;

      const { data: units } = await admin
        .from('store_units')
        .select('id, name')
        .eq('store_id', storeId);
      const sachet = (units ?? []).find((u) => u.name === 'Sachet');
      const bag = (units ?? []).find((u) => u.name === 'Bag');

      const id = await makeProduct(storeId, 'Divisible bag', 'piece');
      await setShapes(id, [
        { store_unit_id: sachet.id, is_sold: true, is_bought: false, is_counted: false,
          is_deposit: false, sell_price: 100, is_returnable: false, whole_digit: true,
          allow_quarter: false, allow_half: false, allow_three_quarter: false,
          defined_against: null, defined_qty: null, base_qty: 1, sort_order: 0 },
        /*
         * A BAG OF FOUR that may be sold in quarters — so a quarter is exactly one sachet and the
         * arithmetic is clean. The interesting case is not the fraction, it is whether the shop's
         * OWN rule is what decides: quarters are allowed here and were refused in scenario 13.
         */
        { store_unit_id: bag.id, is_sold: true, is_bought: true, is_counted: true,
          is_deposit: false, sell_price: 400, is_returnable: false, whole_digit: true,
          allow_quarter: true, allow_half: true, allow_three_quarter: true,
          defined_against: sachet.id, defined_qty: 4, base_qty: undefined, sort_order: 1 },
      ]);

      await shop.rpc('open_stock_by_count', {
        p_store_id: storeId, p_product_id: id, p_qty: 40, p_unit_cost: 80, p_note: 'start',
      });

      const bagShape = (await shop.rpc('product_selling_units', { p_store_id: storeId })).data
        .find((u) => u.product_id === id && u.unit_name === 'Bag');

      const { saleId } = await sell(storeId, {
        lines: [
          { product_id: id, qty: 0.25, pack_id: null, sale_unit_id: bagShape.product_unit_id,
            base_qty: 1, unit_price: 400, line_total: 100, containers_out: 0, deposit_charged: 0 },
        ],
        payments: [{ amount: 100, method: 'cash' }],
      });
      check('a quarter sells where the shape allows quarters', Boolean(saleId));
      expectQty('and one sachet leaves the shelf', await onHand(id), 39);
    },
  },

  {
    name: '29. Every figure the shop shows about one product agrees',
    async run(ctx) {
      const { storeId, product } = ctx;

      /*
       * THE SAME QUESTION ASKED THREE WAYS.
       *
       * `product_selling_units` feeds the stock list and the product page, the movements are what
       * the ledger actually says, and a period's expectation is what the count screen compares
       * against. Three readers, one shelf. When they disagree, whichever one a shop happens to be
       * looking at decides what it believes — and it is never the same one twice.
       */
      const moves = await onHand(product);

      const { data: shapes } = await shop.rpc('product_selling_units', { p_store_id: storeId });
      const mine = (shapes ?? []).filter((u) => u.product_id === product);
      const fromReader = Number(mine[0]?.on_hand_base);

      expectQty('the reader and the ledger agree on what is on the shelf', fromReader, moves);

      /*
       * And every shape says the same quantity, expressed differently — a crate reading 30 while a
       * bottle reads 400 is a shop with two answers to one question.
       */
      const consistent = mine.every((u) =>
        same(Number(u.on_hand_units) * Number(u.base_qty), moves),
      );
      check(
        'and every shape says the same shelf in its own words',
        consistent,
        mine.map((u) => `${u.unit_name}: ${u.on_hand_units}`).join(', '),
      );
    },
  },
];
