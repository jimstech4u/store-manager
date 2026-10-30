/**
 * Scenarios: a count is the truth at its moment.
 *
 * «we re-edit a receipt, change quantity many times, and stock is wrong when we cross-check with the
 *  physical. Customer money is correct, just stock.»
 *
 * Each walks a real sale, a real count and a real correction through the RPCs the app calls. These
 * are separate transactions at separate moments, which a rehearsal in one transaction cannot be: its
 * now() never moves. What is asserted is the stock figure, the batches, the difference the count
 * shows, and that a receipt's own movements still equal its lines.
 */

import { admin, check, expectQty, onHand, sell, shop } from './harness.mjs';

async function setup(ctx) {
  const { storeId, product } = ctx;
  const { data: units } = await shop.rpc('product_selling_units', { p_store_id: storeId });
  const shape = (units ?? []).find((u) => u.product_id === product && u.is_sold);
  return { shape, size: Number(shape?.base_qty || 1) };
}

const lineOf = (product, shape, size, qty) => ({
  product_id: product,
  qty,
  sale_unit_id: shape.product_unit_id,
  base_qty: qty * size,
  unit_price: 5000,
  line_total: qty * 5000,
});

const corrected = (product, shape, size, qty) => ({
  product_id: product,
  sale_unit_id: shape.product_unit_id,
  entered_qty: qty,
  base_qty: qty * size,
  unit_price: 5000,
  line_total: qty * 5000,
});

async function countShelf(product, figure, reason) {
  const period = (await shop.rpc('ensure_open_period', { p_product_id: product })).data;
  const { data, error } = await shop.rpc('enter_stock_count', { p_period_id: period, p_counted: figure, p_reason: reason });
  if (error) throw new Error(`count: ${error.message}`);
  return { period, entered: data };
}

async function batches(product) {
  const { data } = await admin.from('stock_layers').select('remaining_base').eq('product_id', product);
  return (data ?? []).reduce((sum, l) => sum + Number(l.remaining_base), 0);
}

async function receiptMoved(saleId, product) {
  const { data } = await admin.from('stock_movements').select('qty_delta').eq('ref_table', 'sales').eq('ref_id', saleId).eq('product_id', product);
  return (data ?? []).reduce((sum, m) => sum + Number(m.qty_delta), 0);
}

async function correct(saleId, lines, goodsMoved, reason) {
  const { error } = await shop.rpc('correct_sale', {
    p_sale_id: saleId,
    p_reason: reason,
    p_lines: lines,
    p_goods_moved: goodsMoved,
  });
  if (error) throw new Error(`correction: ${error.message}`);
}

