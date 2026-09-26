-- =====================================================================================
-- 0171 — Low stock: one general rule, and the items that are exceptions to it
--
-- A shop runs out of things it meant to reorder. The stock screen shows what is there and says
-- nothing about what is nearly gone, so "nearly gone" is a thing somebody has to notice, remember,
-- and act on between serving customers.
--
-- TWO LEVELS, BECAUSE ONE IS ALWAYS WRONG SOMEWHERE. A single figure across a whole shop is either
-- so low it never fires for the fast-moving lines or so high that the slow ones shout constantly.
-- So: a general rule that covers everything, and specific items that keep their own number. The
-- specific one wins wherever it is set — that is the whole of the rule, and it is the shape a shop
-- already thinks in ("keep at least a pallet of Gulder; everything else, tell me at five").
--
-- IN BASE UNITS, like every other quantity in this database. The screens say it in whatever shape
-- the shop counts in.
--
-- NULL MEANS OFF. Not zero: zero is a real threshold that means "tell me when there are none at
-- all", which a shop selling something rare genuinely wants. A feature switched off and a feature
-- set to nought are different answers and the column can hold both.
-- =====================================================================================

alter table public.store_settings
  add column if not exists low_stock_threshold numeric;

comment on column public.store_settings.low_stock_threshold is
  'The shop-wide "running low" level in BASE units. NULL is off — distinct from 0, which means "tell me only when there are none".';

alter table public.products
  add column if not exists low_stock_threshold numeric;

comment on column public.products.low_stock_threshold is
  'This item''s own "running low" level in base units, overriding the shop-wide one. NULL means "use the shop''s rule" — which is why it is nullable rather than defaulted.';

/*
 * WHAT COUNTS AS LOW, in one place.
 *
 * Every screen that wants to show this asks the same question, and a rule copied into three
 * queries is three rules the day one of them is edited. The effective threshold is the item's own
 * if it has one, the shop's otherwise, and nothing at all if neither is set.
 */
create or replace function public.low_stock_level(p_product_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(p.low_stock_threshold, ss.low_stock_threshold)
    from public.products p
    left join public.store_settings ss on ss.store_id = p.store_id
   where p.id = p_product_id
$$;

/*
 * WHAT IS RUNNING LOW, for the stock screen and anything else that asks.
 *
 * On hand is the sum of every movement, which is how the rest of this database answers "how many
 * are there" — not a cached figure that can drift from the movements that made it.
 *
 * `at_or_below` rather than `below`: a shop that says "tell me at five" means five is already the
 * moment to act, not the moment after.
 */
create or replace function public.low_stock_items(p_store_id uuid)
returns table (
  product_id  uuid,
  name        text,
  on_hand     qty,
  threshold   numeric,
  specific    boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with level as (
    select p.id, p.name,
           coalesce(p.low_stock_threshold, ss.low_stock_threshold) as threshold,
           p.low_stock_threshold is not null as specific
      from public.products p
      left join public.store_settings ss on ss.store_id = p.store_id
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
$$;

comment on function public.low_stock_items(uuid) is
  'Active items at or below their effective low-stock level — their own if set, otherwise the shop''s. Emptiest first, as a share of their own threshold.';

/* The shop's own rule, set from Settings. Its own function so the write is one statement and the
   permission is the one that guards every other shop-wide setting. */
create or replace function public.set_low_stock_threshold(p_store_id uuid, p_level numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_permission(p_store_id, 'store.settings') then
    raise exception 'Only an owner or manager can change this' using errcode = '42501';
  end if;
  if p_level is not null and p_level < 0 then
    raise exception 'A level cannot be less than none';
  end if;

  insert into public.store_settings (store_id, low_stock_threshold)
  values (p_store_id, p_level)
  on conflict (store_id) do update set low_stock_threshold = excluded.low_stock_threshold,
                                       updated_at = now();
end;
$$;

/* One item's exception. `products.manage`, because it is a fact about the product. */
create or replace function public.set_product_low_stock(p_product_id uuid, p_level numeric)
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
    raise exception 'No such item';
  end if;
  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'Only somebody who manages products can change this' using errcode = '42501';
  end if;
  if p_level is not null and p_level < 0 then
    raise exception 'A level cannot be less than none';
  end if;

  update public.products set low_stock_threshold = p_level where id = p_product_id;
end;
$$;

grant execute on function public.low_stock_level(uuid) to authenticated;
grant execute on function public.low_stock_items(uuid) to authenticated;
grant execute on function public.set_low_stock_threshold(uuid, numeric) to authenticated;
grant execute on function public.set_product_low_stock(uuid, numeric) to authenticated;
