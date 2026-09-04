/**
 * Scenarios 1–3: a shop opens.
 *
 * A new customer who already owes you and is already holding your crates. A new product with a
 * price, stock on the shelf and a delivery behind it. These are the first hour of using this
 * software, and they are the hour where a shop decides whether it can be trusted with the rest.
 *
 * The numbers are the ones from `STORE_MANAGER_SCENARIOS.md`, so the benchmark and the design
 * document can be read against each other.
 */

import {
  admin,
  backfillDebt,
  backfillEmpties,
  balanceOf,
  check,
  emptiesOut,
  expectMoney,
  expectQty,
  makeCustomer,
  makePool,
  makeProduct,
  makeUnit,
  onHand,
  setShapes,
  shop,
} from './harness.mjs';

export const scenarios = [
  {
    name: '1. A new customer, who already owes you and is holding your crates',
    async run(ctx) {
      const { storeId } = ctx;

      /*
       * The pool first, because empties are owed into a pool and not against a brand.
       *
       * An NBL crate takes any NBL bottle, so what a customer owes is "four NBL crates", never
       * "two Star crates and two Gulder crates".
       */
      const pool = await makePool(storeId, 'NBL crate', 'container', 1500);
      ctx.pool = pool;

      const id = await makeCustomer(storeId, 'Irekanmi Stores', '08031234567');
      ctx.customer = id;
      check('a customer can be created', Boolean(id));

      expectMoney('a new customer owes nothing', await balanceOf(id), 0);

      /*
       * WHAT THE BOOK SAID. A shop does not start from zero: it starts from a notebook with
       * ₦120,000 owing and four crates unaccounted for, and if the software cannot take that in on
       * day one it gets used alongside the notebook for ever.
       */
      await backfillDebt(storeId, id, 120000, 'from the book');
      expectMoney('an opening balance is carried in', await balanceOf(id), 120000);

      await backfillEmpties(storeId, id, pool, 4);
      expectQty('and the crates they already have', await emptiesOut(id, pool), 4);

      /*
       * AND THE TWO DO NOT TOUCH EACH OTHER.
       *
       * Money and containers are separate obligations. A shop that nets them cannot answer "do they
       * owe me money, or crates?" — which is the question, because one is chased by phone and the
       * other by lorry.
       */
      expectMoney('crates did not change what they owe in money', await balanceOf(id), 120000);
    },
  },

  {
    name: '2. A new product: shapes, a price, stock on the shelf, and a delivery',
    async run(ctx) {
      const { storeId } = ctx;

      const crate = await makeUnit(storeId, 'Crate', 'Crates');
      const bottle = await makeUnit(storeId, 'Bottle', 'Bottles');
      ctx.units = { crate, bottle };

      const id = await makeProduct(storeId, 'Goldberg 60cl', 'piece');
      ctx.product = id;
      check('a product can be created', Boolean(id));

      /*
       * A CRATE OF TWELVE BOTTLES, said as a tree.
       *
       * The bottle is the root and the crate is defined against it — twelve to one — so `base_qty`
       * is derived rather than typed. A shop that later says a crate holds twenty-four changes one
       * number and every figure in the system follows.
       */
      await setShapes(id, [
        {
          store_unit_id: bottle,
          is_sold: true,
          is_bought: false,
          is_counted: false,
          is_deposit: false,
          sell_price: 480,
          is_returnable: false,
          whole_digit: true,
          allow_quarter: false,
          allow_half: false,
          allow_three_quarter: false,
          defined_against: null,
          defined_qty: null,
          base_qty: 1,
          sort_order: 0,
        },
        {
          store_unit_id: crate,
          is_sold: true,
          is_bought: true,
          is_counted: true,
          is_deposit: true,
          sell_price: 5200,
          is_returnable: true,
          whole_digit: true,
          allow_quarter: false,
          allow_half: true,
          allow_three_quarter: false,
          defined_against: bottle,
          defined_qty: 12,
          base_qty: undefined,
          sort_order: 1,
        },
      ]);

      /*
       * AND WHERE THE CRATES GO BACK TO.
       *
       * Ticking `is_returnable` on the crate says this shape comes back. It does not say into WHAT,
       * and those are different facts: the crate comes back into the NBL pool, where it is
       * interchangeable with every other NBL crate. Without the link `returnables_for_sale` returns
       * nothing, so containers leave and the ledger records none of them — the shop believes it is
       * owed nothing and the customer keeps the crates.
       */
      const { error: linkErr } = await shop.rpc('set_product_returnable', {
        p_store_id: storeId,
        p_product_id: id,
        p_category_name: 'NBL crate',
        p_kind: 'container',
        p_qty_per_base_unit: 1,
        p_deposit: 1500,
      });
      check('the crate is linked to the pool it comes back into', !linkErr, linkErr?.message ?? '');

      const { data: shapes } = await shop.rpc('product_selling_units', { p_store_id: storeId });
      const mine = (shapes ?? []).filter((u) => u.product_id === id);
      expectQty('both shapes are saved', mine.length, 2);

      const crateShape = mine.find((u) => u.unit_name === 'Crate');
      expectQty('and a crate works out as twelve bottles', crateShape?.base_qty, 12);
      expectMoney('with the price the shop set', crateShape?.price_per_unit, 5200);

      /*
       * WHAT IS ALREADY ON THE SHELF, counted rather than derived from deliveries.
       *
       * Most shops start here: stock they have and no delivery history for it. An invented delivery
       * invents a cost, so the count is recorded as a count.
       */
      const { error: openErr } = await shop.rpc('open_stock_by_count', {
        p_store_id: storeId,
        p_product_id: id,
        p_qty: 240,
        p_unit_cost: 4200 / 12,
        p_note: 'what was on the shelf when we started',
      });
      check('stock can be opened from a count', !openErr, openErr?.message ?? '');
      expectQty('and the shelf says so', await onHand(id), 240);

      /*
       * THEN A REAL DELIVERY, with the fees that make it real.
       *
       * 20 crates at ₦4,400 is ₦88,000, and ₦6,000 of transport lands it at ₦94,000 — ₦4,700 a
       * crate, not ₦4,400. A shop pricing off the invoice thinks a ₦4,500 sale earns ₦100; it loses
       * ₦200. That one calculation is most of why this software is worth using.
       */
      const { data: purchaseId, error: recvErr } = await shop.rpc('record_purchase', {
        p_store_id: storeId,
        p_lines: [
          {
            product_id: id,
            qty: 20,
            free_qty: 0,
            // `base_factor` is how many base units one of the bought shape holds — twelve bottles
            // to a crate. Sending `base_qty` instead brought twenty CRATES in as twenty bottles and
            // landed the whole ₦94,000 on them.
            base_factor: 12,
            pack_id: null,
            unit_cost: 4400,
          },
        ],
        p_supplier: 'Nigerian Breweries',
        // Transport is its own argument, not a line: it belongs to the whole load and is spread
        // across it, which is the entire reason a landed cost differs from an invoice price.
        p_delivery: 6000,
      });
      check('a delivery can be recorded', !recvErr, recvErr?.message ?? '');
      ctx.purchase = purchaseId;

      if (!recvErr) {
        expectQty('the shelf takes the delivery in', await onHand(id), 480);

        const { data: prod } = await admin
          .from('products')
          .select('avg_unit_cost')
          .eq('id', id)
          .single();
        /*
         * 240 bottles at ₦350 plus 240 at ₦391.67 averages ₦370.83 a bottle — ₦4,450 a crate.
         * The fee moved it by ₦25 a crate, and that is the figure every margin is computed from.
         */
        expectMoney('and the cost carries the fee into it', prod?.avg_unit_cost, 370.83);
      }
    },
  },

  {
    name: '3. A new member of staff, who can sell but not change prices',
    async run(ctx) {
      const { storeId } = ctx;

      const { data: roles, error } = await shop.rpc('assignable_roles', { p_store_id: storeId });
      check('the shop is offered roles it may hand out', !error && (roles ?? []).length > 0,
        (roles ?? []).map((r) => r.name).join(', '));

      /*
       * A ROLE BELOW YOUR OWN, and never at or above it.
       *
       * Enforced by the server, not the screen — `assignable_roles` only offers what may be given,
       * and `invite_staff`/`set_member_role` refuse the rest. A shop where a seller can promote
       * themselves is a shop with no permissions at all.
       */
      const owner = (roles ?? []).find((r) => r.code === 'owner');
      check('and never its own role', owner == null, owner ? 'owner WAS offered' : 'owner withheld');

      const seller = (roles ?? []).find((r) => /sell|cashier|staff|attendant/i.test(r.code));
      if (seller) {
        ctx.sellerRole = seller.code;
        const { data: perms } = await shop.rpc('role_permission_codes', {
          p_role_code: seller.code,
        });
        const codes = (perms ?? []).map((p) =>
          typeof p === 'string' ? p : p.permission_code,
        );
        check(
          `a ${seller.name} can record a sale`,
          codes.some((c) => c === 'sales.record'),
          codes.slice(0, 4).join(', '),
        );
        check(
          'and cannot change what things cost',
          !codes.some((c) => c === 'products.manage'),
          codes.includes('products.manage') ? 'they CAN' : 'withheld',
        );
      } else {
        check('there is a selling role to give somebody', false, 'none offered');
      }
    },
  },
];
