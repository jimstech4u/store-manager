-- =====================================================================================
-- 0008 — sale lines may carry an exact line total
--
-- Found while verifying Scenario A: "6 pieces for ₦1,900" had to be entered as a unit price of
-- ₦316.666667, and 6 × that is ₦1,900.000002. The sale totalled ₦6,950.01 instead of ₦6,950.
--
-- One kobo is not a rounding curiosity here. A seller quotes a LINE TOTAL — "six for one
-- thousand nine hundred" — and a receipt whose arithmetic is visibly a kobo out is a receipt a
-- customer argues with. Worse, the drift accumulates into the debtor balance, and this product
-- exists to make balances reconcilable.
--
-- So the caller may pass `line_total` directly. Unit price is then derived for display, and the
-- total stored is exactly the number the two people agreed on.
-- =====================================================================================

create or replace function public.record_sale(
  p_store_id     uuid,
  p_lines        jsonb,
  p_customer_id  uuid default null,
  p_occurred_at  timestamptz default now(),
  p_client_uuid  uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale_id    uuid;
  v_line       jsonb;
  v_product_id uuid;
  v_base_qty   qty;
  v_entered    qty;
  v_pack_id    uuid;
  v_price      money_amt;
  v_line_total money_amt;
  v_total      money_amt := 0;
  v_avg_cost   unit_cost;
  v_containers qty;
  v_ret        record;
  v_period     uuid;
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
    v_base_qty   := public.to_base_qty(v_product_id, v_entered, v_pack_id);

    if v_base_qty <= 0 then
      raise exception 'quantity must be greater than zero' using errcode = '22023';
    end if;

    -- An explicit line_total wins: it is what the seller and customer actually agreed.
    if (v_line ? 'line_total') and (v_line ->> 'line_total') is not null then
      v_line_total := (v_line ->> 'line_total')::money_amt;
      v_price      := round(v_line_total / v_entered, 2);
    else
      v_price      := (v_line ->> 'unit_price')::money_amt;
      v_line_total := round(v_entered * v_price, 2);
    end if;

    if v_line_total < 0 then
      raise exception 'a line total cannot be negative' using errcode = '22023';
    end if;

    select avg_unit_cost into v_avg_cost from public.products where id = v_product_id;

    insert into public.sale_lines (sale_id, product_id, entered_qty, entered_pack_id, base_qty,
                                   unit_price, line_total, unit_cost_at_sale, containers_out)
    values (v_sale_id, v_product_id, v_entered, v_pack_id, v_base_qty,
            v_price, v_line_total, coalesce(v_avg_cost, 0), v_containers);

    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at)
    values (p_store_id, v_product_id, 'sale', -v_base_qty, coalesce(v_avg_cost, 0),
            'sales', v_sale_id, p_occurred_at);

    if p_customer_id is not null then
      for v_ret in
        select pr.empties_category_id, pr.qty_per_base_unit, ec.kind, ec.deposit
          from public.product_returnables pr
          join public.empties_categories ec on ec.id = pr.empties_category_id
         where pr.product_id = v_product_id
      loop
        if v_ret.kind = 'content' and coalesce(v_ret.qty_per_base_unit, 0) > 0 then
          insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                             direction, qty_units, deposit_per_unit,
                                             ref_table, ref_id, occurred_at)
          values (p_store_id, p_customer_id, v_ret.empties_category_id, 'collected',
                  v_base_qty * v_ret.qty_per_base_unit, v_ret.deposit,
                  'sales', v_sale_id, p_occurred_at);
        elsif v_ret.kind = 'container' and v_containers > 0 then
          insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                             direction, qty_units, deposit_per_unit,
                                             ref_table, ref_id, occurred_at)
          values (p_store_id, p_customer_id, v_ret.empties_category_id, 'collected',
                  v_containers, v_ret.deposit, 'sales', v_sale_id, p_occurred_at);
        end if;
      end loop;
    end if;

    v_total  := v_total + v_line_total;
    v_period := public.ensure_open_period(v_product_id);
    perform public.refresh_period(v_period);
  end loop;

  update public.sales set total = v_total where id = v_sale_id;

  return v_sale_id;
end;
$$;

grant execute on function public.record_sale(uuid, jsonb, uuid, timestamptz, uuid) to authenticated;
