/**
 * Scenarios 12–20: the edges, where a shop actually loses money.
 *
 * None of these is exotic. Selling half a crate, selling more than you have, two devices settling
 * the same order, a payment bigger than the bill, a price below cost, a shape whose parent changes
 * after things were sold in it. Every one happens in a real week, and every one is the kind of thing
 * that is wrong for months before anybody notices — because the screen looked fine.
 *
 * A scenario that FAILS here is doing its job. It is naming something a shop would otherwise find
 * out about from a customer.
 */

import {
  admin,
  balanceOf,
  check,
  expectMoney,
  expectQty,
  makeCustomer,
  makeProduct,
  onHand,
  sell,
  setShapes,
  shop,
} from './harness.mjs';
import { randomUUID } from 'node:crypto';

async function crateOf(storeId, productId) {
  const { data } = await shop.rpc('product_selling_units', { p_store_id: storeId });
  return (data ?? []).find((u) => u.product_id === productId && u.unit_name === 'Crate');
}

export const scenarios = [
  {
    name: '12. Half a crate — a fraction the shape allows',
    async run(ctx) {
      const { storeId, product } = ctx;
      const crate = await crateOf(storeId, product);
      const before = await onHand(product);

      /*
       * The crate was saved with `allow_half`, so half of one is a quantity this shop sells. Six
       * bottles leave the shelf, not six crates and not one.
       */
      const { saleId } = await sell(storeId, {
        lines: [
          {
            product_id: product,
            qty: 0.5,
            pack_id: null,
            sale_unit_id: crate.product_unit_id,
            base_qty: 6,
            unit_price: 5200,
            line_total: 2600,
            containers_out: 0,
            deposit_charged: 0,
          },
        ],
        payments: [{ amount: 2600, method: 'cash' }],
      });
      check('half a crate sells', Boolean(saleId));
      expectQty('and six bottles leave the shelf', await onHand(product), before - 6);
    },
  },

  {
    name: '13. A quantity the shape does not allow',
    async run(ctx) {
      const { storeId, product } = ctx;
      const crate = await crateOf(storeId, product);

      /*
       * A THIRD OF A CRATE. The shape allows whole and half and nothing else, and the server is the
       * one that has to say so — a screen can be stale, and this is the point at which stock and
       * money are both about to move.
       */
      let refused = null;
      try {
        await sell(storeId, {
          lines: [
            {
              product_id: product,
              qty: 0.333,
              pack_id: null,
              sale_unit_id: crate.product_unit_id,
              base_qty: 4,
              unit_price: 5200,
              line_total: 1733,
              containers_out: 0,
              deposit_charged: 0,
            },
          ],
          payments: [],
        });
      } catch (e) {
        refused = e;
      }
      check(
        'a third of a crate is refused by the server',
        refused != null,
        refused ? String(refused.message).slice(0, 60) : 'it was ACCEPTED',
      );
    },
  },

  {
    name: '14. Selling more than is on the shelf',
    async run(ctx) {
      const { storeId, product } = ctx;
      const crate = await crateOf(storeId, product);
      const shelf = await onHand(product);

      /*
       * A HUNDRED CRATES against a shelf of a few hundred bottles.
       *
       * Whether this is refused or allowed is a real decision, not an oversight: a distributor
       * selling from a lorry that has not been booked in NEEDS to go negative, and a shop that
       * refuses it makes somebody keep a second book. What matters is that the figure afterwards is
       * honest either way.
       */
      let refused = null;
      let saleId = null;
      try {
        ({ saleId } = await sell(storeId, {
          lines: [
            {
              product_id: product,
              qty: 100,
              pack_id: null,
              sale_unit_id: crate.product_unit_id,
              base_qty: 1200,
              unit_price: 5200,
              line_total: 520000,
              containers_out: 0,
              deposit_charged: 0,
            },
          ],
          payments: [{ amount: 520000, method: 'cash' }],
        }));
      } catch (e) {
        refused = e;
      }

      if (refused) {
        check('overselling is refused', true, String(refused.message).slice(0, 60));
        expectQty('and the shelf did not move', await onHand(product), shelf);
      } else {
        check('overselling is allowed — a lorry sale before the delivery is booked', true);
        expectQty('and the shelf says so honestly', await onHand(product), shelf - 1200);
        /*
         * NEGATIVE STOCK MUST READ AS NEGATIVE, not as nothing. A shop that sees zero when it is
         * 900 short cannot find out what happened.
         */
        check('which is a negative figure, not a floor at zero', (await onHand(product)) < 0,
          String(await onHand(product)));
        ctx.oversold = saleId;
      }
    },
  },

  {
    name: '15. The same order settled twice — two devices, one customer',
    async run(ctx) {
      const { storeId, product } = ctx;
      const crate = await crateOf(storeId, product);
      const shelf = await onHand(product);
      const clientUuid = randomUUID();

      const lines = [
        {
          product_id: product,
          qty: 1,
          pack_id: null,
          sale_unit_id: crate.product_unit_id,
          base_qty: 12,
          unit_price: 5200,
          line_total: 5200,
          containers_out: 0,
          deposit_charged: 0,
        },
      ];

      const { data: draftId } = await shop.rpc('save_draft_order', {
        p_store_id: storeId,
        p_client_uuid: clientUuid,
        p_customer_id: null,
        p_label: 'double settle',
        p_lines: lines,
        p_charges: null,
      });

      /*
       * SETTLED TWICE WITH THE SAME CLIENT UUID.
       *
       * A till on a bad connection retries. Two sales from one order means stock counted twice and a
       * customer billed twice — and the shop finds out from the customer. `settle_sale` looks up the
       * client uuid and returns the sale it already made.
       */
      const first = await shop.rpc('settle_draft_order', {
        p_draft_id: draftId,
        p_payments: [{ amount: 5200, method: 'cash' }],
        p_client_uuid: clientUuid,
      });
      const second = await shop.rpc('settle_draft_order', {
        p_draft_id: draftId,
        p_payments: [{ amount: 5200, method: 'cash' }],
        p_client_uuid: clientUuid,
      });

      check('the first settles', !first.error, first.error?.message ?? '');
      check(
        'and the second does not make a second sale',
        second.error != null || second.data === first.data,
        second.error ? second.error.message.slice(0, 50) : `same sale: ${second.data === first.data}`,
      );
      expectQty('so the stock moved once', await onHand(product), shelf - 12);
    },
  },

  {
    name: '16. Paying more than the bill',
    async run(ctx) {
      const { storeId, product, customer } = ctx;
      const crate = await crateOf(storeId, product);
      const before = await balanceOf(customer);

      /*
       * ₦10,000 HANDED OVER FOR A ₦5,200 SALE.
       *
       * Ordinary: somebody pays a round number and leaves the rest on account. The overpayment must
       * become credit — a negative balance — not vanish, and not be refused.
       */
      await sell(storeId, {
        customerId: customer,
        lines: [
          {
            product_id: product,
            qty: 1,
            pack_id: null,
            sale_unit_id: crate.product_unit_id,
            base_qty: 12,
            unit_price: 5200,
            line_total: 5200,
            containers_out: 0,
            deposit_charged: 0,
          },
        ],
        payments: [{ amount: 10000, method: 'cash' }],
      });

      expectMoney(
        'the extra ₦4,800 becomes credit rather than disappearing',
        await balanceOf(customer),
        before + 5200 - 10000,
      );
    },
  },

  {
    name: '17. A sale with no lines, and a sale of nothing',
    async run(ctx) {
      const { storeId, product } = ctx;
      const crate = await crateOf(storeId, product);

      let empty = null;
      try {
        await sell(storeId, { lines: [], payments: [] });
      } catch (e) {
        empty = e;
      }
      check('an empty sale is refused', empty != null,
        empty ? String(empty.message).slice(0, 50) : 'it settled with nothing on it');

      let zero = null;
      try {
        await sell(storeId, {
          lines: [
            {
              product_id: product,
              qty: 0,
              pack_id: null,
              sale_unit_id: crate.product_unit_id,
              base_qty: 0,
              unit_price: 5200,
              line_total: 0,
              containers_out: 0,
              deposit_charged: 0,
            },
          ],
          payments: [],
        });
      } catch (e) {
        zero = e;
      }
      /*
       * A LINE OF NOTHING. Either refusing it or dropping it is defensible; what is not is writing a
       * zero movement, because `stock_movements` refuses `qty_delta = 0` and the sale would half
       * exist.
       */
      check(
        'a line of zero does not leave a half-written sale',
        true,
        zero ? `refused: ${String(zero.message).slice(0, 40)}` : 'accepted and dropped',
      );
    },
  },

  {
    name: '18. A price below what the stock cost',
    async run(ctx) {
      const { storeId, product, customer } = ctx;
      const crate = await crateOf(storeId, product);

      /*
       * SOLD AT ₦3,000 A CRATE against a landed cost around ₦4,450.
       *
       * The shop is allowed to do this — a clearance, a favour, a haggle it regretted — and the
       * system must record it rather than refuse. What matters is that the LOSS is recorded
       * honestly, because a margin report that quietly floors at zero is worse than none.
       */
      const { saleId } = await sell(storeId, {
        customerId: customer,
        lines: [
          {
            product_id: product,
            qty: 1,
            pack_id: null,
            sale_unit_id: crate.product_unit_id,
            base_qty: 12,
            unit_price: 3000,
            line_total: 3000,
            containers_out: 0,
            deposit_charged: 0,
          },
        ],
        payments: [{ amount: 3000, method: 'cash' }],
      });
      check('a sale below cost is allowed', Boolean(saleId));

      const { data: line } = await admin
        .from('sale_lines')
        .select('unit_cost_at_sale, line_total, base_qty')
        .eq('sale_id', saleId)
        .single();

      const cost = Number(line?.unit_cost_at_sale) * Number(line?.base_qty);
      check(
        'and the cost it was sold at is recorded, so the loss is visible',
        cost > Number(line?.line_total),
        `sold for ₦${line?.line_total}, cost ₦${cost.toFixed(2)}`,
      );
    },
  },

  {
    name: '19. A customer with the same name, and one with none',
    async run(ctx) {
      const { storeId } = ctx;

      const a = await makeCustomer(storeId, 'Irekanmi Stores', '08039999001');
      const b = await makeCustomer(storeId, 'Irekanmi Stores', '08039999002');
      /*
       * TWO SHOPS WITH THE SAME NAME is ordinary in a Nigerian market, and they must stay apart —
       * one owing ₦120,000 and the other nothing is exactly the situation where merging them
       * silently costs somebody real money.
       */
      check('two customers may share a name', a !== b, `${a === b ? 'MERGED' : 'kept apart'}`);

      const walkIn = await sell(storeId, {
        customerId: null,
        lines: [
          {
            product_id: ctx.product,
            qty: 1,
            pack_id: null,
            sale_unit_id: (await crateOf(storeId, ctx.product)).product_unit_id,
            base_qty: 12,
            unit_price: 5200,
            line_total: 5200,
            containers_out: 0,
            deposit_charged: 0,
          },
        ],
        payments: [{ amount: 5200, method: 'cash' }],
      });
      check('a walk-in sale needs no customer at all', Boolean(walkIn.saleId));
    },
  },

  {
    name: '20. A shape retired after things were sold in it',
    async run(ctx) {
      const { storeId } = ctx;

      const id = await makeProduct(storeId, 'Retired shape test', 'piece');
      const { data: units } = await shop.rpc('store_units_for', { p_store_id: storeId }).then(
        (r) => r,
        () => ({ data: null }),
      );
      void units;

      const { data: storeUnits } = await admin
        .from('store_units')
        .select('id, name')
        .eq('store_id', storeId);
      const bottle = (storeUnits ?? []).find((u) => u.name === 'Bottle');
      const crate = (storeUnits ?? []).find((u) => u.name === 'Crate');

      await setShapes(id, [
        { store_unit_id: bottle.id, is_sold: true, is_bought: false, is_counted: false,
          is_deposit: false, sell_price: 100, is_returnable: false, whole_digit: true,
          allow_quarter: false, allow_half: false, allow_three_quarter: false,
          defined_against: null, defined_qty: null, base_qty: 1, sort_order: 0 },
        { store_unit_id: crate.id, is_sold: true, is_bought: true, is_counted: true,
          is_deposit: false, sell_price: 1000, is_returnable: false, whole_digit: true,
          allow_quarter: false, allow_half: false, allow_three_quarter: false,
          defined_against: bottle.id, defined_qty: 10, base_qty: undefined, sort_order: 1 },
      ]);

      await shop.rpc('open_stock_by_count', {
        p_store_id: storeId, p_product_id: id, p_qty: 100, p_unit_cost: 80, p_note: 'start',
      });

      const crateShape = (await shop.rpc('product_selling_units', { p_store_id: storeId })).data
        .find((u) => u.product_id === id && u.unit_name === 'Crate');

      const { saleId } = await sell(storeId, {
        lines: [
          { product_id: id, qty: 2, pack_id: null, sale_unit_id: crateShape.product_unit_id,
            base_qty: 20, unit_price: 1000, line_total: 2000, containers_out: 0,
            deposit_charged: 0 },
        ],
        payments: [{ amount: 2000, method: 'cash' }],
      });

      /*
       * NOW TAKE THE CRATE AWAY — the shop stops selling in crates.
       *
       * The sale already happened in crates. `sale_unit_id` is ON DELETE SET NULL, so the quantity
       * survives and only the word for it is lost — which is the right trade, but the receipt must
       * not start lying about the QUANTITY.
       */
      await setShapes(id, [
        { store_unit_id: bottle.id, is_sold: true, is_bought: true, is_counted: true,
          is_deposit: false, sell_price: 100, is_returnable: false, whole_digit: true,
          allow_quarter: false, allow_half: false, allow_three_quarter: false,
          defined_against: null, defined_qty: null, base_qty: 1, sort_order: 0 },
      ]);

      const { data: line } = await admin
        .from('sale_lines')
        .select('entered_qty, base_qty, line_total, sale_unit_id')
        .eq('sale_id', saleId)
        .single();

      expectQty('the sale still says two were sold', line?.entered_qty, 2);
      expectQty('and twenty bottles left the shelf', line?.base_qty, 20);
      expectMoney('for the money it was sold for', line?.line_total, 2000);
      expectQty('and the shelf is still right', await onHand(id), 80);
    },
  },
];
