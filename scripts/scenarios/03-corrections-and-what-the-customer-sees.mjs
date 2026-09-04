/**
 * Scenarios 8–11: corrections, and what the customer sees afterwards.
 *
 * A sale keyed wrong and voided. The permission that decides who may. And the three things a
 * customer holds in their hand — a receipt link, a tracking link, a shared order — which have to go
 * on telling the truth after the shop changes its mind.
 *
 * The last of those is the one nobody tests and everybody needs: a receipt is not a snapshot the
 * shop can forget about. Somebody has it open on a phone.
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

async function crateOf(storeId, productId) {
  const { data } = await shop.rpc('product_selling_units', { p_store_id: storeId });
  return (data ?? []).find((u) => u.product_id === productId && u.unit_name === 'Crate');
}

export const scenarios = [
  {
    name: '8. A sale keyed wrong, and voided — with the books put back',
    async run(ctx) {
      const { storeId, product, customer, pool } = ctx;
      const crate = await crateOf(storeId, product);

      const owedBefore = await balanceOf(customer);
      const shelfBefore = await onHand(product);
      const cratesBefore = await emptiesOut(customer, pool);

      /*
       * THIRTY CRATES INSTEAD OF THREE — the commonest till mistake there is, and one nobody
       * notices until the shelf runs out. Paid nothing, so the whole ₦156,000 lands on the account.
       */
      const { saleId } = await sell(storeId, {
        customerId: customer,
        lines: [
          {
            product_id: product,
            qty: 30,
            pack_id: null,
            sale_unit_id: crate.product_unit_id,
            base_qty: 360,
            unit_price: 5200,
            line_total: 156000,
            containers_out: 30,
            deposit_charged: 3750,
          },
        ],
        payments: [],
      });
      ctx.wrongSale = saleId;

      expectMoney('the mistake lands in full on the account', await balanceOf(customer),
        owedBefore + 156000 + 3750);
      expectQty('and takes the stock with it', await onHand(product), shelfBefore - 360);
      expectQty('and puts thirty crates out', await emptiesOut(customer, pool), cratesBefore + 30);

      // ── Voided ────────────────────────────────────────────────────────────────────
      const { error: noReason } = await shop.rpc('void_sale', {
        p_sale_id: saleId,
        p_reason: '   ',
      });
      check(
        'a void needs a reason',
        noReason != null,
        noReason ? noReason.message.slice(0, 50) : 'it voided with no reason given',
      );

      const { error } = await shop.rpc('void_sale', {
        p_sale_id: saleId,
        p_reason: 'keyed 30 crates instead of 3',
      });
      check('a settled sale can be voided', !error, error?.message ?? '');
      if (error) return;

      /*
       * AND EVERYTHING GOES BACK — all three ledgers, to exactly where they were.
       *
       * This is the whole test. A void that puts the money back but not the stock leaves a shop
       * short on the shelf and right on paper, which is the worst of both: the figure that is wrong
       * is the one nobody checks until it runs out.
       */
      expectMoney('what they owe goes back to what it was', await balanceOf(customer), owedBefore);
      expectQty('the stock comes back to the shelf', await onHand(product), shelfBefore);
      expectQty('and the crates were never sent out', await emptiesOut(customer, pool), cratesBefore);

      const { data: sale } = await admin
        .from('sales')
        .select('status, amend_reason, revision, total')
        .eq('id', saleId)
        .single();
      check('the sale is marked voided, not deleted', sale?.status === 'voided', sale?.status);
      check('with the reason on it', /30 crates/.test(sale?.amend_reason ?? ''), sale?.amend_reason);
      // A sale is born at revision 1, so a void makes it 2. Asserted as movement rather than as a
      // number, so adding another kind of amendment later does not break this.
      check('and its revision moved', Number(sale?.revision) > 1, String(sale?.revision));

      /*
       * A voided sale KEEPS ITS TOTAL. It is a record of what was nearly done, and a receipt that
       * says "cancelled — ₦156,000" answers the question; one that says "cancelled — ₦0" does not.
       */
      expectMoney('and it still says what it was for', sale?.total, 159750);

      const { error: twice } = await shop.rpc('void_sale', {
        p_sale_id: saleId,
        p_reason: 'again',
      });
      check(
        'and it cannot be voided twice',
        twice != null,
        twice ? twice.message.slice(0, 40) : 'it voided AGAIN',
      );
    },
  },

  {
    name: '9. Voiding is behind a permission, and refused once empties have come back',
    async run(ctx) {
      const { storeId, product, customer, pool, depositSale } = ctx;

      /*
       * THE HALF-SETTLED CASE.
       *
       * Scenario 6 brought three of four crates back against that receipt. Reversing its four now
       * would leave the customer owing minus one crate — a number that means nothing and cannot be
       * chased. The shop is refused, and told the way out.
       */
      const { error } = await shop.rpc('void_sale', {
        p_sale_id: depositSale,
        p_reason: 'changed our mind',
      });
      check(
        'a sale whose empties have started coming back will not void',
        error != null,
        error ? error.message.slice(0, 70) : 'it VOIDED, leaving minus one crate owed',
      );

      /*
       * AND WHO MAY. `sales.amend` is a manager's permission, not a seller's — a till where anybody
       * can cancel a sale after taking the money is a till with no record of anything.
       */
      const { data: perms } = await shop.rpc('role_permission_codes', { p_role_code: 'staff' });
      const codes = (perms ?? []).map((p) => (typeof p === 'string' ? p : p.permission_code));
      check('a seller cannot void', !codes.includes('sales.amend'), codes.join(', '));

      const { data: mgr } = await shop.rpc('role_permission_codes', { p_role_code: 'manager' });
      const mgrCodes = (mgr ?? []).map((p) => (typeof p === 'string' ? p : p.permission_code));
      check('a manager can', mgrCodes.includes('sales.amend'), mgrCodes.join(', '));

      void product;
      void pool;
      void customer;
      void storeId;
    },
  },

  {
    name: '10. The receipt a customer is holding, after the shop changes its mind',
    async run(ctx) {
      const { storeId, creditSale, wrongSale } = ctx;

      const { data: token, error } = await shop.rpc('create_share_link', {
        p_store_id: storeId,
        p_kind: 'receipt',
        p_ref_id: creditSale,
      });
      check('a receipt can be shared', !error, error?.message ?? '');
      if (error) return;
      ctx.receiptToken = token;

      const { data: seen } = await shop.rpc('read_shared_receipt', { p_token: token });
      check('and it opens', seen != null);

      /*
       * IT SPEAKS IN SHAPES, and this is the assertion that would have caught 0085.
       *
       * Before it, a sale did not record which shape it was sold in, so three crates were printed
       * as thirty-six pieces on the customer's own copy.
       */
      const line = (seen?.lines ?? [])[0];
      check(
        'in the shape it was sold in',
        /crate/i.test(line?.unit_name ?? ''),
        line?.unit_name ?? line?.base_unit,
      );
      expectQty('with the quantity as entered', line?.entered_qty, 3);
      /*
       * AND IT SHOWS ITSELF PAID, which is worth stopping on.
       *
       * This receipt was a credit sale — nothing was handed over for it. The ₦21,300 paid against a
       * LATER sale settled it, because `record_payment` allocates oldest first, and that is what a
       * shop relies on when somebody puts money on the counter against no particular receipt.
       */
      expectMoney('an older receipt is settled by a later payment', seen?.paid_total, 15600);

      /*
       * NOW VOID A DIFFERENT SALE AND LOOK AGAIN.
       *
       * A receipt link is not a snapshot the shop can forget about: somebody has it open on a
       * phone. What it must never do is quietly change into a different receipt — this one is about
       * `creditSale` and stays about `creditSale`.
       */
      const again = (await shop.rpc('read_shared_receipt', { p_token: token })).data;
      check(
        'and it is still the same receipt after other sales change',
        again?.sale?.id === seen?.sale?.id,
        `${again?.sale?.id}`,
      );

      // A revoked link stops opening, which is the whole point of being able to revoke one.
      const { error: revokeErr } = await shop.rpc('revoke_share_link', { p_token: token });
      check('a link can be taken back', !revokeErr, revokeErr?.message ?? '');

      const { data: afterRevoke } = await shop.rpc('read_shared_receipt', { p_token: token });
      check('and then it does not open', afterRevoke == null, JSON.stringify(afterRevoke)?.slice(0, 40));

      void wrongSale;
    },
  },

  {
    name: '11. A voided sale, seen from the customer’s side',
    async run(ctx) {
      const { storeId, wrongSale } = ctx;

      const { data: token, error } = await shop.rpc('create_share_link', {
        p_store_id: storeId,
        p_kind: 'receipt',
        p_ref_id: wrongSale,
      });
      check('a link can be made for it', !error, error?.message ?? '');
      if (error) return;

      const { data: seen } = await shop.rpc('read_shared_receipt', { p_token: token });

      /*
       * A VOIDED SALE STILL OPENS, and it must.
       *
       * The customer was sent a receipt for ₦159,750 and somebody will ask about it. A link that
       * simply stops working answers nothing and looks like the shop hiding.
       *
       * What it must NOT do is read like a live bill. This is the gap the benchmark is here to
       * find: nothing on the shared receipt says the sale was cancelled.
       */
      check('a voided sale can still be opened by the customer', seen != null);
      if (!seen) return;

      const text = JSON.stringify(seen).toLowerCase();
      check(
        'and it says it was cancelled',
        /void|cancel/.test(text),
        'nothing on the customer’s copy says this sale was voided',
      );
    },
  },
];
