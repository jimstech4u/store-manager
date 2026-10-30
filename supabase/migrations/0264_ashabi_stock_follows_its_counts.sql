-- 0264 - Ashabi: the stock figure follows its counts, and the batches follow the stock
--
-- With the owner's yes (30 Oct). What 0263 stops from now on, put right once for this shop.
--
-- Three items closed a count with a small difference that never reached the ledger, so the stock
-- figure has stood above the shelf since. Each gets one adjustment, dated just before the day it
-- has been running in, so the count chain is untouched and the two agree.
--
-- 33 Bottle is NOT here: its 12 is not a small difference and the owner is recounting it.
--
-- Corrections, cancellations and settled counts never reached the batches, so every item's batches
-- are brought to its stock figure: added at the item's own cost, or taken as a sale takes them,
-- soonest to expire first. `stock_layers` is the working copy; the ledger is not touched for this.

do $$
declare
  v_store constant uuid := '7138327c-c81c-4486-a97c-92207b48b64e';
  v_item record;
  v_gap numeric;
  v_open record;
  v_held numeric;
  v_on numeric;
  v_cost numeric;
begin
  for v_item in
    select p.id, p.name, p.avg_unit_cost
      from public.products p
     where p.store_id = v_store
       and p.name in ('Trophy Bottle (600mL)', 'Castle Lite Bottle (600mL)',
                      'Pepsi | 7up | Mirinda | Teem | Komando Bottle (50cl)')
  loop
    select * into v_open from public.stock_periods where product_id = v_item.id and status = 'open';
    select sum(qty_delta) - v_open.expected_closing_qty into v_gap
      from public.stock_movements where product_id = v_item.id;
    if v_gap not in (6, 10, 1) then
      raise exception '% stands % from its counts, not the figure agreed', v_item.name, v_gap;
    end if;
    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost, ref_table, ref_id, note, occurred_at)
    values (v_store, v_item.id, 'adjustment', -v_gap, coalesce(v_item.avg_unit_cost, 0), 'stock_periods', v_open.id,
            'Small count difference that never reached the stock figure', v_open.period_start - interval '1 millisecond');
  end loop;

  for v_item in
    select p.id, p.avg_unit_cost, coalesce(sum(m.qty_delta), 0) as ledger
      from public.products p
      left join public.stock_movements m on m.product_id = p.id
     where p.store_id = v_store
     group by p.id, p.avg_unit_cost
  loop
    select coalesce(sum(remaining_base), 0) into v_held from public.stock_layers where product_id = v_item.id;
    perform public.stock_into_layers(v_store, v_item.id, greatest(v_item.ledger, 0) - v_held, v_item.avg_unit_cost);
  end loop;
end;
$$;
