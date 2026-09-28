/**
 * Scenarios 36–38: the crate and the deposit come home, or they do not.
 *
 * Sending containers out is the easy direction and it is well covered. The argument happens six
 * weeks later, when somebody brings the crates back and wants their money — and that half had
 * almost nothing behind it. `write_off_empties` had never been run by any scenario, and neither
 * had the group return path.
 *
 * AGAINST THE MODEL THE APP ACTUALLY USES. There are two in this database: containers were once
 * owed against an empties POOL with its own rate, and are now owed against the product's own
 * SHAPE (0108), recorded by a trigger on `sale_lines` (0117). `returnables_for_sale` is
 * deliberately empty and `deposit_ledger` takes no new rows — which is why the pool tables are at
 * zero in the live shop, and why `refund_deposit` and `forfeit_deposit` are orphans nothing calls.
 *
 * A first draft of this file tested those orphans and failed against a retired design. These test
 * what the till does: `record_customer_empties`, `settle_customer_deposit` and
 * `write_off_empties`.
 *
 *   36. Crates come back, and the deposit goes back with them.
 *   37. The shop keeps a deposit instead, and the books can tell the two apart.
 *   38. Crates that are never coming back are written off, with a fee.
 */
import {
  admin,
  check,
  depositHeld,
  emptiesOut,
  expectMoney,
  expectQty,
  sell,
  shop,
} from './harness.mjs';

