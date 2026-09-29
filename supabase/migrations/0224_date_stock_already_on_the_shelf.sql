-- 0224 - Date stock that is already on the shelf
--
-- "we could not even edit the expiry date ... the only thing stopped from editing is initial stock
-- and empties when history exists."
--
-- A date lives on a stock LOT (`stock_layers`). Lots are made by a delivery, or by the opening
-- count when it was given dates. An item counted without dates — Malta Guinness, and 13 others in
-- the first shop — holds its shelf with no lot at all, so there was nothing to put a date on, and
-- the edit form (rightly) hid the "add a date" composer once the item had a history, because that
-- composer belonged to the opening count.
--
-- `date_shelf_stock` dates part of what is ALREADY there. It never moves stock — the count and the
-- ledger are untouched — it only says which of it goes off when:
--
--   · from an UNDATED LOT first: the lot is split, the dated part keeping its cost and its place in
--     the selling order;
--   · then from stock that has NO LOT: a lot is made for it, at the item's average cost, placed
--     AHEAD of every existing lot in the selling order. Stock with no lot is the oldest on the
--     shelf — it was there before any delivery that made a lot — so it is what sells first.
--
-- Refused when the dates cover more than is on the shelf and undated, and without a reason, which
-- goes to the audit log beside what was dated.

create or replace function public.date_shelf_stock(
  p_product_id uuid,
  p_batches    jsonb,
  p_reason     text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store     uuid;
  v_name      text;
  v_on_hand   numeric;
  v_layered   numeric;
  v_undated   numeric;
  v_free      numeric;
  v_want      numeric := 0;
  v_batch     jsonb;
  v_qty       numeric;
  v_left      numeric;
  v_take      numeric;
  v_expires   date;
  v_layer     record;
  v_cost      numeric;
  v_first     timestamptz;
  v_n         int := 0;
begin
  select store_id, name into v_store, v_name from public.products where id = p_product_id for update;
  if v_store is null then
    raise exception 'That item no longer exists.' using errcode = 'no_data_found';
  end if;
  if not public.has_permission(v_store, 'stock.adjust') then
    raise exception 'You do not have permission to date stock.' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Say why this stock is being dated.' using errcode = '22023';
  end if;
  if p_batches is null or jsonb_array_length(p_batches) = 0 then
    return;
  end if;

  for v_batch in select * from jsonb_array_elements(p_batches)
  loop
    v_qty := coalesce((v_batch ->> 'qty')::numeric, 0);
    if v_qty <= 0 then
      raise exception 'Every dated lot needs a quantity.' using errcode = '22023';
    end if;
    if nullif(v_batch ->> 'expires_on', '') is null then
      raise exception 'Every dated lot needs its date.' using errcode = '22023';
    end if;
    v_want := v_want + v_qty;
  end loop;

  select coalesce(sum(qty_delta), 0) into v_on_hand from public.stock_movements where product_id = p_product_id;
  select coalesce(sum(remaining_base), 0),
         coalesce(sum(remaining_base) filter (where expires_on is null), 0)
    into v_layered, v_undated
    from public.stock_layers where product_id = p_product_id and remaining_base > 0;
  v_free := greatest(v_on_hand - v_layered, 0);

  if v_want > v_undated + v_free then
    raise exception '% has % on the shelf without a date; these dates cover %.',
      v_name, (v_undated + v_free), v_want
      using errcode = '22023';
  end if;

  select coalesce(avg_unit_cost, 0) into v_cost from public.products where id = p_product_id;
  select least(coalesce(min(received_at), now()), now()) into v_first
    from public.stock_layers where product_id = p_product_id;

  for v_batch in
    select * from jsonb_array_elements(p_batches)
     order by (value ->> 'expires_on')::date
  loop
    v_left := (v_batch ->> 'qty')::numeric;
    v_expires := (v_batch ->> 'expires_on')::date;

    -- An undated lot first, oldest first: split off the dated part, keeping cost and place.
    for v_layer in
      select id, remaining_base, unit_cost, received_at, ref_table, ref_id
        from public.stock_layers
       where product_id = p_product_id and remaining_base > 0 and expires_on is null
       order by received_at, id
       for update
    loop
      exit when v_left <= 0;
      v_take := least(v_left, v_layer.remaining_base);
      if v_take = v_layer.remaining_base then
        update public.stock_layers set expires_on = v_expires where id = v_layer.id;
      else
        update public.stock_layers
           set remaining_base = remaining_base - v_take,
               qty_base = greatest(qty_base - v_take, remaining_base - v_take)
         where id = v_layer.id;
        insert into public.stock_layers (store_id, product_id, qty_base, remaining_base, unit_cost,
                                         ref_table, ref_id, received_at, expires_on)
        values (v_store, p_product_id, v_take, v_take, v_layer.unit_cost,
                v_layer.ref_table, v_layer.ref_id, v_layer.received_at, v_expires);
      end if;
      v_left := v_left - v_take;
    end loop;

    -- Then stock with no lot: the oldest on the shelf, so it sells ahead of every lot.
    if v_left > 0 then
      v_n := v_n + 1;
      insert into public.stock_layers (store_id, product_id, qty_base, remaining_base, unit_cost,
                                       ref_table, ref_id, received_at, expires_on)
      values (v_store, p_product_id, v_left, v_left, v_cost,
              'products', p_product_id, v_first - make_interval(secs => 1000 - v_n), v_expires);
    end if;
  end loop;

  insert into public.audit_log (store_id, table_name, record_id, op, prior_value, new_value, reason)
  values (v_store, 'stock_layers', p_product_id, 'insert',
          jsonb_build_object('undated_before', v_undated + v_free),
          jsonb_build_object('dated', p_batches),
          trim(p_reason));
end;
$fn$;

grant execute on function public.date_shelf_stock(uuid, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
