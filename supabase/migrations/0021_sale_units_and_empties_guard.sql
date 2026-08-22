-- =====================================================================================
-- 0021 — Sale units, and closing the anonymous-empties hole
--
-- TWO CHANGES, from the same conversation.
--
-- 1. SALE UNITS. A product is not sold in one shape. A 12-piece pack of PET is sold as a pack,
--    a half pack (6), a quarter (3), and sometimes as single pieces — each with its OWN price,
--    which is not the pack price divided down (a half pack is rarely exactly half the money).
--    Bulk is the same: a 50kg bag sold as 25kg, 1kg, or any weight the customer asks for.
--
--    So a seller configures the units they actually sell in, and the sale screen offers those
--    rather than making someone compute "6" every time they sell half a pack. Products that are
--    genuinely sold by any amount keep that freedom through `allow_free_qty`.
--
-- 2. THE EMPTIES HOLE. record_sale only created returnable obligations when a customer was
--    attached. For an anonymous sale it silently created none — so a Trophy bottle could walk
--    out of the shop with no record that anything was owed back. The stock was right and the
--    money was right, and the crate was simply gone.
--
--    As the domain expert put it: empties ARE credit, so the account must exist. This makes that
--    true in the database rather than by convention. A returnable leaving with no account to
--    owe it means the deposit has to be TAKEN IN CASH instead — the shop is made whole either
--    way, and neither path can quietly lose the container.
-- =====================================================================================

-- ─── Sale units ─────────────────────────────────────────────────────────────────────

create table if not exists public.product_sale_units (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products (id) on delete cascade,

  /** What the seller calls it out loud: "Pack", "Half pack", "Piece", "25kg". */
  name        text not null,

  /** How many base units this is. 6 for a half pack of 12; 0.5 for half a bottle. */
  base_qty    qty  not null check (base_qty > 0),

  /**
   * Its own price. Deliberately NOT derived from the pack price: a half pack is rarely exactly
   * half the money, and deriving it would quietly overwrite a deliberate pricing decision every
   * time the pack price changed.
   */
  price       money_amt check (price >= 0),

  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (product_id, name)
);

create index if not exists product_sale_units_product_idx
  on public.product_sale_units (product_id, sort_order);

alter table public.product_sale_units enable row level security;

create policy sale_units_read on public.product_sale_units
  for select to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and public.is_store_member(p.store_id)));

