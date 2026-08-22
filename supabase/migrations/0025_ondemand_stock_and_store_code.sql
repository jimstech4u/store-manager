-- =====================================================================================
-- 0025 — On-demand stock, and looking a shop up by its code
--
-- 1. ON-DEMAND STOCK — a reconciliation strategy for how these shops actually work.
--
--    Setting up 300 products before you can sell anything is a wall nobody climbs. And most of
--    that work is wasted: many items will not be asked for today, some not for weeks, and the
--    quantity you carefully typed in the morning is stale by the time anyone wants it.
--
--    So stock is recorded WHEN IT IS FIRST NEEDED. A customer asks for Eva 75cl, the seller
--    reaches for it and the app asks "how many do you have?" — once, at the moment the answer is
--    both known and relevant. That answer becomes the opening position and CRODS runs from
--    there. Nothing is guessed, and nothing is entered for an item nobody wanted.
--
--    `stock_initialised_at` marks the products that have been through this. It also gives the
--    honest answer to "is this figure trustworthy?" — a product nobody has counted yet should
--    say so rather than displaying a confident zero.
--
-- 2. STORE CODE — a short public handle so a customer, anonymous or known, can find a shop
--    directly instead of being sent a link. Uses the same read-only, unguessable-by-design
--    posture as share links: what it exposes is a name, nothing more.
-- =====================================================================================

alter table public.products
  add column if not exists stock_initialised_at timestamptz;

-- Everything that already has movements has effectively been initialised; backfilling stops the
-- app prompting for stock that is plainly already being tracked.
update public.products p
   set stock_initialised_at = now()
 where stock_initialised_at is null
   and exists (select 1 from public.stock_movements m where m.product_id = p.id);

/**
 * Record the first real count for a product, in the middle of a sale.
 *
 * Deliberately its own function rather than a plain backfill: it must be safe to call from the
 * sell screen, it must be idempotent (two staff reaching for the same product at once must not
 * double the opening figure), and it must open the CRODS period so the day is measured from
 * this moment rather than from zero.
 */
create or replace function public.initialise_stock(
  p_store_id   uuid,
  p_product_id uuid,
  p_qty        qty,
  p_unit_cost  unit_cost default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing timestamptz;
  v_period   uuid;
begin
  if not public.has_permission(p_store_id, 'stock.adjust') then
    raise exception 'you do not have permission to record stock' using errcode = '42501';
  end if;

  select stock_initialised_at into v_existing
  from public.products where id = p_product_id and store_id = p_store_id;

  if v_existing is not null then
    -- Already done, by someone else a moment ago. Return the current position rather than
    -- adding a second opening balance on top of the first.
    return jsonb_build_object(
      'already', true,
      'on_hand', public.stock_on_hand(p_product_id)
    );
  end if;

  insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost, note)
  values (p_store_id, p_product_id, 'opening', p_qty, coalesce(p_unit_cost, 0),
          'first count, recorded when the item was needed');

  if p_unit_cost is not null and p_unit_cost > 0 then
    update public.products
       set avg_unit_cost = p_unit_cost, cost_is_estimated = true
     where id = p_product_id;
  end if;

  update public.products set stock_initialised_at = now() where id = p_product_id;

  v_period := public.ensure_open_period(p_product_id);
  perform public.refresh_period(v_period);

  return jsonb_build_object('already', false, 'on_hand', public.stock_on_hand(p_product_id));
end;
$$;

grant execute on function public.initialise_stock(uuid, uuid, qty, unit_cost) to authenticated;

-- ─── Store code ─────────────────────────────────────────────────────────────────────

alter table public.stores
  add column if not exists code text;

create unique index if not exists stores_code_key on public.stores (code) where code is not null;

/**
 * Give a store a short public code. Same alphabet as share codes — no 0/O or 1/I/L, because this
 * gets read aloud and written on a sign.
 */
create or replace function public.ensure_store_code(p_store_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
  v_try  int := 0;
begin
  if not public.has_permission(p_store_id, 'store.settings') then
    raise exception 'you do not have permission to change this shop' using errcode = '42501';
  end if;

  select code into v_code from public.stores where id = p_store_id;
  if v_code is not null then
    return v_code;
  end if;

  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;

    exit when not exists (select 1 from public.stores where code = v_code);

    v_try := v_try + 1;
    if v_try > 50 then
      raise exception 'could not allocate a shop code' using errcode = '55000';
    end if;
  end loop;

  update public.stores set code = v_code where id = p_store_id;
  return v_code;
end;
$$;

/**
 * Look up a shop by its code, without signing in.
 *
 * Returns a NAME and nothing else. No stock, no prices, no customers — a public handle should
 * confirm "yes, this is the right shop" and stop there. Anything more would turn a code printed
 * on a sign into a way to read a business's books.
 */
create or replace function public.find_store_by_code(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'code', s.code)
  from public.stores s
  where s.code = upper(trim(p_code))
    and s.onboarded_at is not null;
$$;

grant execute on function public.ensure_store_code(uuid)   to authenticated;
grant execute on function public.find_store_by_code(text)  to anon, authenticated;
