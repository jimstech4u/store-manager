-- 0143 — Older receipts owe their containers
--
-- «i hope we have backfilled receipts that did not have the empties showing»
--
-- Measured before writing anything, in the one live shop (ASHABI GLOBAL RESOURCES), across posted
-- customer sales with lines sold in a shape that comes back:
--
--   20 sales  already have their own container rows (written since 0117). Nothing to do.
--
--   62 sales  their containers ARE in the ledger — carried over from the old deposit ledger in 0110,
--             under `ref_table = 'deposit_ledger'`. The receipts printed nothing only because the
--             readers looked for `sale_lines`. Fixed in the readers (0140/0141), no rows written:
--             adding rows here would have DOUBLED what those customers owe.
--
--    2 sales  4 containers with no record anywhere. Sold before 0117 taught a sale to write its own
--             containers, and not covered by the carry-over. Those customers' empties balances were
--             short by exactly this. That is what this migration writes.
--
-- A first count said 72 sales and 178 containers. Seventy of them belonged to benchmark shops that
-- had been dropped: the harness deletes a shop with `session_replication_role = replica`, which also
-- stands down the cascading foreign keys, so their sales stayed behind with a store id that no
-- longer exists. The insert failed on exactly that, which is how it was noticed. Only rows whose
-- shop still exists are written.
--
-- The rows are what the sale would have written had the trigger existed: `out`, `they_hold`, in the
-- shape sold, against the sale line, dated to the SALE rather than today so a statement puts them in
-- the right month — and with a reason saying they were backfilled, so nobody mistakes them for
-- something a seller did this week.
--
-- Walk-in sales with returnables — which could not be backfilled, having nobody to owe them to — turned
-- out to be none in any shop that still exists. A first count found 160 such lines, all of them in the
-- same dropped benchmark shops.

insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                     direction, qty, reason, ref_table, ref_id, occurred_at, side)
select s.store_id,
       s.store_customer_id,
       sl.product_id,
       sl.sale_unit_id,
       'out',
       sl.entered_qty,
       'Backfilled: sold before sales recorded their containers',
       'sale_lines',
       sl.id,
       s.occurred_at,
       'they_hold'
  from public.sale_lines sl
  join public.sales s
    on s.id = sl.sale_id
   and s.status = 'posted'
   and s.store_customer_id is not null
  -- Only shops that still exist; dropped benchmark shops left orphaned sales behind.
  join public.stores st on st.id = s.store_id
  join public.store_customers sc on sc.id = s.store_customer_id
  join public.product_units pu
    on pu.id = sl.sale_unit_id
   and pu.is_returnable
 where sl.entered_qty > 0
   -- not already written by the sale itself
   and not exists (
     select 1 from public.customer_empties ce
      where ce.ref_table = 'sale_lines' and ce.ref_id = sl.id
   )
   -- and not already carried over from the old deposit ledger for the same sale
   and not exists (
     select 1
       from public.customer_empties ce
       join public.deposit_ledger dl on dl.id = ce.ref_id
      where ce.ref_table = 'deposit_ledger'
        and dl.ref_table = 'sales'
        and dl.ref_id = s.id
   );

-- Running it twice must write nothing the second time: both guards above hold after the first run.
do $check$
declare n int;
begin
  select count(*) into n
    from public.sale_lines sl
    join public.sales s on s.id = sl.sale_id and s.status = 'posted' and s.store_customer_id is not null
    join public.stores st on st.id = s.store_id
    join public.store_customers sc on sc.id = s.store_customer_id
    join public.product_units pu on pu.id = sl.sale_unit_id and pu.is_returnable
   where sl.entered_qty > 0
     and not exists (select 1 from public.customer_empties ce
                      where ce.ref_table = 'sale_lines' and ce.ref_id = sl.id)
     and not exists (select 1 from public.customer_empties ce
                       join public.deposit_ledger dl on dl.id = ce.ref_id
                      where ce.ref_table = 'deposit_ledger' and dl.ref_table = 'sales'
                        and dl.ref_id = s.id);
  if n <> 0 then
    raise exception '% returnable sale lines still have no container record', n;
  end if;
end;
$check$;