create policy sale_units_write on public.product_sale_units
  for all to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')))
  with check (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')));

-- Some products are sold by any amount the customer asks for (loose pieces, an arbitrary weight);
-- others should only leave in the shapes the seller has priced. Default true so nothing that
-- worked before is suddenly refused.
alter table public.products
  add column if not exists allow_free_qty boolean not null default true;

-- ─── Deposits taken in cash ─────────────────────────────────────────────────────────
--
-- Added to the sale total when a returnable leaves without an account behind it.

alter table public.sale_lines
  add column if not exists deposit_charged money_amt not null default 0
    check (deposit_charged >= 0);

-- ─── Reading a product's units ──────────────────────────────────────────────────────

create or replace function public.product_sale_units_for(p_product_id uuid)
returns table (
  id       uuid,
  name     text,
  base_qty qty,
  price    money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select su.id, su.name, su.base_qty, su.price
  from public.product_sale_units su
  join public.products p on p.id = su.product_id
  where su.product_id = p_product_id
    and public.is_store_member(p.store_id)
  order by su.sort_order, su.base_qty desc;
$$;

/**
 * What a returnable-carrying sale owes back, per base unit sold.
 *
 * Used by the app to decide, BEFORE settling, whether this sale needs a customer or a cash
 * deposit — so the question is asked while it can still be answered, not raised as an error
 * after the seller has taken the money.
 */
create or replace function public.returnables_for_sale(
  p_product_id uuid,
  p_base_qty   qty,
  p_containers qty default 0
)
returns table (
  empties_category_id uuid,
  category_name       text,
  kind                text,
  qty_units           qty,
  deposit_per_unit    money_amt,
  deposit_total       money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ec.id,
         ec.name,
         ec.kind,
         units.qty_units,
         ec.deposit,
         (units.qty_units * ec.deposit)::money_amt
  from public.product_returnables pr
  join public.empties_categories ec on ec.id = pr.empties_category_id
  join public.products p on p.id = pr.product_id
  cross join lateral (
    select case
      when ec.kind = 'content' then p_base_qty * coalesce(pr.qty_per_base_unit, 0)
      else coalesce(p_containers, 0)
    end as qty_units
  ) units
  where pr.product_id = p_product_id
    and public.is_store_member(p.store_id)
    and units.qty_units > 0;
$$;

grant execute on function public.product_sale_units_for(uuid)              to authenticated;
grant execute on function public.returnables_for_sale(uuid, qty, qty)      to authenticated;

-- ─── record_sale: returnables can no longer disappear ───────────────────────────────

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
  v_deposit    money_amt;
  v_ret        record;
  v_period     uuid;
  v_owed       qty;
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
    v_price      := (v_line ->> 'unit_price')::money_amt;
    v_containers := coalesce((v_line ->> 'containers_out')::qty, 0);
    v_deposit    := coalesce((v_line ->> 'deposit_charged')::money_amt, 0);

    -- base_qty may be supplied directly (a sale unit like "half pack" is not a pack multiple),
    -- otherwise it is derived from the pack.
    v_base_qty := coalesce(
      nullif(v_line ->> 'base_qty', '')::qty,
      public.to_base_qty(v_product_id, v_entered, v_pack_id)
    );

    v_line_total := coalesce(nullif(v_line ->> 'line_total', '')::money_amt, v_entered * v_price);

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

    -- ── Returnables ────────────────────────────────────────────────────────────────
    for v_ret in
      select * from public.returnables_for_sale(v_product_id, v_base_qty, v_containers)
    loop
      if p_customer_id is not null then
        -- There is an account, so the container is owed back. This IS credit — the customer
        -- holds something of the shop's until they return it.
        insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                           direction, qty_units, deposit_per_unit,
                                           ref_table, ref_id, occurred_at)
        values (p_store_id, p_customer_id, v_ret.empties_category_id, 'collected',
                v_ret.qty_units, v_ret.deposit_per_unit, 'sales', v_sale_id, p_occurred_at);

      elsif v_deposit <= 0 and v_ret.deposit_total > 0 then
        -- No account and no cash taken: the container would simply walk out unrecorded, which
        -- is the hole this migration closes. Refuse, and say what to do about it.
        raise exception
          'This sale includes % that must come back. Either add a customer, or charge the % deposit as cash.',
          v_ret.category_name, to_char(v_ret.deposit_total, 'FM999999990.00')
          using errcode = '22023';
      end if;
    end loop;

    -- A cash deposit is part of what the customer pays today.
    v_total  := v_total + v_line_total + v_deposit;
    v_period := public.ensure_open_period(v_product_id);
    perform public.refresh_period(v_period);
  end loop;

  update public.sales set total = v_total where id = v_sale_id;

  -- Guard against a fractional quantity of something counted in whole units slipping through a
  -- sale unit definition. tg_check_fraction covers the movement; this covers the line.
  select count(*) into v_owed
  from public.sale_lines sl
  join public.products p on p.id = sl.product_id
  join public.units u on u.code = p.base_unit
  where sl.sale_id = v_sale_id
    and not u.allows_fraction
    and sl.base_qty <> trunc(sl.base_qty);

  if v_owed > 0 then
    raise exception 'one of these products is counted in whole units only' using errcode = '22023';
  end if;

  return v_sale_id;
end;
$$;

grant execute on function public.record_sale(uuid, jsonb, uuid, timestamptz, uuid) to authenticated;
