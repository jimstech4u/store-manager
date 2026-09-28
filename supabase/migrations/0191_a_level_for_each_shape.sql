-- 0191 — A level for each shape a product is sold in
--
-- The shop sets one general level — say 10 — and that means ten of WHATEVER SHAPE you are looking
-- at: ten crates, and ten bottles. A product can then override any shape on its own: crates at 25
-- because they move fast, bottles left on the shop's ten, or bottles at 5 because a handful is
-- plenty. Each level is a count of THAT SHAPE, which is the only way a shop can reason about it —
-- "warn me below 25 crates" is a sentence; "warn me below 300" is arithmetic.
--
-- WHEN IS IT LOW? When ANY shape's rule is crossed. Expressed against the shelf, which is counted
-- in base units, that is `on_hand <= max(level × base_qty)` over the shapes — because if the stock
-- is under the largest of those products, at least one shape's rule has fired. A single figure
-- again at the end, so everything that already reads a threshold keeps working.
--
-- WHAT THIS REPLACES. `products.low_stock_threshold` held one figure in base units, and 0184 added
-- `low_stock_unit_id` to remember which shape it had been TYPED in — a label, because there was
-- only ever one level. With a level per shape that label is the key, so both columns are folded
-- into rows here. They are left in place rather than dropped: a column with no readers costs
-- nothing, and dropping one while a deploy is mid-flight costs a working till.

-- ─── 1. The rows ────────────────────────────────────────────────────────────────────

create table if not exists public.product_low_stock_levels (
  product_id      uuid not null references public.products (id) on delete cascade,
  product_unit_id uuid not null references public.product_units (id) on delete cascade,
  -- IN THAT SHAPE'S OWN UNITS. 25 against a crate means twenty-five crates, not twenty-five of
  -- whatever the shelf is counted in.
  level           numeric not null check (level >= 0),
  created_at      timestamptz not null default now(),
  primary key (product_id, product_unit_id)
);

comment on table public.product_low_stock_levels is
  'One low-stock level per shape a product is sold in, counted in THAT shape. A shape with no row '
  'follows the shop''s general level, which also means "this many of that shape". A product is '
  'low when any one of its shapes is at or below its level.';

create index if not exists product_low_levels_product_idx
  on public.product_low_stock_levels (product_id);

alter table public.product_low_stock_levels enable row level security;

drop policy if exists product_low_levels_read on public.product_low_stock_levels;
create policy product_low_levels_read on public.product_low_stock_levels
  for select to authenticated
  using (exists (select 1 from public.products p
                  where p.id = product_id and public.is_store_member(p.store_id)));

drop policy if exists product_low_levels_write on public.product_low_stock_levels;
create policy product_low_levels_write on public.product_low_stock_levels
  for all to authenticated
  using (exists (select 1 from public.products p
                  where p.id = product_id and public.has_permission(p.store_id, 'products.manage')))
  with check (exists (select 1 from public.products p
                  where p.id = product_id and public.has_permission(p.store_id, 'products.manage')));

-- ─── 2. What the single column already said, as rows ────────────────────────────────
--
-- Against the shape it was typed in where 0184 recorded one, and otherwise against the smallest
-- shape, which is what a bare base-unit figure was always counting.

insert into public.product_low_stock_levels (product_id, product_unit_id, level)
select p.id,
       coalesce(p.low_stock_unit_id, smallest.id),
       p.low_stock_threshold / nullif(coalesce(chosen.base_qty, smallest.base_qty), 0)
  from public.products p
  left join public.product_units chosen on chosen.id = p.low_stock_unit_id
  left join lateral (
    select pu.id, pu.base_qty from public.product_units pu
     where pu.product_id = p.id order by pu.base_qty limit 1
  ) smallest on true
 where p.low_stock_threshold is not null
   and coalesce(p.low_stock_unit_id, smallest.id) is not null
   and coalesce(chosen.base_qty, smallest.base_qty) > 0
on conflict (product_id, product_unit_id) do nothing;

-- ─── 3. The one figure everything else still reads ──────────────────────────────────

