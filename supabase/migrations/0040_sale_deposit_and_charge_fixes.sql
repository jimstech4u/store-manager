-- =====================================================================================
-- 0040 — Two things the sale was recording wrongly
--
-- Both found by driving a real sale through the UI and then reading what landed in the tables.
--
-- 1. DEPOSITS THAT WERE NEVER TAKEN. `record_sale` stamped the pool's standard deposit rate onto
--    every returnable row it created, whether or not the sale actually charged a deposit. Crates
--    handed over on trust — the ordinary case for a known customer — were therefore recorded as
--    though the shop was holding cash against them. Selling three crates of Goldberg and half a
--    crate of Trophy left the customer's account claiming ₦11,250 of their money was held, when
--    nothing had changed hands. The rate is now recorded only when a deposit was charged.
--
-- 2. THE ORDER FEE WAS NOT A CHARGE. `settle_sale` wrote the transport fee into `fee_amount` and
--    added it to the total, but never created a `sale_charges` row. The bill was right and
--    unexplainable: the customer's account reads named charges from `sale_charges`, so a ₦2,000
--    transport fee appeared as ₦2,000 of nothing.
--
-- Both bodies are the live definitions with those two changes applied, so nothing else moved.
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.record_sale(p_store_id uuid, p_lines jsonb, p_customer_id uuid DEFAULT NULL::uuid, p_occurred_at timestamp with time zone DEFAULT now(), p_client_uuid uuid DEFAULT NULL::uuid, p_charges jsonb DEFAULT '[]'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sale_id    uuid;
  v_line       jsonb;
  v_charge     jsonb;
  v_product_id uuid;
  v_base_qty   qty;
  v_entered    qty;
  v_pack_id    uuid;
  v_price      money_amt;
  v_line_total money_amt;
  v_total      money_amt := 0;
  v_avg_cost   unit_cost;
  v_containers qty;
  v_deposit    money_amt;
  v_ret        record;
  v_period     uuid;
  v_bad        int;
  v_pos        int := 0;
begin
  if not public.has_permission(p_store_id, 'sales.record') then
    raise exception 'you do not have permission to record sales' using errcode = '42501';
  end if;

  if p_client_uuid is not null then
    select id into v_sale_id from public.sales where client_uuid = p_client_uuid;
    if v_sale_id is not null then
      return v_sale_id;
    end if;
  end if;

  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'a sale needs at least one line' using errcode = '22023';
  end if;

  insert into public.sales (store_id, store_customer_id, occurred_at, client_uuid, total)
  values (p_store_id, p_customer_id, p_occurred_at, p_client_uuid, 0)
  returning id into v_sale_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_entered    := (v_line ->> 'qty')::qty;
    v_pack_id    := nullif(v_line ->> 'pack_id', '')::uuid;
    v_containers := coalesce((v_line ->> 'containers_out')::qty, 0);
    v_deposit    := coalesce((v_line ->> 'deposit_charged')::money_amt, 0);

    v_base_qty := coalesce(
      nullif(v_line ->> 'base_qty', '')::qty,
      public.to_base_qty(v_product_id, v_entered, v_pack_id)
    );

    -- Refuse a shape this product is not sold in, before anything is written.
    perform public.assert_sale_unit_allowed(v_product_id, v_base_qty);

    v_price      := nullif(v_line ->> 'unit_price', '')::money_amt;
    v_line_total := nullif(v_line ->> 'line_total', '')::money_amt;

    if v_line_total is null and v_price is null then
      raise exception 'a sale line needs either a price or a line total' using errcode = '22023';
    end if;
    if v_line_total is null then
      v_line_total := v_entered * v_price;
    end if;
    if v_price is null then
      v_price := case when v_entered <> 0 then v_line_total / v_entered else v_line_total end;
    end if;

    select avg_unit_cost into v_avg_cost from public.products where id = v_product_id;

    insert into public.sale_lines (sale_id, product_id, entered_qty, entered_pack_id, base_qty,
                                   unit_price, line_total, unit_cost_at_sale, containers_out,
                                   deposit_charged)
    values (v_sale_id, v_product_id, v_entered, v_pack_id, v_base_qty,
            v_price, v_line_total, coalesce(v_avg_cost, 0), v_containers, v_deposit);

    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at)
    values (p_store_id, v_product_id, 'sale', -v_base_qty, coalesce(v_avg_cost, 0),
            'sales', v_sale_id, p_occurred_at);

    for v_ret in
      select * from public.returnables_for_sale(v_product_id, v_base_qty, v_containers)
    loop
      if p_customer_id is not null then
        insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                           direction, qty_units, deposit_per_unit,
                                           ref_table, ref_id, occurred_at)
        values (p_store_id, p_customer_id, v_ret.empties_category_id, 'collected',
                v_ret.qty_units,
                -- Only a deposit that was actually CHARGED is money the shop holds. The
                -- pool's standard rate was being stamped on every row, so containers sent
                -- out on trust looked like cash taken and never given back.
                case when v_deposit > 0 then v_ret.deposit_per_unit else 0 end,
                'sales', v_sale_id, p_occurred_at);

      elsif v_deposit <= 0 and v_ret.deposit_total > 0 then
        raise exception
          'This sale includes % that must come back. Either add a customer, or charge the % deposit as cash.',
          v_ret.category_name, to_char(v_ret.deposit_total, 'FM999999990.00')
          using errcode = '22023';
      end if;
    end loop;

    v_total  := v_total + v_line_total + v_deposit;
    v_period := public.ensure_open_period(v_product_id);
    perform public.refresh_period(v_period);
  end loop;

  -- Named charges: each keeps its own label, because "what was this for?" is the question that
  -- gets asked when a customer disputes a bill weeks later.
  for v_charge in select * from jsonb_array_elements(coalesce(p_charges, '[]'::jsonb)) loop
    continue when coalesce((v_charge ->> 'amount')::money_amt, 0) <= 0;
    insert into public.sale_charges (sale_id, label, amount, sort_order)
    values (v_sale_id,
            coalesce(nullif(trim(v_charge ->> 'label'), ''), 'Charge'),
            (v_charge ->> 'amount')::money_amt,
            v_pos);
    v_total := v_total + (v_charge ->> 'amount')::money_amt;
    v_pos := v_pos + 1;
  end loop;

  update public.sales set total = v_total where id = v_sale_id;

  select count(*) into v_bad
  from public.sale_lines sl
  join public.products p on p.id = sl.product_id
  join public.units u on u.code = p.base_unit
  where sl.sale_id = v_sale_id
    and not u.allows_fraction
    and sl.base_qty <> trunc(sl.base_qty);

  if v_bad > 0 then
    raise exception 'one of these products is counted in whole units only' using errcode = '22023';
  end if;

  return v_sale_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.settle_sale(p_store_id uuid, p_lines jsonb, p_payments jsonb DEFAULT '[]'::jsonb, p_customer_id uuid DEFAULT NULL::uuid, p_fee_amount money_amt DEFAULT 0, p_fee_label text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_occurred_at timestamp with time zone DEFAULT now(), p_client_uuid uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sale_id   uuid;
  v_pay       jsonb;
  v_amount    money_amt;
  v_settings  record;
  v_transfer  text;
  v_total     money_amt;
begin
  if p_client_uuid is not null then
    select id into v_sale_id from public.sales where client_uuid = p_client_uuid;
    if v_sale_id is not null then
      return v_sale_id;                     -- a retry, not a second sale
    end if;
  end if;

  -- record_sale checks the permission, moves stock and builds empties obligations.
  v_sale_id := public.record_sale(p_store_id, p_lines, p_customer_id, p_occurred_at, p_client_uuid);

  select * into v_settings from public.store_settings where store_id = p_store_id;
  if found and v_settings.show_transfer_details then
    v_transfer := concat_ws(E'\n',
      nullif(v_settings.transfer_bank_name, ''),
      nullif(v_settings.transfer_account_no, ''),
      nullif(v_settings.transfer_account_name, ''));
  end if;

  update public.sales
     set fee_amount       = coalesce(p_fee_amount, 0),
         fee_label        = nullif(trim(p_fee_label), ''),
         note             = nullif(trim(p_note), ''),
         transfer_details = v_transfer,
         total            = total + coalesce(p_fee_amount, 0)
   where id = v_sale_id
  returning total into v_total;

  -- The order-level fee also becomes a NAMED CHARGE.
  --
  -- It was landing in `fee_amount` and in the total, and nowhere else — so a transport charge
  -- raised the bill by ₦2,000 and then could not be itemised on the receipt or answered for on
  -- the customer's account, which reads charges from `sale_charges`. "What was this ₦2,000 for?"
  -- is the question that gets asked weeks later, and the answer has to be somewhere.
  if coalesce(p_fee_amount, 0) > 0 then
    insert into public.sale_charges (sale_id, label, amount, sort_order)
    values (v_sale_id, coalesce(nullif(trim(p_fee_label), ''), 'Extra charge'),
            p_fee_amount,
            coalesce((select max(sort_order) + 1 from public.sale_charges
                       where sale_id = v_sale_id), 0));
  end if;

  -- Several payment methods on one sale: each becomes its own payment row, so the cash drawer
  -- and the bank can be reconciled separately later. record_payment allocates oldest-first.
  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    v_amount := (v_pay ->> 'amount')::money_amt;
    continue when coalesce(v_amount, 0) <= 0;

    if p_customer_id is null then
      -- A walk-in paying cash has no ledger to settle against, so the payment is recorded
      -- against the sale directly rather than a customer balance.
      insert into public.payments (store_id, store_customer_id, amount, method, reference, occurred_at)
      values (p_store_id, null, v_amount, coalesce(v_pay ->> 'method', 'cash'),
              nullif(v_pay ->> 'reference', ''), p_occurred_at);
    else
      perform public.record_payment(
        p_store_id, p_customer_id, v_amount,
        coalesce(v_pay ->> 'method', 'cash'),
        nullif(v_pay ->> 'reference', ''),
        p_occurred_at,
        null
      );
    end if;
  end loop;

  return v_sale_id;
end;
$function$
;
