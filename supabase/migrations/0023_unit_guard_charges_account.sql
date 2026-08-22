-- =====================================================================================
-- 0023 — Sale-unit guard, named charges, and the customer account picture
--
-- Three things from the same conversation.
--
-- 1. SALE UNITS AS A GUARD, not just a convenience. If a seller has configured that a product
--    leaves as a pack or a half pack, then a quarter or a loose piece is a MISTAKE — usually a
--    mistyped quantity — and the system should refuse it rather than record it. Configurable per
--    product, because plenty of products genuinely do sell in any amount.
--
-- 2. NAMED CHARGES, more than one per sale. A real bill reads "transport 2,000" and "loading
--    4,000" as separate lines, not one lump called "extra charge". A single fee column could not
--    express that, and rolling them together loses the only thing that makes a charge
--    disputable later — what it was for.
--
-- 3. THE ACCOUNT PICTURE. What a customer owes is not one number. From the domain expert:
--
--        sales                 ₦200,000
--        transport charge        ₦2,000
--        outstanding            ₦15,000
--        {named charge}          ₦4,000
--        14 Nigerian Breweries empties (Star, Gulder, any kind)
--        20 Guinness empties (Malta Guinness, big stout)
--        2 dispenser water bottles
--
--    Money AND containers, containers grouped by the pool they are interchangeable within. One
--    call returns all of it, because it is one question.
-- =====================================================================================

-- ─── Named charges on a sale ────────────────────────────────────────────────────────

