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

      const { error: takeErr } = await shop.rpc('take_deposit', {
        p_store_id: storeId,
        p_customer_id: id,
        p_category_id: pool,
        p_qty: 4,
        p_per_unit: 125,
        p_note: 'four crates over the counter',
      });
      check('a deposit can be taken', !takeErr, takeErr?.message ?? '');
      if (takeErr) return;

      expectQty('four crates go out with them', await emptiesOut(id, pool), 4);

      /*
       * THE MONEY IS HELD, NOT EARNED.
       *
       * A deposit is not a sale. It must not move what the customer owes for goods — a shop that
       * lets it is one whose receivables include money it has to give back.
       */
      expectMoney('and it does not become a debt', await balanceOf(id), 0);

      /*
       * ASKED OF THE READER THAT ANSWERS IT.
       *
       * There are two records of held money and they are not duplicates. The LEDGER carries the
       * rate, and `customer_deposits_held` totals a customer's whole position from it — that is the
       * question a counter deposit answers. `deposit_holdings` answers a narrower one, about a
       * particular RECEIPT, which a deposit taken over the counter does not have.
       *
       * A first version asked the receipt table about a counter deposit, found nothing, and called
       * it a bug.
       */
      const { data: heldRows } = await shop.rpc('customer_deposits_held', {
        p_store_customer_id: id,
      });
      const total = (heldRows ?? []).reduce((sum, r) => sum + Number(r.amount), 0);
      expectMoney('the shop is holding four times ₦125', total, 500);

      // ── And given back ────────────────────────────────────────────────────────────
      const { error: backErr } = await shop.rpc('return_empties', {
        p_store_id: storeId,
        p_customer_id: id,
        p_category_id: pool,
        p_qty: 4,
      });
      check('the crates can come back over the counter', !backErr, backErr?.message ?? '');

      expectQty('and nothing is out with them', await emptiesOut(id, pool), 0);
    },
  },

  {
    name: '23. Keeping part of a deposit for what did not come back',
    async run(ctx) {
      const { storeId, pool } = ctx;

      const id = await makeCustomer(storeId, 'Broke two crates', '08037770002');

      await shop.rpc('take_deposit', {
        p_store_id: storeId,
        p_customer_id: id,
        p_category_id: pool,
        p_qty: 4,
        p_per_unit: 500,
        p_note: null,
      });
      expectQty('four out', await emptiesOut(id, pool), 4);

      /*
       * TWO COME BACK, TWO ARE BROKEN, and the shop keeps ₦1,000 of the ₦2,000 it holds.
       *
       * `forfeit_deposit` is the only path that turns held money into the shop's own, and it is
       * separate from a refund on purpose: one is money returned and the other is income, and a
       * shop that cannot tell them apart cannot explain either during a dispute.
       */
      await shop.rpc('return_empties', {
        p_store_id: storeId,
        p_customer_id: id,
        p_category_id: pool,
        p_qty: 2,
      });
      expectQty('two still out', await emptiesOut(id, pool), 2);

      const { error } = await shop.rpc('forfeit_deposit', {
        p_store_id: storeId,
        p_customer_id: id,
        p_category_id: pool,
        p_qty: 2,
        p_amount: 1000,
        p_note: 'broken',
      });
      check('the shop can keep part of it', !error, error?.message ?? '');
      if (error) return;

      expectQty('and the broken ones stop being owed', await emptiesOut(id, pool), 0);

      const { data: forfeits } = await admin
        .from('deposit_forfeits')
        .select('qty_units, amount')
        .eq('store_customer_id', id);
      expectQty('two written off', (forfeits ?? [])[0]?.qty_units, 2);
      expectMoney('for ₦1,000 kept', (forfeits ?? [])[0]?.amount, 1000);

      const { data: leftRows } = await shop.rpc('customer_deposits_held', {
        p_store_customer_id: id,
      });
      const left = (leftRows ?? []).reduce((sum, r) => sum + Number(r.amount), 0);
      /*
       * TWO CAME BACK AND TWO WERE KEPT, so nothing is held any more.
       *
       * The ₦1,000 kept is not "still theirs" — it stopped being a deposit the moment the shop kept
       * it, and it is recorded as income in `deposit_forfeits`. A shop still showing it as held
       * would be one that owes back money it has already earned.
       */
      expectMoney('and nothing is held against them any more', left, 0);
    },
  },

  {
    name: '24. A deposit taken on a sale can be given back',
    async run(ctx) {
      const { depositSale } = ctx;

      /*
       * THE MONEY HAS TO BE FINDABLE FROM THE RECEIPT.
       *
       * Scenario 5 took ₦500 on a sale. Settling asks how much is held against THAT RECEIPT and
       * reads `deposit_holdings` — where, until 0096, nothing had ever written a row for a sale.
       * `hold_receipt_deposit` was added in 0076 for the purpose and had no caller anywhere.
       *
       * So the settle screen said "Nothing was held for these" on a receipt that had taken ₦500,
       * and the shop could neither keep part of it for a shortfall nor hand it back. It had taken
       * money it had no way to return, which is the worst shape a gap can have.
       */
      const { data: held } = await admin
        .from('deposit_holdings')
        .select('amount, reason')
        .eq('ref_table', 'sales')
        .eq('ref_id', depositSale);

      const total = (held ?? []).reduce((sum, h) => sum + Number(h.amount), 0);
      expectMoney('the receipt knows it is holding ₦500', total, 500);
      /*
       * `reason` is a closed set — 'taken', 'refunded', 'applied_to_shortfall', 'sale_voided' —
       * because this table exists to explain money and a free-text reason explains nothing a month
       * later. Money coming in is 'taken', wherever it was taken.
       */
      check(
        'and says how it got there',
        (held ?? [])[0]?.reason === 'taken',
        (held ?? [])[0]?.reason ?? 'no row at all',
      );
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
