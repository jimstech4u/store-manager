-- ════════════════════════════════════════════════════════════════════════════════════════════
-- What a delivery really cost, and which stock a sale actually took
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- Step two. The layers from 0061 start being written and consumed here.
--
-- A DELIVERY'S COST IS NOT THE INVOICE PRICE. Three hundred packs at ₦4,400 is ₦1,320,000, and
-- then there is loading, transport, the boy who offloaded — and against that, a rebate, or seven
-- free packs, or both. Every one of those changes what a pack actually cost, and a shop that
-- prices off the invoice figure is pricing off a number that was never true.
--
--   goods + charges − rebate          1,320,000 + 27,000 − 20,000
--   ────────────────────────────  =   ───────────────────────────  =  ₦4,322.47 a pack
--   units + free units                        300 + 7
--
-- `record_purchase` already spread two fixed fees across lines by value. It could not take a
-- NAMED list of them, and it knew nothing about rebates or free goods — so the two commonest
-- things that move a Nigerian distributor's cost had nowhere to go.
--
-- AND A SALE TAKES REAL STOCK. Cost of goods sold was the moving average at the moment of sale.
-- Now it is what the stock being carried out of the door actually cost: oldest layer first, and a
-- sale spanning two deliveries is charged partly at each. That is the whole point of layers, and
-- it is what makes `dearest_live_cost` mean anything.

-- ─── Named charges on a delivery ────────────────────────────────────────────────────

create table if not exists public.purchase_charges (
  id          uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases (id) on delete cascade,
  label       text not null,
  amount      money_amt not null check (amount >= 0),
  note        text,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists purchase_charges_idx on public.purchase_charges (purchase_id, sort_order);

alter table public.purchase_charges enable row level security;

create policy purchase_charges_read on public.purchase_charges
  for select to authenticated
  using (exists (select 1 from public.purchases pu
                  where pu.id = purchase_id and public.is_store_member(pu.store_id)));

create policy purchase_charges_write on public.purchase_charges
  for all to authenticated
  using (exists (select 1 from public.purchases pu
                  where pu.id = purchase_id and public.has_permission(pu.store_id, 'stock.receive')))
  with check (exists (select 1 from public.purchases pu
                       where pu.id = purchase_id and public.has_permission(pu.store_id, 'stock.receive')));

-- What was given back, and what was given free. Both change the cost per unit.
alter table public.purchases       add column if not exists rebate_amount money_amt not null default 0;
alter table public.purchase_lines  add column if not exists free_qty      qty       not null default 0;

-- ─── Taking stock off the shelf, oldest first ───────────────────────────────────────

/**
 * Consume `p_qty_base` from the layers of a product, oldest first, and return what it cost.
 *
 * FIFO because it is what a shop does physically — the crates at the back went in first and go out
 * first — and because it is the only rule under which "the dearest stock I still hold" has a
 * meaning. The return value is the money, not the average: a sale that spans a ₦4,400 delivery and
 * a ₦4,200 one is charged partly at each, which is what its margin actually was.
 *
 * MORE MAY BE SOLD THAN IS RECORDED. Offline sync makes negative stock inevitable and the shop
 * still has to be able to sell. Anything beyond the layers is costed at the last known layer, or
 * the product's average when there are none — the sale is never blocked, and the shortfall shows
 * up in a count rather than in a refusal at the counter.
 */
create or replace function public.consume_stock_layers(p_product_id uuid, p_qty_base qty)
returns money_amt
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
     order by received_at, id
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
$$;

revoke all on function public.consume_stock_layers(uuid, qty) from public, anon, authenticated;

/**
 * Put stock back, when a sale is voided or goods come back.
 *
 * Returned to the layer it came from where that layer still exists, and to a fresh one at the
 * given cost otherwise. A return is not a purchase: it must not make the shop's stock look
 * cheaper than it was, which is what re-costing it at today's price would do.
 */
create or replace function public.restore_stock_layer(
  p_store_id uuid, p_product_id uuid, p_qty_base qty, p_unit_cost unit_cost
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_qty_base is null or p_qty_base <= 0 then
    return;
  end if;

  select id into v_id
    from public.stock_layers
   where product_id = p_product_id
     and unit_cost = p_unit_cost
   order by received_at desc
   limit 1;

  if v_id is not null then
    update public.stock_layers
       set remaining_base = remaining_base + p_qty_base,
           qty_base       = greatest(qty_base, remaining_base + p_qty_base)
     where id = v_id;
  else
    insert into public.stock_layers
      (store_id, product_id, qty_base, remaining_base, unit_cost, ref_table)
    values (p_store_id, p_product_id, p_qty_base, p_qty_base, p_unit_cost, 'return');
  end if;
end;
$$;

revoke all on function public.restore_stock_layer(uuid, uuid, qty, unit_cost) from public, anon, authenticated;

-- ─── Receiving, with everything that moves the cost ─────────────────────────────────
--
-- The old eight-argument signature is DROPPED rather than left beside this one. Adding arguments
-- with defaults creates a second overload, and PostgREST answers an ambiguous name with 300 — the
-- failure that stopped the till saving twice already in this codebase.

drop function if exists public.record_purchase(uuid, jsonb, text, text, money_amt, money_amt, timestamptz, uuid);

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

    select coalesce(pk.base_unit_qty, 1) into v_pack_base
      from public.product_packs pk where pk.id = v_pack_id;
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