create or replace function public.product_low_threshold(p_product_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  /*
   * The binding threshold in BASE UNITS: the largest of the per-shape rules.
   *
   * Low when ANY shape is at or below its level, and `level × base_qty` is what that shape's rule
   * comes to on the shelf — so the one that bites first is the biggest of them, and comparing
   * on-hand against that single figure is the same question asked once.
   *
   * A shape with no row of its own follows the shop's general level, which means that many OF
   * THAT SHAPE — so it is multiplied too. A product with no shapes at all falls back to the shop's
   * level read flat, which is what it meant before shapes existed.
   */
  select coalesce(
    (select max(coalesce(l.level, ss.low_stock_threshold) * pu.base_qty)
       from public.product_units pu
       join public.products p on p.id = pu.product_id
       left join public.store_settings ss on ss.store_id = p.store_id
       left join public.product_low_stock_levels l
              on l.product_id = pu.product_id and l.product_unit_id = pu.id
      where pu.product_id = p_product_id
        and coalesce(l.level, ss.low_stock_threshold) is not null),
    (select ss2.low_stock_threshold
       from public.products p2
       join public.store_settings ss2 on ss2.store_id = p2.store_id
      where p2.id = p_product_id)
  );
$$;

grant execute on function public.product_low_threshold(uuid) to authenticated;

-- ─── 4. Setting and clearing one shape's level ──────────────────────────────────────

create or replace function public.set_shape_low_stock(
  p_product_id uuid,
  p_unit_id uuid,
  p_level numeric
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store uuid;
begin
  select store_id into v_store from public.products where id = p_product_id;
  if v_store is null then
    raise exception 'No such item' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'Only somebody who manages products can change this' using errcode = '42501';
  end if;
  if not exists (select 1 from public.product_units pu
                  where pu.id = p_unit_id and pu.product_id = p_product_id) then
    raise exception 'that shape does not belong to this item' using errcode = '23514';
  end if;
  if p_level is null or p_level < 0 then
    raise exception 'A level cannot be less than none' using errcode = '23514';
  end if;

  insert into public.product_low_stock_levels (product_id, product_unit_id, level)
  values (p_product_id, p_unit_id, p_level)
  on conflict (product_id, product_unit_id) do update set level = excluded.level;
end;
$$;

create or replace function public.clear_shape_low_stock(p_product_id uuid, p_unit_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store uuid;
begin
  select store_id into v_store from public.products where id = p_product_id;
  if v_store is null then
    raise exception 'No such item' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'Only somebody who manages products can change this' using errcode = '42501';
  end if;

  -- Removing the row puts that shape back under the shop's general level, which is not the same
  -- as setting it to zero — zero would mean "never warn".
  delete from public.product_low_stock_levels
   where product_id = p_product_id and product_unit_id = p_unit_id;
end;
$$;

grant execute on function public.set_shape_low_stock(uuid, uuid, numeric) to authenticated;
grant execute on function public.clear_shape_low_stock(uuid, uuid) to authenticated;

-- ─── 5. And the list of what is low now ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.low_stock_items(p_store_id uuid)
 RETURNS TABLE(product_id uuid, name text, on_hand qty, threshold numeric, specific boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with level as (
    select p.id, p.name,
           public.product_low_threshold(p.id) as threshold,
           -- "Specific" now means this item overrides the shop on at least one of its shapes.
           exists (select 1 from public.product_low_stock_levels l where l.product_id = p.id)
             as specific
      from public.products p
     where p.store_id = p_store_id
       and coalesce(p.status, 'active') = 'active'
       and public.is_store_member(p_store_id)
  )
  select l.id, l.name,
         coalesce((select sum(m.qty_delta) from public.stock_movements m
                    where m.product_id = l.id), 0)::qty,
         l.threshold,
         l.specific
    from level l
   where l.threshold is not null
     and coalesce((select sum(m.qty_delta) from public.stock_movements m
                    where m.product_id = l.id), 0) <= l.threshold
   order by
     -- Emptiest first, as a share of its own threshold: two crates left of a five is more urgent
     -- than forty of a fifty, and a flat sort by quantity would bury it.
     (coalesce((select sum(m.qty_delta) from public.stock_movements m
                 where m.product_id = l.id), 0)
      / nullif(l.threshold, 0)) nulls first,
     l.name;
$function$;
