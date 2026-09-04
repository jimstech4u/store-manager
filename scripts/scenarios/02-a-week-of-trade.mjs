/**
 * Scenarios 4–7: a week of trade.
 *
 * A sale to the new customer. A sale that sends crates out and takes a deposit. A return that
 * settles old empties and new ones together. A count on a new day, and the gate that makes somebody
 * count before they sell.
 *
 * These share the shop the first three built, deliberately. The failures worth finding are the ones
 * that only appear when a deposit taken on Monday meets a return on Thursday, and a suite of
 * isolated units never meets them.
 */

import {
  admin,
  balanceOf,
  check,
  emptiesOut,
  expectMoney,
  expectQty,
  onHand,
  sell,
  shop,
} from './harness.mjs';

/** Every shape of one product, so a scenario can say "a crate" and mean the right id. */
async function shapesOf(storeId, productId) {
  const { data } = await shop.rpc('product_selling_units', { p_store_id: storeId });
  const mine = (data ?? []).filter((u) => u.product_id === productId);
  return {
    crate: mine.find((u) => u.unit_name === 'Crate'),
    bottle: mine.find((u) => u.unit_name === 'Bottle'),
  };
}

export const scenarios = [
  {
    name: '4. A sale on credit: what they owe, and what leaves the shelf',
    async run(ctx) {
      const { storeId, product, customer } = ctx;
      const { crate } = await shapesOf(storeId, product);

      const before = await balanceOf(customer);
      const shelfBefore = await onHand(product);

      /*
       * THREE CRATES AT ₦5,200, and nothing paid.
       *
       * The commonest sale in this trade: a regular takes a load and settles later. It is also the
       * one that catches an accounting mistake fastest, because the whole amount has to land on the
       * balance and none of it in the drawer.
       */
      const { saleId } = await sell(storeId, {
        customerId: customer,
        lines: [
          {
            product_id: product,
            qty: 3,
            pack_id: null,
            sale_unit_id: crate.product_unit_id,
            base_qty: 36,
            unit_price: 5200,
            line_total: 15600,
            containers_out: 0,
            deposit_charged: 0,
          },
        ],
        payments: [],
      });
      ctx.creditSale = saleId;
      check('a credit sale settles', Boolean(saleId));

      expectMoney('the whole bill lands on what they owe', await balanceOf(customer), before + 15600);
      expectQty('and thirty-six bottles leave the shelf', await onHand(product), shelfBefore - 36);

      /*
       * THE SHAPE IS ON THE LINE, which is the thing that was broken until 0085.
       *
       * A sale recorded without it comes back in base units, so three crates read as three bottles
       * and both the bill and the stock movement fall by twelve.
       */
      const { data: lines } = await admin
        .from('sale_lines')
        .select('sale_unit_id, entered_qty, base_qty')
        .eq('sale_id', saleId);
      check('the sale remembers it was sold in crates',
        lines?.[0]?.sale_unit_id === crate.product_unit_id,
        lines?.[0]?.sale_unit_id ?? 'nothing');
      expectQty('entered as 3', lines?.[0]?.entered_qty, 3);
      expectQty('and stored as 36 base units', lines?.[0]?.base_qty, 36);
    },
  },

  {
    name: '5. A sale that sends crates out, with a deposit taken against them',
    async run(ctx) {
      const { storeId, product, customer, pool } = ctx;
      const { crate } = await shapesOf(storeId, product);

      const owedBefore = await balanceOf(customer);
      const cratesBefore = await emptiesOut(customer, pool);

      /*
       * FOUR CRATES, AND ₦500 TAKEN AGAINST THEM.
       *
       * ₦125 a crate — the figure the shop actually collects, which is not the ₦1,500 the pool
       * suggests. The deposit is IN the total because the customer hands it over, and it is not
       * payment for goods: it comes back when the crates do.
       */
      const { saleId } = await sell(storeId, {
        customerId: customer,
        lines: [
          {
            product_id: product,
            qty: 4,
            pack_id: null,
            sale_unit_id: crate.product_unit_id,
            base_qty: 48,
            unit_price: 5200,
            line_total: 20800,
            containers_out: 4,
            deposit_charged: 500,
          },
        ],
        payments: [{ amount: 21300, method: 'cash' }],
      });
      ctx.depositSale = saleId;
      check('a sale with a deposit settles', Boolean(saleId));

      /*
       * PAID IN FULL means the balance does not move — goods AND deposit together.
       *
       * ₦20,800 of drink and ₦500 of deposit is ₦21,300, and that is what was handed over. A shop
       * whose balance moves here is either billing the deposit twice or not at all.
       */
      expectMoney('paying it all leaves nothing owing', await balanceOf(customer), owedBefore);

      expectQty('four more crates are out with them', await emptiesOut(customer, pool), cratesBefore + 4);

      /*
       * AND THE LEDGER KEPT THE RATE THE SHOP CHARGED, not the pool's suggestion.
       *
       * ₦500 over four crates is ₦125 each. Before 0088 this stamped the pool's ₦1,500, so the shop
       * recorded itself holding ₦6,000 it had never received and would have paid it back.
       */
      const { data: rows } = await admin
        .from('deposit_ledger')
        .select('qty_units, deposit_per_unit')
        .eq('ref_id', saleId)
        .eq('empties_category_id', pool);
      const row = (rows ?? [])[0];
      expectMoney('at the rate actually taken', row?.deposit_per_unit, 125);
    },
  },

  {
    name: '6. Bringing empties back: the old ones and the new ones together',
    async run(ctx) {
      const { storeId, customer, pool, depositSale } = ctx;

      const out = await emptiesOut(customer, pool);
      check('there are crates to bring back', out > 0, `${out} out`);

      /*
       * SETTLED AGAINST THE RECEIPT THAT SENT THEM.
       *
       * Empties are owed per receipt, not as one pile, because the deposit is held per receipt. A
       * customer bringing six crates against a receipt that only sent four is settling two
       * receipts, and the server says so rather than quietly over-crediting one.
       */
      const { data: result, error } = await shop.rpc('settle_empties', {
        p_store_id: storeId,
        p_sale_id: depositSale,
        p_returned: [{ category_id: pool, qty: 3 }],
        p_paid_for: [{ category_id: pool, qty: 1, amount: 1500 }],
        p_apply_amount: 0,
        p_refund_amount: 0,
        p_refund_mode: 'none',
        p_note: null,
      });
      check('a partial return settles', !error, error?.message ?? '');
      if (error) return;

      expectQty('three came back', result?.returned_units, 3);
      expectQty('and one is written off as gone', result?.written_off_units, 1);
      expectMoney('with what was paid for it', result?.paid_for, 1500);

      expectQty(
        'that receipt has nothing left out against it',
        await emptiesOut(customer, pool),
        out - 4,
      );

      /*
       * THE OPENING CRATES ARE STILL THERE.
       *
       * Four came in from the book in scenario 1 and were never against a receipt. Settling this
       * receipt must not touch them — they are a separate obligation with a separate story, and a
       * system that lets one settle the other cannot answer what a customer actually holds.
       */
      expectQty('the four from the book are untouched', await emptiesOut(customer, pool), 4);
    },
  },

  {
    name: '7. A count on a new day, and the gate that makes somebody count first',
    async run(ctx) {
      const { storeId, product } = ctx;

      const shelf = await onHand(product);

      /*
       * THE GATE, asked of something nobody has counted.
       *
       * A first version asked it of THIS product and expected true. It answered false, correctly:
       * scenario 2 opened its stock by counting it, today. So the question is asked of a product
       * that has never been counted, which is the state the gate exists for — a shop selling on
       * trust in its own records rather than on what is actually there.
       */
      const { data: freshId } = await shop.rpc('create_product', {
        p_store_id: storeId,
        p_name: 'Never counted',
        p_base_unit: 'piece',
        p_pack_name: null,
        p_pack_qty: null,
        p_list_price: null,
        p_price_per_pack: false,
      });
      const { data: dueFresh, error: dueErr } = await shop.rpc('needs_count_today', {
        p_product_id: freshId,
      });
      check('the till can ask whether something was counted today', !dueErr, dueErr?.message ?? '');
      check('and says a count is due on something never counted', dueFresh === true, String(dueFresh));

      const { data: dueCounted } = await shop.rpc('needs_count_today', { p_product_id: product });
      check(
        'and not due on one counted today',
        dueCounted === false,
        `${dueCounted} — opening the stock by count IS a count`,
      );

      /*
       * COUNTED SHORT, which is the interesting case.
       *
       * The records say one thing and the shelf says another, and the difference is the whole
       * reason to count. Nine bottles missing is an ordinary week — breakage, a sale nobody
       * recorded, a crate that went out on trust.
       */
      const counted = shelf - 9;

      /*
       * A COUNT IS A PERIOD, opened and closed — not one call.
       *
       * The period is what makes a count answerable afterwards: it records what the records
       * expected, what somebody found, and what was decided about the difference. A single
       * "set the stock to this" would lose all three.
       */
      const { data: periodId, error: openErr } = await shop.rpc('ensure_open_period', {
        p_product_id: product,
      });
      check('a counting period opens', !openErr, openErr?.message ?? '');
      if (openErr) return;

      const { error: countErr } = await shop.rpc('enter_stock_count', {
        p_period_id: periodId,
        p_counted: counted,
      });
      check('what was counted is entered', !countErr, countErr?.message ?? '');
      if (countErr) return;

      const { data: period } = await admin
        .from('stock_periods')
        .select('opening_qty, receiving_qty, sales_qty, expected_closing_qty, actual_closing_qty, variance_qty, period_start')
        .eq('id', periodId)
        .single();

      console.log(
        `      period: opened ${period?.opening_qty}, took in ${period?.receiving_qty}, ` +
          `sold ${period?.sales_qty}, expected ${period?.expected_closing_qty}`,
      );
      expectQty(
        'the records expected what the shelf said before',
        period?.expected_closing_qty,
        shelf,
      );
      expectQty('the count is what was found', period?.actual_closing_qty, counted);
      /*
       * NINE SHORT, and the sign matters.
       *
       * A negative variance is stock the shop has lost — breakage, a sale nobody recorded, a crate
       * that went out on trust. A shop cannot chase what it cannot see the sign of.
       */
      expectQty('and the difference is nine short', period?.variance_qty, -9);

      /*
       * IT WILL NOT CLOSE OVER AN UNEXPLAINED DIFFERENCE, and that is the point of counting.
       *
       * The first run tripped over this — "this period is off by 147, record a reason before
       * closing" — which is the shop refusing to let nine missing bottles become a rounding. A
       * reason first, then it closes.
       */
      const { error: unexplained } = await shop.rpc('close_stock_period', { p_period_id: periodId });
      check(
        'a count with a difference will not close unexplained',
        unexplained != null,
        unexplained ? unexplained.message.slice(0, 60) : 'it CLOSED without a reason',
      );

      const { error: whyErr } = await shop.rpc('resolve_variance', {
        p_period_id: periodId,
        // One of the shop's own reasons — the table refuses anything else, which is right.
        p_reason: 'unlogged_damage',
        p_note: 'nine broken in the store room',
      });
      check('the difference can be explained', !whyErr, whyErr?.message ?? '');

      const { error: closeErr } = await shop.rpc('close_stock_period', { p_period_id: periodId });
      check('and then the count closes', !closeErr, closeErr?.message ?? '');

      expectQty('and the shelf now says what was counted', await onHand(product), counted);

      const { data: after } = await shop.rpc('needs_count_today', { p_product_id: product });
      check('the gate lifts for the rest of the day', after === false, String(after));
    },
  },
];