create table if not exists public.sale_charges (
  id         uuid primary key default gen_random_uuid(),
  sale_id    uuid not null references public.sales (id) on delete cascade,
  label      text not null,
  amount     money_amt not null check (amount >= 0),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists sale_charges_sale_idx on public.sale_charges (sale_id, sort_order);

alter table public.sale_charges enable row level security;

create policy sale_charges_read on public.sale_charges
  for select to authenticated
  using (exists (select 1 from public.sales s
                 where s.id = sale_id and public.is_store_member(s.store_id)));

create policy sale_charges_write on public.sale_charges
  for all to authenticated
  using (exists (select 1 from public.sales s
                 where s.id = sale_id and public.has_permission(s.store_id, 'sales.record')))
  with check (exists (select 1 from public.sales s
                 where s.id = sale_id and public.has_permission(s.store_id, 'sales.record')));

-- Drafts carry them too, so a charge survives being handed to a colleague.
create table if not exists public.draft_order_charges (
  id             uuid primary key default gen_random_uuid(),
  draft_order_id uuid not null references public.draft_orders (id) on delete cascade,
  label          text not null,
  amount         money_amt not null check (amount >= 0),
  sort_order     int not null default 0
);

create index if not exists draft_charges_idx on public.draft_order_charges (draft_order_id, sort_order);

alter table public.draft_order_charges enable row level security;

create policy draft_charges_rw on public.draft_order_charges
  for all to authenticated
  using (exists (select 1 from public.draft_orders d
                 where d.id = draft_order_id and public.is_store_member(d.store_id)))
  with check (exists (select 1 from public.draft_orders d
                 where d.id = draft_order_id
                   and public.has_permission(d.store_id, 'sales.record')));

-- ─── Sale-unit guard ────────────────────────────────────────────────────────────────
--
-- Called from record_sale for every line. Silent when the product allows any amount or has no
-- configured shapes; otherwise the quantity must be a whole number of one of them.

create or replace function public.assert_sale_unit_allowed(
  p_product_id uuid,
  p_base_qty   qty
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_free      boolean;
  v_has_units boolean;
  v_ok        boolean;
  v_names     text;
  v_name      text;
begin
  select p.allow_free_qty, p.name into v_free, v_name
  from public.products p where p.id = p_product_id;

  if coalesce(v_free, true) then
    return;                       -- sold in any amount, by configuration
  end if;

  select exists (select 1 from public.product_sale_units where product_id = p_product_id)
    into v_has_units;

  if not v_has_units then
    -- Locked down but nothing configured would make the product unsellable. Treat the absence of
    -- shapes as "no restriction yet" rather than silently blocking every sale.
    return;
  end if;

  -- A whole number of one configured shape. Two half packs is fine; one and a half is not,
  -- because that is what a mistyped quantity looks like.
  select exists (
    select 1
    from public.product_sale_units su
    where su.product_id = p_product_id
      and su.base_qty > 0
      and abs((p_base_qty / su.base_qty) - round(p_base_qty / su.base_qty)) < 0.0001
      and round(p_base_qty / su.base_qty) >= 1
  ) into v_ok;

  if not v_ok then
    select string_agg(su.name, ', ' order by su.sort_order)
      into v_names
      from public.product_sale_units su
     where su.product_id = p_product_id;

    raise exception '% is only sold as: %. Adjust the quantity or change this in settings.',
      v_name, v_names
      using errcode = '22023';
  end if;
end;
$$;

grant execute on function public.assert_sale_unit_allowed(uuid, qty) to authenticated;

-- ─── record_sale, with the guard and named charges ──────────────────────────────────

create or replace function public.record_sale(
  p_store_id     uuid,
  p_lines        jsonb,
  p_customer_id  uuid default null,
  p_occurred_at  timestamptz default now(),
  p_client_uuid  uuid default null,
  p_charges      jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
                v_ret.qty_units, v_ret.deposit_per_unit, 'sales', v_sale_id, p_occurred_at);

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
$$;

grant execute on function public.record_sale(uuid, jsonb, uuid, timestamptz, uuid, jsonb)
  to authenticated;

-- ─── The customer account, whole ────────────────────────────────────────────────────
--
-- Money and containers together, because that is how a seller thinks about what someone owes.
-- Empties are grouped by CATEGORY, not by product: "14 NBL empties" is the real obligation, and
-- which of Star, Gulder or Heineken comes back does not matter.

create or replace function public.customer_account(p_store_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'customer', jsonb_build_object(
      'id', sc.id,
      'name', sc.display_name,
      'business', sc.business_name,
      'phone', i.phone
    ),
    'balance', public.customer_balance_total(sc.id),
    'money', jsonb_build_object(
      'goods', coalesce((
        select sum(sl.line_total)
        from public.sales s2
        join public.sale_lines sl on sl.sale_id = s2.id
        where s2.store_customer_id = sc.id and s2.status = 'posted'
      ), 0),
      'deposits_charged', coalesce((
        select sum(sl.deposit_charged)
        from public.sales s2
        join public.sale_lines sl on sl.sale_id = s2.id
        where s2.store_customer_id = sc.id and s2.status = 'posted'
      ), 0),
      'paid', coalesce((
        select sum(case when p.direction = 'in' then p.amount else -p.amount end)
        from public.payments p where p.store_customer_id = sc.id
      ), 0)
    ),
    -- Every named charge, kept separate and summed by label, so "transport" and "loading" are
    -- two lines the customer can recognise rather than one number they cannot.
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('label', t.label, 'amount', t.amount) order by t.label)
      from (
        select ch.label as label, sum(ch.amount) as amount
        from public.sales s3
        join public.sale_charges ch on ch.sale_id = s3.id
        where s3.store_customer_id = sc.id and s3.status = 'posted'
        group by ch.label
      ) t
    ), '[]'::jsonb),
    -- Containers still out, per fungible pool.
    -- Grouped in a subquery first: jsonb_agg over sum() directly is a nested aggregate, which
    -- Postgres rejects.
    'empties', coalesce((
      select jsonb_agg(jsonb_build_object(
        'category_id', e.category_id,
        'category', e.category,
        'kind', e.kind,
        'qty', e.qty,
        'deposit_value', e.deposit_value
      ) order by e.category)
      from (
        select ec.id as category_id,
               ec.name as category,
               ec.kind as kind,
               sum(d.qty_units) as qty,
               sum(d.qty_units * ec.deposit) as deposit_value
        from public.deposit_ledger d
        join public.empties_categories ec on ec.id = d.empties_category_id
        where d.store_customer_id = sc.id and d.direction = 'collected'
        group by ec.id, ec.name, ec.kind
        having sum(d.qty_units) > 0
      ) e
    ), '[]'::jsonb)
  )
  from public.store_customers sc
  join public.identities i on i.id = sc.identity_id
  where sc.id = p_store_customer_id
    and public.is_store_member(sc.store_id);
$$;

grant execute on function public.customer_account(uuid) to authenticated;
