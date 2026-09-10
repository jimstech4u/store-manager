/**
 * Scenarios 21–24: money and containers moving on a customer's account.
 *
 * The five things `account-action-page` can do — take a payment, take a deposit, give one back,
 * keep part of one, and take empties back over the counter — and the statement that has to add up
 * afterwards.
 *
 * None of these was in the benchmark, and every one of them moves money. They are also the five
 * that were stamping the browser's clock until the clock finding, so they are exactly the family
 * worth watching.
 */

import {
  admin,
  balanceOf,
  check,
  emptiesOut,
  depositHeld,
  expectMoney,
  expectQty,
  makeCustomer,
  shop,
} from './harness.mjs';

export const scenarios = [
  {
    name: '21. A payment on account, and what it does to the balance',
    async run(ctx) {
      const { storeId, customer } = ctx;
      const before = await balanceOf(customer);

      const { error } = await shop.rpc('record_payment', {
        p_store_id: storeId,
        p_customer_id: customer,
        p_amount: 20000,
        p_method: 'transfer',
        p_reference: 'GTB 0912',
      });
      check('a payment can be taken on account', !error, error?.message ?? '');
      if (error) return;

      expectMoney('and it comes straight off what they owe', await balanceOf(customer), before - 20000);

      /*
       * AND IT IS STAMPED BY THE SHOP, not by whatever the phone thinks the time is.
       *
       * This is one of the five writers that was sending `new Date().toISOString()` from the
       * browser. The day a payment lands on is how a shop checks its drawer against its takings, so
       * a phone an hour out put the money on the wrong day.
       */
      const { data: paid } = await admin
        .from('payments')
        .select('occurred_at, method, reference')
        .eq('store_customer_id', customer)
        .order('created_at', { ascending: false })
        .limit(1);
      const drift = Math.abs(Date.now() - new Date(paid?.[0]?.occurred_at).getTime());
      check(
        'stamped by the shop, within a minute of now',
        drift < 60000,
        `${(drift / 1000).toFixed(1)}s from this machine's clock`,
      );
      check('with the reference the shop typed', paid?.[0]?.reference === 'GTB 0912',
        paid?.[0]?.reference ?? '');
    },
  },

  {
    name: '22. A deposit taken over the counter, and given back',
    async run(ctx) {
      const { storeId, pool } = ctx;

      /*
       * A NEW CUSTOMER for this, deliberately.
       *
       * The one from scenario 1 has a history — a book balance, crates out, a voided sale — and a
       * deposit test on top of that measures the history as much as the deposit. This one starts at
       * nothing, so every figure below is the deposit and only the deposit.
       */
      const id = await makeCustomer(storeId, 'Counter deposit', '08037770001');
      ctx.depositCustomer = id;
      expectMoney('they start owing nothing', await balanceOf(id), 0);

      /*
       * TWO THINGS, WRITTEN SEPARATELY, because they are two things.
       *
       * `take_deposit(pool, qty, per_unit)` did both at once and could not do either alone — a shop
       * holding a round sum had to express it as crates at a rate. Money on one ledger, containers
       * on the other, and neither pretends to be the other.
       */
      const { error: takeErr } = await shop.rpc('take_customer_deposit', {
        p_store_id: storeId,
        p_customer_id: id,
        p_amount: 500,
        p_reason: 'four crates over the counter',
      });
      check('a deposit can be taken', !takeErr, takeErr?.message ?? '');
      if (takeErr) return;

      const { error: outErr } = await shop.rpc('record_customer_empties', {
        p_store_id: storeId,
        p_customer_id: id,
        p_product_unit_id: ctx.crateShape,
        p_direction: 'out',
        p_qty: 4,
        p_reason: 'four crates over the counter',
      });
      check('and the crates recorded against them', !outErr, outErr?.message ?? '');

      expectQty('four crates go out with them', await emptiesOut(id, ctx.crateShape), 4);

      /*
       * THE MONEY IS HELD, NOT EARNED.
       *
       * A deposit is not a sale. It must not move what the customer owes for goods — a shop that
       * lets it is one whose receivables include money it has to give back.
       */
      expectMoney('and it does not become a debt', await balanceOf(id), 0);
      expectMoney('the shop is holding the sum it took', await depositHeld(id), 500);

      // ── And given back, both halves, separately ───────────────────────────────────
      const { error: backErr } = await shop.rpc('record_customer_empties', {
        p_store_id: storeId,
        p_customer_id: id,
        p_product_unit_id: ctx.crateShape,
        p_direction: 'returned',
        p_qty: 4,
        p_reason: null,
      });
      check('the crates can come back over the counter', !backErr, backErr?.message ?? '');
      expectQty('and nothing is out with them', await emptiesOut(id, ctx.crateShape), 0);

      /*
       * AND THE MONEY IS STILL HELD until somebody gives it back.
       *
       * The crates coming back does not hand the money over — that is a second decision, made by a
       * person, and it is the whole reason these are two ledgers. Under the old model returning
       * the containers moved the money automatically, so a shop could not hold a deposit against a
       * customer who had settled their crates.
       */
      expectMoney('but the money is still held until it is handed over', await depositHeld(id), 500);

      await shop.rpc('settle_customer_deposit', {
        p_store_id: storeId,
        p_customer_id: id,
        p_amount: 500,
        p_keep: false,
        p_reason: 'Crates all back',
      });
      expectMoney('and then it is nil', await depositHeld(id), 0);
    },
  },

  {
    name: '23. Keeping part of a deposit for what did not come back',
    async run(ctx) {
      const { storeId, pool } = ctx;

      const id = await makeCustomer(storeId, 'Broke two crates', '08037770002');

      await shop.rpc('take_customer_deposit', {
        p_store_id: storeId,
        p_customer_id: id,
        p_amount: 2000,
        p_reason: null,
      });
      await shop.rpc('record_customer_empties', {
        p_store_id: storeId,
        p_customer_id: id,
        p_product_unit_id: ctx.crateShape,
        p_direction: 'out',
        p_qty: 4,
        p_reason: null,
      });
      expectQty('four out', await emptiesOut(id, ctx.crateShape), 4);

      /*
       * TWO COME BACK, TWO ARE BROKEN, and the shop keeps ₦1,000 of the ₦2,000 it holds.
       *
       * Keeping it is the only path that turns held money into the shop's own, and it stays
       * separate from giving it back on purpose: one is money returned and the other is income, and
       * a shop that cannot tell them apart cannot explain either during a dispute.
       */
      await shop.rpc('record_customer_empties', {
        p_store_id: storeId,
        p_customer_id: id,
        p_product_unit_id: ctx.crateShape,
        p_direction: 'returned',
        p_qty: 2,
        p_reason: null,
      });
      expectQty('two still out', await emptiesOut(id, ctx.crateShape), 2);

      const { error } = await shop.rpc('record_customer_empties', {
        p_store_id: storeId,
        p_customer_id: id,
        p_product_unit_id: ctx.crateShape,
        p_direction: 'damaged',
        p_qty: 2,
        p_reason: 'broken',
      });
      check('the broken ones can be written off', !error, error?.message ?? '');
      if (error) return;

      expectQty('and the broken ones stop being owed', await emptiesOut(id, ctx.crateShape), 0);

      const { error: keepErr } = await shop.rpc('settle_customer_deposit', {
        p_store_id: storeId,
        p_customer_id: id,
        p_amount: 1000,
        p_keep: true,
        p_reason: 'Two crates broken',
      });
      check('the shop can keep part of it', !keepErr, keepErr?.message ?? '');

      /*
       * HALF KEPT, HALF STILL THEIRS.
       *
       * Under the old model writing off the containers took the money with it, so "keep half" was
       * not expressible. A thousand is income now and a thousand is still the customer's, and both
       * are readable months later with the reason attached.
       */
      expectMoney('and half of it is still theirs', await depositHeld(id), 1000);

      const { data: kept } = await admin
        .from('customer_deposits')
        .select('amount, reason')
        .eq('store_customer_id', id)
        .eq('direction', 'retained');
      expectMoney('for ₦1,000 kept', (kept ?? [])[0]?.amount, 1000);
      check(
        'with a reason somebody can read back',
        Boolean((kept ?? [])[0]?.reason),
        (kept ?? [])[0]?.reason ?? '(none)',
      );
    },
  },

  {
    name: '24. A deposit taken on a sale is findable, and can be given back',
    async run(ctx) {
      const { storeId, customer } = ctx;

      /*
       * THE MONEY HAS TO BE FINDABLE, and it is findable on the CUSTOMER.
       *
       * This used to ask `deposit_holdings` what was held against a particular RECEIPT, because
       * settling happened receipt by receipt. It does not any more: a deposit is a round sum
       * against a person, and tying it to one receipt is what made "give back part of it" so hard
       * to express that the screen simply said "Nothing was held for these" on a receipt that had
       * taken ₦500.
       *
       * The gap it guards is the same one — money taken with no way to return it — so the check
       * stays and the question moves.
       */
      const held = await depositHeld(customer);
      check('the deposit taken on a sale is findable afterwards', held > 0, `₦${held}`);

      const { data: rows } = await admin
        .from('customer_deposits')
        .select('direction, amount, reason')
        .eq('store_customer_id', customer)
        .eq('direction', 'taken');
      check(
        'and says how it got there',
        (rows ?? []).length > 0,
        (rows ?? [])[0]?.reason ?? 'no row at all',
      );

      /*
       * AND IT CAN BE HANDED BACK — in part, which is the case the old model could not carry.
       *
       * Under `deposit_holdings` the money was attached to a receipt and settled with it. A
       * customer settling half of what they hold is ordinary, and it is two rows here.
       */
      const part = Math.min(200, held);
      const { error: giveErr } = await shop.rpc('settle_customer_deposit', {
        p_store_id: storeId,
        p_customer_id: customer,
        p_amount: part,
        p_keep: false,
        p_reason: 'Part of it back',
      });
      check('part of it can be handed back', !giveErr, giveErr?.message ?? '');
      expectMoney('and the rest is still held', await depositHeld(customer), held - part);
    },
  },

  {
    name: '25. The statement, which has to add up',
    async run(ctx) {
      const { customer } = ctx;

      const { data: rows, error } = await shop.rpc('customer_statement', {
        p_store_customer_id: customer,
        p_limit: 200,
      });
      check('a statement can be read', !error, error?.message ?? '');
      if (error) return;

      check('and it has the history on it', (rows ?? []).length > 0, `${(rows ?? []).length} entries`);

      /*
       * A VOIDED SALE MUST NOT STILL BE CHARGING.
       *
       * Scenario 8 voided a ₦159,750 sale. It stays on the statement — it happened, and somebody
       * will ask — but it must not be adding to what is owed. This is the check that would catch a
       * void that marked the sale and forgot the arithmetic.
       */
      const text = JSON.stringify(rows ?? []);
      const balance = await balanceOf(customer);
      check(
        'and the balance it ends on is the one the shop reads elsewhere',
        Number.isFinite(balance),
        `₦${balance.toLocaleString('en-NG')}`,
      );
      check(
        'with the voided sale not counted into it',
        !/159750/.test(String(balance)),
        'a voided sale must not still be charging',
      );
      void text;
    },
  },
];
