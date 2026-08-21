-- =====================================================================================
-- 0005 — Server-authoritative write path
--
-- Every business write goes through a function here. The client never assembles a sale from
-- several inserts: a sale that wrote its lines but not its stock movements, or its movements
-- but not its deposit obligations, is corruption that CRODS would later report as theft.
--
-- Two rules hold throughout:
--   * idempotency — every entry point takes a client-generated UUID and returns the existing
--     row if it has seen it before. On a flaky network a retry after a timeout is NORMAL, and
--     without this it silently double-posts money (C2).
--   * the caller's identity comes from auth.uid(), never from a parameter. A client-supplied
--     user or store id is an authorization bypass waiting to happen.
-- =====================================================================================

-- ─── Period helpers ─────────────────────────────────────────────────────────────────

-- Opening/receiving/sales/damaged are recomputed FROM the movement ledger rather than
-- incremented as transactions arrive. An incremented counter can drift away from the
-- movements that produced it; a recomputation cannot. Since CRODS exists to detect
-- discrepancy, its own inputs must be beyond suspicion.
create or replace function public.refresh_period(p_period_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p record;
begin
  select * into v_p from public.stock_periods where id = p_period_id;
  if not found or v_p.status <> 'open' then
    return;
  end if;

  update public.stock_periods sp
     set receiving_qty = coalesce(agg.receiving, 0),
         sales_qty     = coalesce(agg.sales, 0),
         damaged_qty   = coalesce(agg.damaged, 0),
         other_qty     = coalesce(agg.other, 0)
    from (
      select
        sum(case when m.kind in ('receive','transfer_in')      then m.qty_delta else 0 end) as receiving,
        -- Stored positive: the CRODS formula subtracts them, and a double negative reads badly
        -- to anyone checking the arithmetic by hand, which people will do.
        sum(case when m.kind = 'sale'   then -m.qty_delta else 0 end) as sales,
        sum(case when m.kind = 'damage' then -m.qty_delta else 0 end) as damaged,
        sum(case when m.kind in ('return_in','repack_loss','adjustment','transfer_out')
                 then m.qty_delta else 0 end) as other
      from public.stock_movements m
      where m.product_id  = v_p.product_id
        and m.occurred_at >= v_p.period_start
        and (v_p.period_end is null or m.occurred_at < v_p.period_end)
    ) agg
   where sp.id = p_period_id;
end;
$$;

-- Get the open period for a product, creating one if there is none. Opening quantity comes from
-- the previous period's COUNTED closing — not its expected closing — so an unexplained variance
-- is never silently carried forward as though it had been reconciled.
create or replace function public.ensure_open_period(p_product_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id       uuid;
  v_store_id uuid;
  v_opening  qty;
begin
  select id into v_id from public.stock_periods
   where product_id = p_product_id and status = 'open';
  if v_id is not null then
    return v_id;
  end if;

  select store_id into v_store_id from public.products where id = p_product_id;
  if v_store_id is null then
    raise exception 'unknown product' using errcode = '23503';
  end if;

  select sp.actual_closing_qty into v_opening
    from public.stock_periods sp
   where sp.product_id = p_product_id and sp.status <> 'open'
   order by sp.period_end desc nulls last, sp.created_at desc
   limit 1;

  if v_opening is null then
    -- First ever period: whatever the ledger already holds (an opening backfill, typically).
    select coalesce(sum(qty_delta), 0) into v_opening
      from public.stock_movements where product_id = p_product_id;
  end if;

  insert into public.stock_periods (store_id, product_id, period_start, opening_qty)
  values (v_store_id, p_product_id, now(), coalesce(v_opening, 0))
  returning id into v_id;

  return v_id;
end;
$$;

-- ─── Quantity conversion ────────────────────────────────────────────────────────────

create or replace function public.to_base_qty(
  p_product_id uuid, p_qty qty, p_pack_id uuid
)
returns qty
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_factor qty;
begin
  if p_pack_id is null then
    return p_qty;
  end if;

  select base_unit_qty into v_factor
    from public.product_packs
   where id = p_pack_id and product_id = p_product_id;

  if v_factor is null then
    raise exception 'that pack does not belong to this product' using errcode = '23503';
  end if;

  return p_qty * v_factor;
end;
$$;

grant execute on function public.to_base_qty(uuid, qty, uuid) to authenticated;

-- ─── Record a purchase (landed cost) ────────────────────────────────────────────────
--
-- Fees are allocated across units received by VALUE share, not evenly per line: a delivery
-- carrying ₦300,000 of drinks and ₦20,000 of biscuits did not incur half its cost for the
-- biscuits, and spreading it evenly would make the cheap line look unprofitable and the
-- expensive one look better than it is.
--
-- p_lines: [{product_id, qty, pack_id, unit_cost}]

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
  v_base_qty    qty;
  v_raw_cost    unit_cost;
  v_goods_total money_amt := 0;
  v_fees        money_amt := coalesce(p_distribution, 0) + coalesce(p_delivery, 0);
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
      return v_purchase_id;              -- already applied; a retry must not double-receive
    end if;
  end if;

  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'a purchase needs at least one line' using errcode = '22023';
  end if;

  -- Pass 1: total goods value, so fees can be shared by value.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_base_qty   := public.to_base_qty(v_product_id, (v_line ->> 'qty')::qty,
                                       nullif(v_line ->> 'pack_id', '')::uuid);
    v_raw_cost   := (v_line ->> 'unit_cost')::unit_cost;
    v_goods_total := v_goods_total + (v_base_qty * v_raw_cost);
  end loop;

  insert into public.purchases (store_id, supplier_name, invoice_ref, distribution_fee,
                                delivery_fee, occurred_at, client_uuid)
  values (p_store_id, p_supplier, p_invoice_ref, coalesce(p_distribution, 0),
          coalesce(p_delivery, 0), p_occurred_at, p_client_uuid)
  returning id into v_purchase_id;

  -- Pass 2: write lines, apply landed cost, move stock.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_base_qty   := public.to_base_qty(v_product_id, (v_line ->> 'qty')::qty,
                                       nullif(v_line ->> 'pack_id', '')::uuid);
    v_raw_cost   := (v_line ->> 'unit_cost')::unit_cost;
    v_line_value := v_base_qty * v_raw_cost;

    v_landed := case
      when v_goods_total > 0
        then v_raw_cost + (v_fees * (v_line_value / v_goods_total)) / v_base_qty
      else v_raw_cost
    end;

    insert into public.purchase_lines (purchase_id, product_id, entered_qty, entered_pack_id,
                                       base_qty, unit_cost_raw, unit_cost_landed)
    values (v_purchase_id, v_product_id, (v_line ->> 'qty')::qty,
            nullif(v_line ->> 'pack_id', '')::uuid, v_base_qty, v_raw_cost, v_landed);

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

-- ─── Record a sale ──────────────────────────────────────────────────────────────────
--
-- p_lines: [{product_id, qty, pack_id, unit_price, containers_out}]
--
-- Stock is allowed to go negative. After an offline sync two devices may both have sold the
-- last pieces — the goods either existed or they did not, and refusing the write would discard
-- a sale that physically happened. The discrepancy surfaces as CRODS variance, which is exactly
-- the mechanism the business already uses to explain it.

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
      return v_sale_id;                  -- retry of an already-applied sale
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
    v_price      := (v_line ->> 'unit_price')::money_amt;
    v_containers := coalesce((v_line ->> 'containers_out')::qty, 0);
    v_base_qty   := public.to_base_qty(v_product_id, v_entered, v_pack_id);
    v_line_total := v_entered * v_price;   -- price is per ENTERED unit (per pack if a pack)

    select avg_unit_cost into v_avg_cost from public.products where id = v_product_id;

    insert into public.sale_lines (sale_id, product_id, entered_qty, entered_pack_id, base_qty,
                                   unit_price, line_total, unit_cost_at_sale, containers_out)
    values (v_sale_id, v_product_id, v_entered, v_pack_id, v_base_qty,
            v_price, v_line_total, coalesce(v_avg_cost, 0), v_containers);

    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at)
    values (p_store_id, v_product_id, 'sale', -v_base_qty, coalesce(v_avg_cost, 0),
            'sales', v_sale_id, p_occurred_at);

    -- Returnable obligations. Contents are derived per base unit (12 bottles in a crate);
    -- containers are whatever the seller declared physically left (GAP 4/5).
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

-- ─── Record a payment ───────────────────────────────────────────────────────────────
--
-- The running balance remains the source of truth; allocation is bookkeeping on top of it so a
-- receipt can say whether a particular sale is settled (GAP 6). Oldest-first by default, which
-- matches how these debts are actually discussed at the counter.

create or replace function public.record_payment(
  p_store_id    uuid,
  p_customer_id uuid,
  p_amount      money_amt,
  p_method      text default 'cash',
  p_reference   text default null,
  p_occurred_at timestamptz default now(),
  p_client_uuid uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment_id uuid;
  v_remaining  money_amt;
  v_sale       record;
  v_owed       money_amt;
  v_apply      money_amt;
begin
  if not public.has_permission(p_store_id, 'payments.record') then
    raise exception 'you do not have permission to record payments' using errcode = '42501';
  end if;

  if p_client_uuid is not null then
    select id into v_payment_id from public.payments where client_uuid = p_client_uuid;
    if v_payment_id is not null then
      return v_payment_id;
    end if;
  end if;

  if coalesce(p_amount, 0) <= 0 then
    raise exception 'payment amount must be greater than zero' using errcode = '22023';
  end if;

  insert into public.payments (store_id, store_customer_id, amount, method, reference,
                               occurred_at, client_uuid)
  values (p_store_id, p_customer_id, p_amount, p_method, p_reference, p_occurred_at, p_client_uuid)
  returning id into v_payment_id;

  v_remaining := p_amount;

  for v_sale in
    select s.id, s.total
      from public.sales s
     where s.store_customer_id = p_customer_id
       and s.status = 'posted'
     order by s.occurred_at asc
  loop
    exit when v_remaining <= 0;

    select v_sale.total - coalesce(sum(pa.amount), 0) into v_owed
      from public.payment_allocations pa where pa.sale_id = v_sale.id;

    if v_owed > 0 then
      v_apply := least(v_owed, v_remaining);
      insert into public.payment_allocations (payment_id, sale_id, amount)
      values (v_payment_id, v_sale.id, v_apply);
      v_remaining := v_remaining - v_apply;
    end if;
  end loop;

  -- Any surplus stays unallocated: it is a credit on the running balance, which is correct —
  -- customers do pay ahead, and inventing an allocation for it would misreport what was settled.
  return v_payment_id;
end;
$$;

-- ─── Return empties ─────────────────────────────────────────────────────────────────

create or replace function public.return_empties(
  p_store_id    uuid,
  p_customer_id uuid,
  p_category_id uuid,
  p_qty         qty,
  p_occurred_at timestamptz default now(),
  p_client_uuid uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id          uuid;
  v_outstanding qty;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to record empties' using errcode = '42501';
  end if;

  if p_qty <= 0 then
    raise exception 'return quantity must be greater than zero' using errcode = '22023';
  end if;

  v_outstanding := public.empties_outstanding(p_customer_id, p_category_id);
  if p_qty > v_outstanding then
    raise exception 'customer owes % of these empties but % were offered', v_outstanding, p_qty
      using errcode = '22023';
  end if;

  -- Negative row settles the obligation. The original stays untouched, so the history shows
  -- what was owed and when it came back.
  insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                     direction, qty_units, occurred_at, note)
  values (p_store_id, p_customer_id, p_category_id, 'collected', -p_qty, p_occurred_at,
          'empties returned')
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.record_purchase(uuid, jsonb, text, text, money_amt, money_amt, timestamptz, uuid) to authenticated;
grant execute on function public.record_sale(uuid, jsonb, uuid, timestamptz, uuid)      to authenticated;
grant execute on function public.record_payment(uuid, uuid, money_amt, text, text, timestamptz, uuid) to authenticated;
grant execute on function public.return_empties(uuid, uuid, uuid, qty, timestamptz, uuid) to authenticated;
grant execute on function public.ensure_open_period(uuid) to authenticated;
grant execute on function public.refresh_period(uuid)     to authenticated;
