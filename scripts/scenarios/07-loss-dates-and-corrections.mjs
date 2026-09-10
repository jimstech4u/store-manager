/**
 * Scenarios 31–34: what goes wrong, and putting it right.
 *
 * The three things this round added, walked through on the shop the earlier scenarios built —
 * because the failures worth finding are the ones that only appear when a delivery from Monday
 * meets a count on Thursday and a correction on Friday.
 *
 *   31. The yard can be counted, and the count reaches the figure.
 *   32. A shortfall is explained in as many pieces as it took.
 *   33. Stock carries a date, per delivery, with its own cost.
 *   34. A settled receipt is corrected, and a walk-in acquires a customer when it has to.
 */

import { admin, check, expectMoney, expectQty, onHand, sell, shop } from './harness.mjs';

export const scenarios = [
  {
    name: '31. The yard is counted, and the count reaches the figure',
    async run(ctx) {
      const { storeId, customer } = ctx;

      const { data: countable } = await shop.rpc('countable_empties', { p_store_id: storeId });
      check('the shop can be asked what it has to count', (countable ?? []).length > 0,
        `${(countable ?? []).length} shapes`);
      if (!(countable ?? []).length) return;

      const shape = countable[0];

      /*
       * BEFORE ANYBODY COUNTS, the yard has no figure — and says so.
       *
       * This is the bug that shipped: with no starting position the movements alone were reported
       * as a position, so a shop that had sold four thousand crates read "−4,587 in the yard" and
       * had never been short of one. A position nobody established is not a position.
       */
      const before = ((await shop.rpc('yard_empties', { p_store_id: storeId })).data ?? []).find(
        (y) => y.product_unit_id === shape.product_unit_id,
      );
      check(
        'an uncounted yard says so rather than inventing a figure',
        before && before.in_yard === null,
        `in_yard=${before?.in_yard}`,
      );

      await shop.rpc('count_empties', {
        p_store_id: storeId,
        p_parts: [{ product_unit_id: shape.product_unit_id, qty: 40 }],
        p_note: 'benchmark walk of the yard',
      });

      const counted = ((await shop.rpc('yard_empties', { p_store_id: storeId })).data ?? []).find(
        (y) => y.product_unit_id === shape.product_unit_id,
      );
      expectQty('a count reaches the yard', counted?.in_yard, 40);

      /*
       * AND EVERY WAY A CONTAINER MOVES IS WEIGHED. The yard used to know five of nine: a crate of
       * ours going out on a lorry, or one of theirs handed back, moved nothing at all.
       */
      const { data: supplierId } = await shop.rpc('upsert_supplier', {
        p_store_id: storeId,
        p_name: 'Benchmark Brewery',
      });
      await shop.rpc('record_supplier_empties', {
        p_store_id: storeId,
        p_product_unit_id: shape.product_unit_id,
        p_qty: 6,
        p_supplier_id: supplierId,
        p_side: 'they_hold',
        p_direction: 'out',
      });
      const afterOut = ((await shop.rpc('yard_empties', { p_store_id: storeId })).data ?? []).find(
        (y) => y.product_unit_id === shape.product_unit_id,
      );
      expectQty('ours going out on a lorry comes off the yard', afterOut?.in_yard, 34);

      /*
       * COUNTED BY MAKER, which is what a distributor's yard actually is — one stack of crates,
       * the same crate whatever beer was in it last. Authoritative for the group, and honest about
       * not knowing the split.
       */
      if (shape.group_id) {
        await shop.rpc('count_empties', {
          p_store_id: storeId,
          p_parts: [
            { category_id: shape.group_id, store_unit_id: shape.store_unit_id, qty: 500 },
          ],
        });
        const byShape = ((await shop.rpc('yard_empties', { p_store_id: storeId })).data ?? []).find(
          (y) => y.product_unit_id === shape.product_unit_id,
        );
        check(
          'a maker count takes over, and the shape stops claiming a share it cannot know',
          byShape?.counted_grain === 'group' && byShape?.in_yard === null,
          `grain=${byShape?.counted_grain} in_yard=${byShape?.in_yard}`,
        );

        const grp = ((await shop.rpc('yard_empties_by_group', { p_store_id: storeId })).data ?? [])
          .find((g) => g.group_id === shape.group_id && g.store_unit_id === shape.store_unit_id);
        expectQty('and the maker carries the number instead', grp?.counted, 500);
      }
    },
  },

  {
    name: '32. A shortfall is explained in as many pieces as it took',
    async run(ctx) {
      const { storeId, product } = ctx;

      const periodId = (await shop.rpc('ensure_open_period', { p_product_id: product })).data;
      const shelf = await onHand(product);

      const { data: entered } = await shop.rpc('enter_stock_count', {
        p_period_id: periodId,
        p_counted: shelf - 15,
      });
      expectQty('the count is fifteen short', entered?.variance, -15);

      /*
       * TEN BROKE AND FIVE WALKED, and they must not be one figure.
       *
       * Damage is a cost of doing business; theft is a person. A resolution that blends them tells
       * an owner their breakage is fifteen when a third of it went out of the door — and the two
       * lead to completely different actions.
       */
      const { error } = await shop.rpc('resolve_variance', {
        p_period_id: periodId,
        p_parts: [
          { qty: 10, reason: 'unlogged_damage', note: 'a crate off the tailgate' },
          { qty: 5, reason: 'theft', note: 'unaccounted for over the weekend' },
        ],
      });
      check('a shortfall is explained cause by cause', !error, error?.message ?? '');

      const { data: parts } = await shop
        .from('variance_resolutions')
        .select('qty, reason, value_at_cost')
        .eq('stock_period_id', periodId);
      const dmg = (parts ?? []).find((p) => p.reason === 'unlogged_damage');
      const thf = (parts ?? []).find((p) => p.reason === 'theft');
      check(
        'and breakage is not asked to carry a theft',
        Number(dmg?.qty) === -10 && Number(thf?.qty) === -5,
        `damage ${dmg?.qty}, theft ${thf?.qty}`,
      );

      /*
       * AND EACH IS ITS OWN MOVEMENT. A blended `adjustment -15` is a figure no report can ever
       * separate again — and "how much do we lose to breakage" is the report an owner asks for.
       */
      const { data: moves } = await admin
        .from('stock_movements')
        .select('kind, qty_delta')
        .eq('product_id', product)
        .eq('ref_table', 'variance_resolutions');
      check(
        'damage is booked as damage',
        (moves ?? []).some((m) => m.kind === 'damage' && Number(m.qty_delta) === -10),
        (moves ?? []).map((m) => `${m.kind} ${m.qty_delta}`).join(', '),
      );

      const partial = await shop.rpc('ensure_open_period', { p_product_id: product });
      await shop.rpc('enter_stock_count', { p_period_id: partial.data, p_counted: shelf - 20 });
      const { error: half } = await shop.rpc('resolve_variance', {
        p_period_id: partial.data,
        p_parts: [{ qty: 2, reason: 'miscount' }],
      });
      check(
        'and a gap only partly explained is refused',
        !!half && /add up to/.test(half.message),
        half?.message?.slice(0, 60) ?? 'it was accepted',
      );

      // Left explained, so the shop is not carrying an open gap into the next scenario.
      await shop.rpc('resolve_variance', {
        p_period_id: partial.data,
        p_parts: [{ qty: 5, reason: 'miscount' }],
      });
    },
  },

  {
    name: '33. Stock carries a date, per delivery, at its own cost',
    async run(ctx) {
      const { storeId, product } = ctx;

      const day = (n) => {
        const d = new Date();
        d.setDate(d.getDate() + n);
        return d.toISOString().slice(0, 10);
      };

      /*
       * THE SAME ITEM, TWICE, at two costs and two dates.
       *
       * «we could have 10 items that came cheaper and expiring earlier and new one later and
       *  expensive so we need to have the line to handle that» — which is exactly why the date
       * sits on the delivery layer beside that layer's own cost, and never on the product.
       */
      const { error } = await shop.rpc('record_purchase', {
        p_store_id: storeId,
        p_lines: [
          { product_id: product, qty: 10, unit_cost: 400, base_factor: 1, expires_on: day(4) },
          { product_id: product, qty: 20, unit_cost: 650, base_factor: 1, expires_on: day(120) },
        ],
        p_supplier: 'Benchmark Dairy',
        p_client_uuid: crypto.randomUUID(),
      });
      check('a delivery carries a date per line', !error, error?.message ?? '');

      const { data: soon } = await shop.rpc('expiring_stock', {
        p_store_id: storeId,
        p_within_days: 30,
      });
      const mine = (soon ?? []).filter((r) => r.product_id === product);
      check(
        'only the lot that is actually going off is raised',
        mine.length === 1 && Number(mine[0].remaining) === 10,
        `${mine.length} lot(s) inside 30 days`,
      );
      expectMoney('valued at what THAT delivery cost', mine[0]?.value_at_cost, 4000);

      const { data: sum } = await shop.rpc('expiring_summary', {
        p_store_id: storeId,
        p_within_days: 30,
      });
      const row = Array.isArray(sum) ? sum[0] : sum;
      check('and the alarm can ask in one call', Number(row?.soon_items) >= 1,
        `${row?.soon_items} soon, next ${row?.next_date}`);

      const shelf = await onHand(product);
      await shop.rpc('write_off_expired', {
        p_layer_id: mine[0].layer_id,
        p_reason: 'benchmark: out of date',
      });
      expectQty('writing it off takes it off the shelf', await onHand(product), shelf - 10);

      const { data: after } = await shop.rpc('expiring_stock', {
        p_store_id: storeId,
        p_within_days: 30,
      });
      check(
        'and it stops being counted once it is gone',
        (after ?? []).filter((r) => r.product_id === product).length === 0,
      );
    },
  },

  {
    name: '34. A settled receipt is corrected, and a walk-in acquires a customer',
    async run(ctx) {
      const { storeId, customer, product } = ctx;

      const { data: units } = await shop.rpc('product_selling_units', { p_store_id: storeId });
      const shape = (units ?? []).find((u) => u.product_id === product && u.is_sold);
      if (!shape) {
        check('a sellable shape exists to correct a receipt for', false);
        return;
      }

      const shelf = await onHand(product);
      const owedBefore = Number(
        (await shop.rpc('customer_balance', { p_store_customer_id: customer })).data,
      ) || 0;
      // `sell` hands back { draftId, saleId } — the draft matters to the caller that cancels it.
      const { saleId } = await sell(storeId, {
        customerId: customer,
        lines: [
          {
            product_id: product,
            qty: 3,
            sale_unit_id: shape.product_unit_id,
            base_qty: 3 * Number(shape.base_qty || 1),
            unit_price: 5000,
            line_total: 15000,
          },
        ],
        payments: [{ method: 'cash', amount: 15000 }],
      });

      const { data: result, error } = await shop.rpc('amend_sale', {
        p_sale_id: saleId,
        p_reason: 'Keyed three, only two went',
        p_lines: [
          {
            product_id: product,
            sale_unit_id: shape.product_unit_id,
            entered_qty: 2,
            base_qty: 2 * Number(shape.base_qty || 1),
            unit_price: 5000,
            line_total: 10000,
          },
        ],
      });
      check('a settled receipt can be corrected', !error, error?.message ?? '');
      if (error) return;

      const r = Array.isArray(result) ? result[0] : result;
      expectMoney('the bill follows the correction', r?.total, 10000);
      expectQty(
        'and so does the shelf',
        await onHand(product),
        shelf - 2 * Number(shape.base_qty || 1),
      );

      /*
       * THE MONEY IS LEFT ALONE, and the ACCOUNT is where that shows.
       *
       * ₦15,000 was handed over and the drawer has it; the bill is now ₦10,000. So the customer's
       * balance ends ₦5,000 BETTER off than before the sale — they paid for three and took two.
       *
       * Asserted on the balance rather than on this receipt's own `owing`, because payments settle
       * a customer's OLDEST debt first: in a shop that has been trading all week the ₦15,000 may
       * legitimately have cleared three earlier receipts and left nothing allocated to this one.
       * The probe on a fresh customer checks the per-receipt figure; here the account is the honest
       * question.
       */
      const owedAfter = Number(
        (await shop.rpc('customer_balance', { p_store_customer_id: customer })).data,
      ) || 0;
      expectMoney(
        'the payment stays, so the correction leaves them better off by the difference',
        owedAfter - owedBefore,
        -5000,
      );

      const { data: hist } = await shop.rpc('sale_revision_history', { p_sale_id: saleId });
      check(
        'and what the printed copy said is kept in full',
        (hist ?? []).length === 1 && Number(hist[0]?.document?.total) === 15000,
        `revision ${hist?.[0]?.revision} said ₦${hist?.[0]?.document?.total}`,
      );

      // ── A walk-in corrected into an obligation ──────────────────────────────────
      const { saleId: walkId } = await sell(storeId, {
        lines: [
          {
            product_id: product,
            qty: 1,
            sale_unit_id: shape.product_unit_id,
            base_qty: Number(shape.base_qty || 1),
            unit_price: 5000,
            line_total: 5000,
          },
        ],
        payments: [{ method: 'cash', amount: 5000 }],
        label: 'Counter',
      });

      /*
       * «when recalling a walk-in sale that did not have anyone, because of outstanding in empties
       *  or money, it has to now be added with a customer»
       *
       * A walk-in is somebody taking their change and leaving. Correct it into something that
       * leaves money owing and there is nobody to chase, so the debt would sit unrecoverable for
       * ever. Refused — and the refusal says what to do about it.
       */
      const { error: orphan } = await shop.rpc('amend_sale', {
        p_sale_id: walkId,
        p_reason: 'They took a second one on the way out',
        p_lines: [
          {
            product_id: product,
            sale_unit_id: shape.product_unit_id,
            entered_qty: 2,
            base_qty: 2 * Number(shape.base_qty || 1),
            unit_price: 5000,
            line_total: 10000,
          },
        ],
      });
      check(
        'a walk-in cannot be corrected into owing money',
        !!orphan && /Add a customer/.test(orphan.message),
        orphan?.message?.slice(0, 70) ?? 'it was accepted',
      );

      const { data: bal } = await shop.rpc('customer_balance', { p_store_customer_id: customer });
      const before = Number(bal) || 0;

      const { error: fixed } = await shop.rpc('amend_sale', {
        p_sale_id: walkId,
        p_reason: 'They took a second one on the way out',
        p_customer_id: customer,
        p_lines: [
          {
            product_id: product,
            sale_unit_id: shape.product_unit_id,
            entered_qty: 2,
            base_qty: 2 * Number(shape.base_qty || 1),
            unit_price: 5000,
            line_total: 10000,
          },
        ],
      });
      check('naming a customer is the way through', !fixed, fixed?.message ?? '');

      /*
       * AND THE ₦5,000 ALREADY PAID FOLLOWS THE RECEIPT ONTO THE ACCOUNT.
       *
       * A walk-in's payment carries no customer. Leave it behind and the account is billed the
       * whole ₦10,000 while the ₦5,000 they handed over sits against nobody — so somebody who owes
       * five is chased for ten.
       */
      const { data: after } = await shop.rpc('customer_balance', { p_store_customer_id: customer });
      expectMoney('and only the difference lands on their account', Number(after) - before, 5000);
    },
  },
];
