-- =====================================================================================
-- 0007 — record_purchase: unit cost is per ENTERED unit, matching the sale path
--
-- As first written, record_purchase read `unit_cost` as cost per BASE unit while `qty` was in
-- entered units. So "100 packs at ₦3,200" had to be entered as 100 and 266.666667 — the caller
-- doing the pack division by hand, in the one place where getting it wrong silently corrupts
-- every margin the product reports.
--
-- record_sale already treats `unit_price` as per entered unit. Two adjacent functions
-- disagreeing about what a price means is exactly the kind of asymmetry that produces a bug
-- nobody can see in a code review.
-- =====================================================================================

create or replace function public.record_purchase(
  p_store_id     uuid,
  p_lines        jsonb,
  p_supplier     text default null,
  p_invoice_ref  text default null,
  p_distribution money_amt default 0,
  p_delivery     money_amt default 0,
  p_occurred_at  timestamptz default now(),
  p_client_uuid  uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_purchase_id uuid;
  v_line        jsonb;
  v_product_id  uuid;
  v_entered     qty;
  v_pack_id     uuid;
  v_base_qty    qty;
  v_cost_entered money_amt;     -- what the buyer said: ₦3,200 per crate
  v_raw_base    unit_cost;      -- the same cost expressed per base unit
  v_goods_total money_amt := 0;
  v_line_value  money_amt;
  v_landed      unit_cost;
  v_period      uuid;
begin
  if not public.has_permission(p_store_id, 'stock.receive') then
    raise exception 'you do not have permission to receive stock' using errcode = '42501';
  end if;

  if p_client_uuid is not null then
    select id into v_purchase_id from public.purchases where client_uuid = p_client_uuid;
    if v_purchase_id is not null then
      return v_purchase_id;
    end if;
  end if;

  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'a purchase needs at least one line' using errcode = '22023';
  end if;

  -- Pass 1: goods value, so fees can be shared by VALUE. A delivery carrying ₦300,000 of drinks
  -- and ₦20,000 of biscuits did not incur half its cost for the biscuits.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product_id   := (v_line ->> 'product_id')::uuid;
    v_entered      := (v_line ->> 'qty')::qty;
    v_cost_entered := (v_line ->> 'unit_cost')::money_amt;
    v_goods_total  := v_goods_total + (v_entered * v_cost_entered);
  end loop;

  insert into public.purchases (store_id, supplier_name, invoice_ref, distribution_fee,
                                delivery_fee, occurred_at, client_uuid)
  values (p_store_id, p_supplier, p_invoice_ref, coalesce(p_distribution, 0),
          coalesce(p_delivery, 0), p_occurred_at, p_client_uuid)
  returning id into v_purchase_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product_id   := (v_line ->> 'product_id')::uuid;
    v_entered      := (v_line ->> 'qty')::qty;
    v_pack_id      := nullif(v_line ->> 'pack_id', '')::uuid;
    v_cost_entered := (v_line ->> 'unit_cost')::money_amt;
    v_base_qty     := public.to_base_qty(v_product_id, v_entered, v_pack_id);

    if v_base_qty <= 0 then
      raise exception 'quantity must be greater than zero' using errcode = '22023';
    end if;

    v_line_value := v_entered * v_cost_entered;
    v_raw_base   := v_line_value / v_base_qty;

    v_landed := case
      when v_goods_total > 0
        then v_raw_base + ((coalesce(p_distribution,0) + coalesce(p_delivery,0))
                           * (v_line_value / v_goods_total)) / v_base_qty
      else v_raw_base
    end;

    insert into public.purchase_lines (purchase_id, product_id, entered_qty, entered_pack_id,
                                       base_qty, unit_cost_raw, unit_cost_landed)
    values (v_purchase_id, v_product_id, v_entered, v_pack_id, v_base_qty, v_raw_base, v_landed);

    perform public.apply_weighted_average(v_product_id, v_base_qty, v_landed);

    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at)
    values (p_store_id, v_product_id, 'receive', v_base_qty, v_landed,
            'purchases', v_purchase_id, p_occurred_at);

    v_period := public.ensure_open_period(v_product_id);
    perform public.refresh_period(v_period);
  end loop;

  return v_purchase_id;
end;
$$;

grant execute on function public.record_purchase(uuid, jsonb, text, text, money_amt, money_amt, timestamptz, uuid) to authenticated;
