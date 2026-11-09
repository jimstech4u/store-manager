-- 0274 - A delivery belongs to its supplier
--
-- "Supplier that got orders never got attached to the order — everything shows no deliveries."
-- record_purchase kept the supplier as a NAME (purchases.supplier_name) and never set
-- purchases.supplier_id, which is what supplier_history and supplier_balance read. All 41 of the
-- shop's deliveries had a name and no supplier, so every supplier page said no deliveries.
--
-- The function now sets the id from the name (suppliers are unique by name within a shop), and
-- every delivery already recorded whose name matches one of its shop's suppliers is linked to it.
-- The audit trigger records each link.

CREATE OR REPLACE FUNCTION public.record_purchase(p_store_id uuid, p_lines jsonb, p_supplier text DEFAULT NULL::text, p_invoice_ref text DEFAULT NULL::text, p_distribution money_amt DEFAULT 0, p_delivery money_amt DEFAULT 0, p_occurred_at timestamp with time zone DEFAULT now(), p_client_uuid uuid DEFAULT NULL::uuid, p_charges jsonb DEFAULT '[]'::jsonb, p_rebate money_amt DEFAULT 0)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_expires     date;
begin
  if not public.has_permission(p_store_id, 'stock.receive') then
    raise exception 'you do not have permission to receive stock' using errcode = '42501';
  end if;

  -- WHOSE products. This used to receive stock into another shop's item, moving the average cost
  -- every margin of theirs is computed from.
  perform public.assert_trade_target(p_store_id, null, p_lines);

  if p_client_uuid is not null then
    select id into v_purchase_id from public.purchases where client_uuid = p_client_uuid;
    if v_purchase_id is not null then
      return v_purchase_id;
    end if;
  end if;

  -- `distribution_fee` and `delivery_fee`: the names the table actually uses.
  -- The supplier by NAME as well as by id (0274): every supplier page reads deliveries by
  -- supplier_id, and this wrote only the name, so no delivery ever reached its supplier.
  insert into public.purchases (store_id, supplier_name, supplier_id, invoice_ref, distribution_fee,
                                delivery_fee, rebate_amount, occurred_at, client_uuid, created_by)
  values (p_store_id, nullif(trim(p_supplier), ''),
          (select s.id from public.suppliers s
            where s.store_id = p_store_id
              and lower(btrim(s.name)) = lower(btrim(p_supplier))),
          nullif(trim(p_invoice_ref), ''),
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
    -- When it goes out of date. Optional, and a blank stays a blank: most of what this
    -- trade carries has a date nobody ever reaches, and a required field gets a guess.
    v_expires      := nullif(v_line ->> 'expires_on', '')::date;

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
                                       base_qty, unit_cost_raw, unit_cost_landed, free_qty,
                                       expires_on)
    values (v_purchase_id, v_product_id, v_entered, v_pack_id,
            v_base_qty + v_free_base,
            case when v_base_qty > 0 then v_line_value / v_base_qty else 0 end,
            v_landed, v_free, v_expires);

    -- The layer this delivery becomes. Everything after this prices against it.
    insert into public.stock_layers (store_id, product_id, qty_base, remaining_base, unit_cost,
                                     ref_table, ref_id, received_at, expires_on)
    values (p_store_id, v_product_id, v_base_qty + v_free_base, v_base_qty + v_free_base,
            v_landed, 'purchases', v_purchase_id, p_occurred_at, v_expires);

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
$function$;

update public.purchases p
   set supplier_id = s.id
  from public.suppliers s
 where p.supplier_id is null
   and s.store_id = p.store_id
   and p.supplier_name is not null
   and lower(btrim(s.name)) = lower(btrim(p.supplier_name));

notify pgrst, 'reload schema';
