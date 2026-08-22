-- =====================================================================================
-- 0030 — The public storefront
--
-- A marketplace landing page: shops, their categories and their products, browsable by anyone
-- without signing in — the Jumia/Amazon shape.
--
-- OPT-IN, DEFAULTING TO OFF. A shop's catalogue and prices are its own business, and publishing
-- them is a commercial decision its owner makes, not a default the software makes for them. A
-- competitor reading your price list is a real cost, and "it was on by default" is no answer.
-- Settings carries the switch.
--
-- WHAT IS EXPOSED, and what deliberately is not:
--
--   public    shop name, code, product names, categories, SELLING prices, bulk price bands,
--             and whether an item is in stock
--   never     cost, margin, exact stock counts, customers, debts, staff, sales, empties
--
-- Selling prices are what a shop puts on a shelf edge. Cost is what it paid, and the gap between
-- the two is the business itself. Exact stock counts are withheld for the same reason: "in
-- stock" is what a buyer needs; "1,183 pieces" tells a competitor the size of your operation.
-- =====================================================================================

alter table public.stores
  add column if not exists is_public boolean not null default false,
  add column if not exists public_description text;

create index if not exists stores_public_idx on public.stores (is_public) where is_public;

-- ─── Browse shops ───────────────────────────────────────────────────────────────────

create or replace function public.public_stores(
  p_query      text default null,
  p_after_name text default null,
  p_after_id   uuid default null,
  p_limit      int  default 24
)
returns table (
  id            uuid,
  name          text,
  code          text,
  description   text,
  product_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as term)
  select s.id, s.name, s.code, s.public_description,
         (select count(*) from public.products p
           where p.store_id = s.id and p.status = 'active')
  from public.stores s
  cross join q
  where s.is_public
    and s.onboarded_at is not null
    and (
      q.term is null
      or s.name ilike '%' || q.term || '%'
      or s.public_description ilike '%' || q.term || '%'
      or s.code = upper(q.term)
    )
    and (p_after_name is null
         or (s.name, s.id) > (p_after_name, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  order by s.name, s.id
  limit greatest(1, least(coalesce(p_limit, 24), 60));
$$;

-- ─── Browse products across every public shop ───────────────────────────────────────

create or replace function public.public_products(
  p_query       text default null,
  p_store_id    uuid default null,
  p_category    text default null,
  p_after_name  text default null,
  p_after_id    uuid default null,
  p_limit       int  default 24
)
returns table (
  id           uuid,
  name         text,
  category     text,
  store_id     uuid,
  store_name   text,
  store_code   text,
  unit_label   text,
  price        money_amt,
  has_bulk     boolean,
  in_stock     boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as term)
  select p.id,
         p.name,
         c.name,
         s.id,
         s.name,
         s.code,
         -- What a buyer would ask for: "Pack" rather than "12 pieces".
         coalesce(su.name, pk.name, p.base_unit),
         coalesce(su.price, pr.price),
         exists (select 1 from public.product_price_tiers t where t.product_id = p.id),
         -- A boolean, never the count. Whether you can buy it is the shopper's question; how
         -- much a shop holds is nobody else's.
         coalesce((select sum(m.qty_delta) from public.stock_movements m
                    where m.product_id = p.id), 0) > 0
  from public.products p
  cross join q
  join public.stores s on s.id = p.store_id
  left join public.product_categories c on c.id = p.category_id
  left join public.product_packs pk on pk.id = p.default_display_pack_id
  left join lateral (
    select su2.name, su2.price
    from public.product_sale_units su2
    where su2.product_id = p.id
    order by su2.sort_order, su2.base_qty desc
    limit 1
  ) su on true
  left join lateral (
    select pp.price from public.product_prices pp
    where pp.product_id = p.id
    order by (pp.pack_id is null)
    limit 1
  ) pr on true
  where s.is_public
    and s.onboarded_at is not null
    and p.status = 'active'
    -- Unconfirmed records are staff working notes, not a shopfront listing. Publishing them
    -- would put a half-entered product in front of the public before anyone checked it.
    and p.confirmed_at is not null
    and (p_store_id is null or p.store_id = p_store_id)
    and (p_category is null or c.name = p_category)
    and (
      q.term is null
      or p.name ilike '%' || q.term || '%'
      or c.name ilike '%' || q.term || '%'
      or s.name ilike '%' || q.term || '%'
      or similarity(p.name, q.term) > 0.25
    )
    and (p_after_name is null
         or (p.name, p.id) > (p_after_name, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  order by p.name, p.id
  limit greatest(1, least(coalesce(p_limit, 24), 60));
$$;

-- ─── Categories, for the browse rail ────────────────────────────────────────────────

create or replace function public.public_categories(p_store_id uuid default null)
returns table (name text, product_count bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.name, count(p.id)
  from public.product_categories c
  join public.stores s on s.id = c.store_id
  left join public.products p
         on p.category_id = c.id and p.status = 'active' and p.confirmed_at is not null
  where s.is_public
    and s.onboarded_at is not null
    and (p_store_id is null or c.store_id = p_store_id)
  group by c.name
  having count(p.id) > 0
  order by count(p.id) desc, c.name;
$$;

-- ─── One shop's public page ─────────────────────────────────────────────────────────

create or replace function public.public_store(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', s.id,
    'name', s.name,
    'code', s.code,
    'description', s.public_description,
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('name', t.name, 'count', t.product_count)
                       order by t.product_count desc)
      from public.public_categories(s.id) t
    ), '[]'::jsonb)
  )
  from public.stores s
  where s.code = upper(trim(p_code))
    and s.is_public
    and s.onboarded_at is not null;
$$;

/**
 * The bulk bands a shopper can see.
 *
 * Quantity and price only — the same ladder the seller configured, without the internal ids or
 * anything about cost. "Buy 5 or more and it is ₦4,450" is a reason to buy more; it gives away
 * nothing a shelf edge would not.
 */
create or replace function public.public_price_tiers(p_product_id uuid)
returns table (min_qty qty, max_qty qty, price money_amt)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.min_qty, t.max_qty, t.price
  from public.product_price_tiers t
  join public.products p on p.id = t.product_id
  join public.stores s on s.id = p.store_id
  where t.product_id = p_product_id
    and s.is_public
    and s.onboarded_at is not null
    and p.status = 'active'
  order by t.min_qty;
$$;

grant execute on function public.public_stores(text, text, uuid, int)                to anon, authenticated;
grant execute on function public.public_products(text, uuid, text, text, uuid, int)  to anon, authenticated;
grant execute on function public.public_categories(uuid)                             to anon, authenticated;
grant execute on function public.public_store(text)                                  to anon, authenticated;
grant execute on function public.public_price_tiers(uuid)                            to anon, authenticated;
