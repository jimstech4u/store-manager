-- =====================================================================================
-- 0015 — Product categories, and search across the things people actually look for
--
-- Search is not a convenience in a system this size. A distributor carrying 300 lines cannot
-- scroll to find "Eva 75cl" while a customer waits, and a counter serving several people at once
-- needs to find an unsettled order by customer name in seconds. Slow lookup is what pushes staff
-- back to paper.
--
-- Categories exist so that searching "water" returns every water product — the way a seller
-- actually thinks about their stock, rather than requiring the exact product name.
-- =====================================================================================

create table if not exists public.product_categories (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  unique (store_id, name)
);

create index if not exists product_categories_store_idx on public.product_categories (store_id);
create index if not exists product_categories_name_trgm
  on public.product_categories using gin (name gin_trgm_ops);

alter table public.products
  add column if not exists category_id uuid references public.product_categories (id) on delete set null;

create index if not exists products_category_idx on public.products (category_id);

alter table public.product_categories enable row level security;

create policy categories_read on public.product_categories
  for select to authenticated using (public.is_store_member(store_id));
create policy categories_write on public.product_categories
  for all to authenticated
  using (public.has_permission(store_id, 'products.manage'))
  with check (public.has_permission(store_id, 'products.manage'));

-- ─── Product search ─────────────────────────────────────────────────────────────────
--
-- Matches name, SKU and CATEGORY, so "water" finds every product filed under it even when the
-- word appears nowhere in the product's own name ("Eva 75cl"). Trigram similarity covers
-- misspellings, which matter more than usual here: this is typed one-handed, at speed, by
-- someone holding goods.

create or replace function public.search_products(
  p_store_id uuid,
  p_query    text default null,
  p_limit    int default 50
)
returns table (
  id             uuid,
  name           text,
  sku            text,
  base_unit      text,
  category_id    uuid,
  category_name  text,
  avg_unit_cost  unit_cost,
  cost_is_estimated boolean,
  on_hand        qty,
  pack_id        uuid,
  pack_name      text,
  pack_qty       qty,
  list_price     money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as term)
  select p.id,
         p.name,
         p.sku,
         p.base_unit,
         p.category_id,
         c.name,
         p.avg_unit_cost,
         p.cost_is_estimated,
         coalesce((select sum(m.qty_delta) from public.stock_movements m
                    where m.product_id = p.id), 0)::qty,
         pk.id,
         pk.name,
         pk.base_unit_qty,
         pr.price
  from public.products p
  cross join q
  left join public.product_categories c on c.id = p.category_id
  left join public.product_packs pk
         on pk.id = coalesce(p.default_display_pack_id,
                             (select id from public.product_packs
                               where product_id = p.id order by base_unit_qty limit 1))
  left join public.product_prices pr
         on pr.product_id = p.id
        and (pr.pack_id = pk.id or (pr.pack_id is null and pk.id is null))
  where p.store_id = p_store_id
    and p.status = 'active'
    and public.is_store_member(p_store_id)
    and (
      q.term is null
      or p.name ilike '%' || q.term || '%'
      or p.sku  ilike '%' || q.term || '%'
      or c.name ilike '%' || q.term || '%'
      or similarity(p.name, q.term) > 0.25
    )
  order by
    -- Exact-ish name matches first, then category matches, then fuzzy. Someone typing "eva"
    -- wants the product before every other item that merely shares its category.
    case
      when q.term is null then 1
      when p.name ilike q.term || '%' then 0
      when p.name ilike '%' || q.term || '%' then 1
      when c.name ilike '%' || q.term || '%' then 2
      else 3
    end,
    p.name
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

grant execute on function public.search_products(uuid, text, int) to authenticated;

-- ─── Sales / receipt search ─────────────────────────────────────────────────────────
--
-- Finds a past receipt by customer name, phone, note, or the receipt number itself. Needed for
-- the "what did they buy last time" question that comes up constantly at a counter, and for
-- tracing a disputed amount back to the sale that produced it.

create or replace function public.search_sales(
  p_store_id uuid,
  p_query    text default null,
  p_limit    int default 50
)
returns table (
  id            uuid,
  occurred_at   timestamptz,
  total         money_amt,
  paid          money_amt,
  customer_id   uuid,
  customer_name text,
  note          text,
  line_count    bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as term)
  select s.id,
         s.occurred_at,
         s.total,
         coalesce((select sum(pa.amount) from public.payment_allocations pa
                    where pa.sale_id = s.id), 0)::money_amt,
         s.store_customer_id,
         sc.display_name,
         s.note,
         (select count(*) from public.sale_lines sl where sl.sale_id = s.id)
  from public.sales s
  cross join q
  left join public.store_customers sc on sc.id = s.store_customer_id
  left join public.identities i on i.id = sc.identity_id
  where s.store_id = p_store_id
    and s.status = 'posted'
    and public.is_store_member(p_store_id)
    and (
      q.term is null
      or sc.display_name  ilike '%' || q.term || '%'
      or sc.business_name ilike '%' || q.term || '%'
      or i.phone like '%' || public.normalize_phone(q.term) || '%'
      or s.note ilike '%' || q.term || '%'
      or s.id::text ilike q.term || '%'
    )
  order by s.occurred_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

grant execute on function public.search_sales(uuid, text, int) to authenticated;
