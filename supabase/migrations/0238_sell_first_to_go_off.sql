-- 0238 - Stock goes out of the line that goes off first
--
-- "A product could have the same expiry on different lines, but the rule is: when stock has
-- changed, the line that goes off first is where the amount is removed from."
--
-- `consume_stock_layers` took stock from the lot that ARRIVED first. With dated lines on the shelf
-- that is the wrong one whenever a later delivery goes off sooner: the lines the edit form reads
-- back would say the soon-to-expire stock was still all there. It now takes from the lot that goes
-- off first, then the next, with undated stock last; among lots going off on the same day, the one
-- that came in first. Each sale is still costed at the lots it actually took from.

create or replace function public.consume_stock_layers(p_product_id uuid, p_qty_base qty)
returns money_amt
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_left  qty := p_qty_base;
  v_cost  money_amt := 0;
  v_take  qty;
  v_layer record;
  v_last  unit_cost;
begin
  if p_qty_base is null or p_qty_base <= 0 then
    return 0;
  end if;

  for v_layer in
    select id, remaining_base, unit_cost
      from public.stock_layers
     where product_id = p_product_id and remaining_base > 0
     -- First to go off first; undated last; the earlier arrival among equals.
     order by expires_on nulls last, received_at, id
  loop
    exit when v_left <= 0;

    v_take := least(v_left, v_layer.remaining_base);

    update public.stock_layers
       set remaining_base = remaining_base - v_take
     where id = v_layer.id;

    v_cost  := v_cost + (v_take * v_layer.unit_cost);
    v_left  := v_left - v_take;
    v_last  := v_layer.unit_cost;
  end loop;

  -- Sold more than the shop has a record of. Cost it at the best figure available and carry on.
  if v_left > 0 then
    v_cost := v_cost + (v_left * coalesce(
      v_last,
      (select avg_unit_cost from public.products where id = p_product_id),
      0
    ));
  end if;

  return v_cost;
end;
$function$;

notify pgrst, 'reload schema';
