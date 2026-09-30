-- 0237 - An item's shelf dates are set as lines, before AND after stock history
--
-- "I thought editing American Cola's expiry would be like the multi-line edit we have on 33 Bottle,
-- which has no history." Before history the edit form's dated lines are the opening's own and are
-- set with the opening (0231). After history the shelf figure is locked — but its DATES are not
-- stock, and the shop wants the same lines: how many, in what shape, going off when.
--
-- `set_shelf_dates` makes what is on the shelf carry exactly the lines given. It takes the dates off
-- every lot still on the shelf and dates them again from the lines, through `date_shelf_stock`
-- (0224), which splits lots and keeps each part's cost. It moves no stock: the lines may cover the
-- shelf or part of it, never more — anything not covered is undated. The old and new dates go to the
-- audit trail.

create or replace function public.set_shelf_dates(p_product_id uuid, p_batches jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store uuid;
  v_before jsonb;
begin
  select store_id into v_store from public.products where id = p_product_id for update;
  if v_store is null then
    raise exception 'That item no longer exists.' using errcode = 'no_data_found';
  end if;
  if not public.has_permission(v_store, 'stock.adjust') then
    raise exception 'You do not have permission to date stock.' using errcode = 'insufficient_privilege';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('qty', remaining_base, 'expires_on', expires_on)
                            order by expires_on nulls last), '[]'::jsonb)
    into v_before
    from public.stock_layers
   where product_id = p_product_id and remaining_base > 0 and expires_on is not null;

  -- Undated, all of it; then dated again from the lines. The shelf itself does not move.
  update public.stock_layers
     set expires_on = null
   where product_id = p_product_id and remaining_base > 0 and expires_on is not null;

  if p_batches is not null and jsonb_array_length(p_batches) > 0 then
    perform public.date_shelf_stock(p_product_id, p_batches, 'Dates set on the item');
  end if;

  insert into public.audit_log (store_id, table_name, record_id, op, prior_value, new_value, reason)
  values (v_store, 'stock_layers', p_product_id, 'update',
          jsonb_build_object('dated', v_before),
          jsonb_build_object('dated', coalesce(p_batches, '[]'::jsonb)),
          'Dates set on the item');
end;
$fn$;

revoke all on function public.set_shelf_dates(uuid, jsonb) from public;
grant execute on function public.set_shelf_dates(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
