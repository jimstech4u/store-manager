-- 0234 - Kadijat's Goldberg sale on 28 Sep is a plain sale, not a corrected one
--
-- "Kadijat was not to be a correction but a real sale ... you made it like a correction, so fix
-- that, because it was a real sale."
--
-- The sale (1 crate of Goldberg Bottle, N9,000, paid by transfer, 28 Sep 12:26) was rung up with no
-- customer, and 22 seconds later "corrected" with the reason "Teg" — the only change being that
-- Kadijat was attached. The correction reversed the sale (+12 bottles) and sold it again (-12), so
-- the shelf was always right; but the sale read as a corrected receipt, and the item's history
-- carried the pair. The sale is put back to what it is: revision 1, sold to Kadijat, no correction.
-- The pair of ledger lines (+12 and -12, netting to nothing) is removed — at the shop's explicit
-- instruction — and Goldberg's running balances are recomputed.

do $kadijat$
declare
  v_sale    constant uuid := '5464429a-0da7-4f25-bf9e-bfed614eb65a';
  v_product uuid;
  v_lines   int;
  v_net     numeric;
begin
  select count(*), coalesce(sum(qty_delta), 0), min(product_id::text)::uuid
    into v_lines, v_net, v_product
    from public.stock_movements
   where ref_id = v_sale and note = 'receipt corrected: Teg';
  if v_lines <> 2 or v_net <> 0 then
    raise exception 'The "Teg" correction is not as found (% lines, net %); not touching it', v_lines, v_net;
  end if;

  alter table public.stock_movements disable trigger no_mutation;
  delete from public.stock_movements where ref_id = v_sale and note = 'receipt corrected: Teg';

  update public.stock_movements m
     set balance_before = r.running - m.qty_delta,
         balance_after  = r.running
    from (select id, sum(qty_delta) over (order by occurred_at, created_at, id) as running
            from public.stock_movements where product_id = v_product) r
   where m.id = r.id;
  alter table public.stock_movements enable trigger no_mutation;

  -- Its one revision record goes the same way, under the same instruction.
  alter table public.sale_revisions disable trigger no_mutation;
  delete from public.sale_revisions where sale_id = v_sale;
  alter table public.sale_revisions enable trigger no_mutation;
  update public.sales set revision = 1, amend_reason = null where id = v_sale;

  insert into public.audit_log (store_id, table_name, record_id, op, prior_value, new_value, reason)
  select store_id, 'sales', v_sale, 'update',
         jsonb_build_object('revision', 2, 'amend_reason', 'Teg'),
         jsonb_build_object('revision', 1, 'amend_reason', null),
         'A real sale to Kadijat, not a correction: the correction only attached the customer'
    from public.sales where id = v_sale;
end;
$kadijat$;