export const scenarios = [
  {
    name: '39. A receipt corrected after a count: only the paper was wrong',
    async run(ctx) {
      const { storeId, customer, product } = ctx;
      const { shape, size } = await setup(ctx);
      if (!shape) return check('a sellable shape exists', false);

      const { saleId } = await sell(storeId, { customerId: customer, lines: [lineOf(product, shape, size, 3)] });
      await countShelf(product, await onHand(product), 'counted after the sale');

      const { data: touched } = await shop.rpc('correction_touches_a_count', {
        p_sale_id: saleId,
        p_lines: [{ product_id: product, base_qty: 2 * size }],
      });
      check('the correction knows a count was taken since the sale', (touched ?? []).length === 1, JSON.stringify(touched));
      expectQty('and says what it would do to the stock', touched?.[0]?.stock_change, size);

      const shelf = await onHand(product);
      const held = await batches(product);
      await correct(saleId, [corrected(product, shape, size, 2)], false, 'Keyed three, only two went');

      expectQty('the stock figure stays what the count said', await onHand(product), shelf);
      expectQty('so do the batches', await batches(product), held);
      expectQty('and the receipt still equals its lines', await receiptMoved(saleId, product), -2 * size);

      // The bug as reported: the same receipt, edited again and again.
      await correct(saleId, [corrected(product, shape, size, 1)], false, 'Only one went');
      await correct(saleId, [corrected(product, shape, size, 2)], false, 'Two after all');
      expectQty('corrected three times, the shelf has not moved', await onHand(product), shelf);
      expectQty('and the receipt still equals its lines', await receiptMoved(saleId, product), -2 * size);
    },
  },
  {
    name: '40. A receipt corrected after a count: the goods really moved',
    async run(ctx) {
      const { storeId, customer, product } = ctx;
      const { shape, size } = await setup(ctx);
      if (!shape) return check('a sellable shape exists', false);

      const { saleId } = await sell(storeId, { customerId: customer, lines: [lineOf(product, shape, size, 3)] });
      await countShelf(product, await onHand(product), 'counted after the sale');
      const shelf = await onHand(product);
      const held = await batches(product);

      await correct(saleId, [corrected(product, shape, size, 2)], true, 'They brought a crate back today');

      expectQty('the crate is back on the shelf', await onHand(product), shelf + size);
      expectQty('and in the batches', await batches(product), held + size);
    },
  },
  {
    name: '41. A correction explains a difference the count left open',
    async run(ctx) {
      const { storeId, customer, product } = ctx;
      const { shape, size } = await setup(ctx);
      if (!shape) return check('a sellable shape exists', false);

      const { saleId } = await sell(storeId, { customerId: customer, lines: [lineOf(product, shape, size, 3)] });
      // The crate never left, so the shelf has one more than the records.
      const { period, entered } = await countShelf(product, (await onHand(product)) + size, 'one crate over');
      expectQty('the count finds the crate', entered?.variance, size);

      const shelf = await onHand(product);
      const held = await batches(product);
      await correct(saleId, [corrected(product, shape, size, 2)], false, 'That crate never left');

      expectQty('the stock figure rises to what was counted', await onHand(product), shelf + size);
      expectQty('the batches with it', await batches(product), held + size);
      const { data: after } = await admin.from('stock_periods').select('variance_qty, expected_at_count, actual_closing_qty').eq('id', period).maybeSingle();
      expectQty('and the difference is gone', after?.variance_qty, 0);

      // The next day opens from the count: the crate must not arrive a second time.
      const { error } = await shop.rpc('close_stock_period', { p_period_id: period });
      check('the day closes', !error, error?.message ?? '');
      const open = (await shop.rpc('ensure_open_period', { p_product_id: product })).data;
      const { data: next } = await admin.from('stock_periods').select('expected_closing_qty').eq('id', open).maybeSingle();
      expectQty('and the next day agrees with the stock figure', next?.expected_closing_qty, await onHand(product));
    },
  },
  {
    name: '42. A small difference reaches the stock figure when the day closes',
    async run(ctx) {
      const { product } = ctx;
      // Tolerance is a shop setting with its own screen; here it only has to be wide enough.
      await admin.from('products').update({ variance_tolerance_qty: 5 }).eq('id', product);

      const { period, entered } = await countShelf(product, (await onHand(product)) - 2, 'two short');
      check('two short is within tolerance', entered?.within_tolerance === true && entered?.needs_resolution === false, JSON.stringify(entered));
      const shelf = await onHand(product);
      const held = await batches(product);

      const { error } = await shop.rpc('close_stock_period', { p_period_id: period });
      check('the day closes without anybody explaining it', !error, error?.message ?? '');

      expectQty('the stock figure follows the shelf', await onHand(product), shelf - 2);
      expectQty('the batches with it', await batches(product), held - 2);
      const open = (await shop.rpc('ensure_open_period', { p_product_id: product })).data;
      const { data: next } = await admin.from('stock_periods').select('expected_closing_qty').eq('id', open).maybeSingle();
      expectQty('and the count screen says the same figure', next?.expected_closing_qty, await onHand(product));

      await admin.from('products').update({ variance_tolerance_qty: 0 }).eq('id', product);
    },
  },
  {
    name: '43. Cancelling a receipt after a count asks the same thing',
    async run(ctx) {
      const { storeId, customer, product } = ctx;
      const { shape, size } = await setup(ctx);
      if (!shape) return check('a sellable shape exists', false);

      const paper = await sell(storeId, { customerId: customer, lines: [lineOf(product, shape, size, 1)] });
      await countShelf(product, await onHand(product), 'counted after the sale');
      let shelf = await onHand(product);
      const { error: e1 } = await shop.rpc('void_sale', { p_sale_id: paper.saleId, p_reason: 'Entered by mistake', p_goods_moved: false });
      check('a mistaken receipt is cancelled', !e1, e1?.message ?? '');
      expectQty('and the shelf stays as counted', await onHand(product), shelf);

      const back = await sell(storeId, { customerId: customer, lines: [lineOf(product, shape, size, 1)] });
      await countShelf(product, await onHand(product), 'counted after the sale');
      shelf = await onHand(product);
      const held = await batches(product);
      const { error: e2 } = await shop.rpc('void_sale', { p_sale_id: back.saleId, p_reason: 'They brought it back', p_goods_moved: true });
      check('a returned sale is cancelled', !e2, e2?.message ?? '');
      expectQty('and the goods are back', await onHand(product), shelf + size);
      expectQty('in the batches too', await batches(product), held + size);

      const { error: e3 } = await shop.rpc('reopen_sale', { p_sale_id: back.saleId, p_reason: 'They took it after all' });
      check('and reopened', !e3, e3?.message ?? '');
      expectQty('the batches give it up again', await batches(product), held);
    },
  },
];
