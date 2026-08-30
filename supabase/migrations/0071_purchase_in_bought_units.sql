-- ════════════════════════════════════════════════════════════════════════════════════════════
-- A delivery arrives in whatever unit the shop buys in
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- `record_purchase` works out how much stock arrived by looking the line's `pack_id` up in
-- `product_packs` — the one-pack-per-product model that 0061 replaced. A shop that now says it
-- buys cooking oil in bags AND in kilogrammes has two bought-in units and no pack for either, so a
-- delivery in bags could only be entered as loose litres.
--
-- ONE EXPRESSION CHANGES. The line may carry `base_factor` — how many base units one of whatever
-- it arrived in is — and that is preferred when present. Everything else is byte-for-byte the
-- definition from 0062, including the `pack_id` path, so every existing caller and every delivery
-- already recorded is untouched.
--
-- COPIED VERBATIM AND EDITED IN ONE PLACE, deliberately. 0058 rewrote a function of this shape
-- "more tidily", changed the parameter order, created a second overload, and PostgREST answered
-- 300 to every call — the till stopped saving. 0059 then restored it from memory and lost the
-- idempotency lookup. 0060 fixed it by copying the previous definition exactly and changing the
-- single line that needed changing, which is what this does.

create or replace function public.record_purchase(
  p_store_id     uuid,
  p_lines        jsonb,
  p_supplier     text default null,
  p_invoice_ref  text default null,
  p_distribution money_amt default 0,
  p_delivery     money_amt default 0,
  p_occurred_at  timestamptz default now(),
  p_client_uuid  uuid default null,
  /** Named fees, the way the sell screen takes named charges: [{label, amount, note}]. */
  p_charges      jsonb default '[]'::jsonb,
  /** Money handed back by the supplier against this delivery. */
  p_rebate       money_amt default 0
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
  v_free        qty;
  v_pack_id     uuid;
  v_base_qty    qty;
  v_free_base   qty;
  v_cost_entered money_amt;
  v_line_value  money_amt;
  v_goods_total money_amt := 0;
  v_extra       money_amt;
  v_landed      unit_cost;
  v_period      uuid;
  v_charge      jsonb;
  v_pos         int := 0;
  v_pack_base   qty;
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

  -- `distribution_fee` and `delivery_fee`: the names the table actually uses.
  insert into public.purchases (store_id, supplier_name, invoice_ref, distribution_fee,
                                delivery_fee, rebate_amount, occurred_at, client_uuid, created_by)
  values (p_store_id, nullif(trim(p_supplier), ''), nullif(trim(p_invoice_ref), ''),
          coalesce(p_distribution, 0), coalesce(p_delivery, 0), coalesce(p_rebate, 0),
          p_occurred_at, p_client_uuid, auth.uid())
  returning id into v_purchase_id;

  for v_charge in select * from jsonb_array_elements(coalesce(p_charges, '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    if coalesce((v_charge ->> 'amount')::money_amt, 0) > 0 then
      insert into public.purchase_charges (purchase_id, label, amount, note, sort_order)
      values (v_purchase_id,
              coalesce(nullif(trim(v_charge ->> 'label'), ''), 'Charge'),
              (v_charge ->> 'amount')::money_amt,
              nullif(trim(v_charge ->> 'note'), ''),
              v_pos);
    end if;
  end loop;

  /*
   * EVERYTHING THAT IS NOT THE GOODS, in one figure.
   *
   * The two fixed fields stay for what already used them; the named charges add to them rather
   * than replacing them, so a delivery recorded before this change still reads correctly.
   */
  v_extra := coalesce(p_distribution, 0) + coalesce(p_delivery, 0)
           + coalesce((select sum(amount) from public.purchase_charges
                        where purchase_id = v_purchase_id), 0)
           - coalesce(p_rebate, 0);

  -- What the goods themselves came to, needed before any line can take its share of the extras.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_goods_total := v_goods_total + ((v_line ->> 'qty')::qty * (v_line ->> 'unit_cost')::money_amt);
  end loop;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product_id   := (v_line ->> 'product_id')::uuid;
    v_entered      := (v_line ->> 'qty')::qty;
    v_free         := coalesce((v_line ->> 'free_qty')::qty, 0);
    v_pack_id      := nullif(v_line ->> 'pack_id', '')::uuid;
    v_cost_entered := (v_line ->> 'unit_cost')::money_amt;

    /*
     * How many base units one of whatever arrived is.
     *
     * `base_factor` when the form knows — it is reading the shop's own bought-in units now, which
     * a pack row may not exist for at all. The pack lookup stays underneath it for callers that
     * still send a `pack_id`, and 1 when neither says anything, which is a delivery in base units.
     */
    v_pack_base := (v_line ->> 'base_factor')::qty;

    if v_pack_base is null then
      select coalesce(pk.base_unit_qty, 1) into v_pack_base
        from public.product_packs pk where pk.id = v_pack_id;
    end if;

    v_pack_base := coalesce(v_pack_base, 1);

    v_line_value := v_entered * v_cost_entered;
    v_base_qty   := v_entered * v_pack_base;
    -- Free units are stock that arrived and cost nothing extra, so they go into the divisor.
    v_free_base  := v_free * v_pack_base;

    /*
     * The landed cost: this line's goods, plus its share of everything else, over everything that
     * actually arrived — the free units included, which is exactly what makes them worth taking.
     */
    v_landed := case
      when (v_base_qty + v_free_base) > 0
        then (v_line_value
              + case when v_goods_total > 0
                     then v_extra * (v_line_value / v_goods_total)
                     else 0 end
             ) / (v_base_qty + v_free_base)
      else 0
    end;

    -- Never below zero: a rebate larger than the goods would otherwise make stock cost a negative
    -- amount, and every margin computed from it would be nonsense.
    v_landed := greatest(v_landed, 0);

    insert into public.purchase_lines (purchase_id, product_id, entered_qty, entered_pack_id,
                                       base_qty, unit_cost_raw, unit_cost_landed, free_qty)
    values (v_purchase_id, v_product_id, v_entered, v_pack_id,
            v_base_qty + v_free_base,
            case when v_base_qty > 0 then v_line_value / v_base_qty else 0 end,
            v_landed, v_free);

    -- The layer this delivery becomes. Everything after this prices against it.
    insert into public.stock_layers (store_id, product_id, qty_base, remaining_base, unit_cost,
                                     ref_table, ref_id, received_at)
    values (p_store_id, v_product_id, v_base_qty + v_free_base, v_base_qty + v_free_base,
            v_landed, 'purchases', v_purchase_id, p_occurred_at);

    perform public.apply_weighted_average(v_product_id, v_base_qty + v_free_base, v_landed);

    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at)
    values (p_store_id, v_product_id, 'receive', v_base_qty + v_free_base, v_landed,
            'purchases', v_purchase_id, p_occurred_at);

    v_period := public.ensure_open_period(v_product_id);
    perform public.refresh_period(v_period);
  end loop;

  return v_purchase_id;
end;
$$;

grant execute on function public.record_purchase(uuid, jsonb, text, text, money_amt, money_amt, timestamptz, uuid, jsonb, money_amt) to authenticated;