export const scenarios = [
  {
    name: '36. Crates come back, and the deposit goes back with them',
    async run(ctx) {
      const { storeId, product, customer, crateShape } = ctx;

      /*
       * Two crates out with N250 held against them, so this scenario owns the figures it is
       * about to check rather than inheriting whatever earlier scenarios left behind.
       */
      await sell(storeId, {
        customerId: customer,
        label: 'crates out, deposit held',
        lines: [
          {
            product_id: product,
            qty: 2,
            pack_id: null,
            sale_unit_id: crateShape,
            base_qty: 24,
            unit_price: 5200,
            line_total: 10400,
            containers_out: 2,
            deposit_charged: 0,
          },
        ],
        payments: [{ amount: 10400, method: 'cash' }],
      });

      await shop.rpc('take_customer_deposit', {
        p_store_id: storeId,
        p_customer_id: customer,
        p_amount: 250,
        p_reason: 'two crates',
        p_occurred_at: new Date().toISOString(),
      });

      const owedBefore = await emptiesOut(customer, crateShape);
      const heldBefore = await depositHeld(customer);
      expectMoney('the shop is holding the deposit', heldBefore >= 250 ? 250 : heldBefore, 250);

      // ── One crate back ────────────────────────────────────────────────────
      const { error: backErr } = await shop.rpc('record_customer_empties', {
        p_store_id: storeId,
        p_customer_id: customer,
        p_product_unit_id: crateShape,
        // 'returned', not 'in'. The ledger's words are out / returned / damaged, and a container
        // coming back damaged is a different fact from one coming back.
        p_direction: 'returned',
        p_qty: 1,
        p_reason: 'brought one back',
        p_ref_table: null,
        p_ref_id: null,
        p_occurred_at: new Date().toISOString(),
        // Whose shelf it sits on. The till always says `they_hold` for a customer's containers.
        p_side: 'they_hold',
      });
      check('a crate can come back', !backErr, backErr?.message ?? '');
      expectQty(
        'and the customer owes one fewer',
        owedBefore - (await emptiesOut(customer, crateShape)),
        1,
      );

      // ── And the money for it ──────────────────────────────────────────────
      const { error: payErr } = await shop.rpc('settle_customer_deposit', {
        p_store_id: storeId,
        p_customer_id: customer,
        p_amount: 125,
        p_keep: false,
        p_reason: 'one crate returned',
        p_occurred_at: new Date().toISOString(),
      });
      check('the deposit for it goes back', !payErr, payErr?.message ?? '');
      expectMoney(
        'and the shop holds exactly that much less',
        heldBefore - (await depositHeld(customer)),
        125,
      );
    },
  },

  {
    name: '37. The shop keeps a deposit instead, and the books tell the two apart',
    async run(ctx) {
      const { storeId, customer } = ctx;
      const heldBefore = await depositHeld(customer);

      /*
       * KEEPING IS NOT GIVING BACK WITH A DIFFERENT WORD.
       *
       * Both reduce what the shop is holding, and only one of them is money the shop earned.
       * "What did we make on deposits this year" cannot be answered from a ledger that records
       * them the same way, so `p_keep` has to survive into the row.
       */
      const { error } = await shop.rpc('settle_customer_deposit', {
        p_store_id: storeId,
        p_customer_id: customer,
        p_amount: 125,
        p_keep: true,
        p_reason: 'crate not coming back',
        p_occurred_at: new Date().toISOString(),
      });
      check('a deposit can be kept, with a reason', !error, error?.message ?? '');

      expectMoney(
        'the shop holds that much less either way',
        heldBefore - (await depositHeld(customer)),
        125,
      );

      const { data: rows } = await admin
        .from('customer_deposits')
        .select('direction, amount, reason')
        .eq('store_customer_id', customer);
      const kept = (rows ?? []).filter((r) => r.direction === 'retained');
      const given = (rows ?? []).filter((r) => r.direction === 'given');

      check(
        'and the books say which it was',
        kept.length > 0 && given.length > 0,
        `kept ${kept.length}, given back ${given.length}`,
      );
    },
  },

  {
    name: '38. Crates that are never coming back are written off, with a fee',
    async run(ctx) {
      const { storeId, product, customer, crateShape } = ctx;

      const owedBefore = await emptiesOut(customer, crateShape);
      if (owedBefore <= 0) {
        // Nothing outstanding to write off would make every assertion below vacuous.
        await sell(storeId, {
          customerId: customer,
          label: 'one more crate out',
          lines: [
            {
              product_id: product,
              qty: 1,
              pack_id: null,
              sale_unit_id: crateShape,
              base_qty: 12,
              unit_price: 5200,
              line_total: 5200,
              containers_out: 1,
              deposit_charged: 0,
            },
          ],
          payments: [{ amount: 5200, method: 'cash' }],
        });
      }

      const owed = await emptiesOut(customer, crateShape);
      check('there is a crate outstanding to write off', owed >= 1, `owed ${owed}`);

      /*
       * THE CRATE STOPS BEING OWED AND THE CUSTOMER IS CHARGED FOR IT.
       *
       * Both, together. Clearing the debt without the charge is the shop making a present of a
       * crate; charging without clearing it leaves them owing a container they have paid for.
       */
      const { data: out, error } = await shop.rpc('write_off_empties', {
        p_store_id: storeId,
        p_customer_id: customer,
        p_parts: [{ product_unit_id: crateShape, qty: 1 }],
        p_reason: 'never coming back',
        p_said: '1 crate',
        p_fee: 1500,
      });
      check('a crate can be written off', !error, error?.message ?? '');

      expectQty(
        'the customer stops owing it',
        owed - (await emptiesOut(customer, crateShape)),
        1,
      );

      /*
       * THE DEPOSIT PAYS TOWARDS THE REPLACEMENT, and only the shortfall is charged.
       *
       * A fee of N1,500 against N300 already held comes to N1,200 on the account — which is the
       * correct and slightly surprising answer, and the reason to assert the RELATIONSHIP rather
       * than a figure typed into the test. Asserting a flat 1,500 would have called right
       * behaviour a failure.
       */
      const kept = Number((out ?? {}).kept) || 0;
      const charged = Number((out ?? {}).charged) || 0;
      expectMoney('what it kept and what it charged come to the fee', kept + charged, 1500);
      check(
        'the deposit it was holding went towards the replacement',
        kept > 0 && charged === 1500 - kept,
        `kept ${kept}, charged ${charged}`,
      );

      /*
       * AS A CHARGE ON THEIR ACCOUNT, which is the only place it can be argued about later.
       */
      const { data: charges } = await admin
        .from('customer_charges')
        .select('direction, amount, reason')
        .eq('store_customer_id', customer);
      check(
        'the charge is on the account, not just in the reply',
        (charges ?? []).some((c) => Math.abs(Number(c.amount) - charged) < 0.01),
        (charges ?? []).map((c) => `${c.direction} ${c.amount}`).join(', ') || 'nothing recorded',
      );
    },
  },
];
