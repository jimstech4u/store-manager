-- 0199 — Correct an imported opening count without rewriting history.
--
-- This deliberately narrow writer is for a discovered import mistake. It appends only the missing
-- stock and then records the corrected physical count through the normal count trail.

create or replace function public.correct_opening_inventory(
  p_store_id uuid,
  p_product_id uuid,
  p_additional_qty qty,
  p_corrected_count qty,
  p_reason text,
  p_batches jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store uuid;
  v_movement uuid;
  v_period uuid;
  v_batch jsonb;
  v_sum numeric := 0;
  v_qty numeric;
  v_expires date;
begin
  if not public.has_permission(p_store_id, 'counts.correct') then
    raise exception 'You do not have permission to correct opening inventory.' using errcode = '42501';
  end if;
  select store_id into v_store from public.products where id = p_product_id;
  if v_store is null or v_store <> p_store_id then
    raise exception 'That item does not belong to this shop.' using errcode = '22023';
  end if;
  if p_additional_qty is null or p_additional_qty < 0 or p_corrected_count is null or p_corrected_count < 0 then
    raise exception 'A correction needs non-negative quantities.' using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Say why this opening inventory is being corrected.' using errcode = '22023';
  end if;

  for v_batch in select * from jsonb_array_elements(coalesce(p_batches, '[]'::jsonb)) loop
    v_qty := coalesce((v_batch ->> 'qty')::numeric, 0);
    if v_qty <= 0 then
      raise exception 'Every dated batch needs a quantity.' using errcode = '22023';
    end if;
    v_sum := v_sum + v_qty;
  end loop;
  if v_sum <> 0 and v_sum <> p_additional_qty then
    raise exception 'The dated batches come to % but the correction adds %. They must agree.', v_sum, p_additional_qty
      using errcode = '22023';
  end if;

  if p_additional_qty > 0 then
    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost, ref_table, ref_id, occurred_at, note)
    values (p_store_id, p_product_id, 'opening', p_additional_qty, 0, 'products', p_product_id, now(), trim(p_reason))
    returning id into v_movement;

    for v_batch in select * from jsonb_array_elements(coalesce(p_batches, '[]'::jsonb)) loop
      v_qty := (v_batch ->> 'qty')::numeric;
      v_expires := nullif(v_batch ->> 'expires_on', '')::date;
      insert into public.stock_layers (store_id, product_id, qty_base, remaining_base, unit_cost, ref_table, ref_id, received_at, expires_on)
      values (p_store_id, p_product_id, v_qty, v_qty, 0, 'products', p_product_id, now(), v_expires);
    end loop;
  end if;

  v_period := public.ensure_open_period(p_product_id);
  perform public.enter_stock_count(v_period, p_corrected_count, trim(p_reason));
  return v_movement;
end;
$fn$;

revoke all on function public.correct_opening_inventory(uuid, uuid, qty, qty, text, jsonb) from public;
grant execute on function public.correct_opening_inventory(uuid, uuid, qty, qty, text, jsonb) to authenticated;
