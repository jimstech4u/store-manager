-- 0228 - Lists filter on the server
--
-- "filters on Stock, Count, Yard, Sales, Money, People" and "export the filtered list". A filter
-- applied on the phone only ever sees the page it has loaded: "who owes me" over the first thirty
-- customers is not who owes me. So the three paged lists take an optional filter, applied BEFORE
-- the page is cut, and the keyset cursor pages through the filtered rows. An export walks the same
-- pages to the end, so it holds every matching row, not the loaded ones.
--
-- Each is dropped and re-created with the new parameters LAST and defaulted: every existing caller
-- is untouched, and there is one signature per function (the overload trap).
--
--   list_products(…, p_filter)   'low' running low · 'out' none left · 'no_price' nothing priced
--   list_customers(…, p_filter)  'owes' · 'credit' (the shop owes them) · 'empties' (holds ours)
--   list_sales(…, p_filter, p_from, p_to)  'unpaid' · 'paid', within a date range

drop function if exists public.list_products(uuid, text, uuid, integer);
create or replace function public.list_products(
  p_store_id uuid,
  p_after_name text default null,
  p_after_id uuid default null,
  p_limit integer default 30,
  p_filter text default null
)
returns table(id uuid, name text, sku text, base_unit text, category_id uuid, category_name text,
              avg_unit_cost unit_cost, cost_is_estimated boolean, on_hand qty, pack_id uuid,
              pack_name text, pack_qty qty, list_price money_amt, low_stock_level numeric)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select x.* from (
    select p.id, p.name, p.sku, p.base_unit, p.category_id, c.name as category_name,
           p.avg_unit_cost, p.cost_is_estimated,
           coalesce((select sum(m.qty_delta) from public.stock_movements m
                      where m.product_id = p.id), 0)::qty as on_hand,
           pk.id as pack_id, pk.name as pack_name, pk.base_unit_qty as pack_qty, pr.price as list_price,
           coalesce(p.low_stock_threshold, ss.low_stock_threshold) as low_stock_level
    from public.products p
    left join public.product_categories c on c.id = p.category_id
    left join public.store_settings ss on ss.store_id = p.store_id
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
      and (p_after_name is null or (p.name, p.id) > (p_after_name, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  ) x
  where p_filter is null or p_filter = 'all'
     or (p_filter = 'out' and x.on_hand <= 0)
     or (p_filter = 'low' and x.on_hand > 0 and x.low_stock_level is not null and x.on_hand <= x.low_stock_level)
     or (p_filter = 'no_price' and not exists (
           select 1 from public.product_units pu
            where pu.product_id = x.id and pu.is_sold and pu.sell_price > 0))
  order by x.name, x.id
  limit greatest(1, least(coalesce(p_limit, 30), 100));
$function$;

drop function if exists public.list_customers(uuid, text, text, uuid, integer);
create or replace function public.list_customers(
  p_store_id uuid,
  p_query text default null,
  p_after_name text default null,
  p_after_id uuid default null,
  p_limit integer default 30,
  p_filter text default null
)
returns table(id uuid, identity_id uuid, display_name text, business_name text, phone text, balance money_amt)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  with q as (
    select nullif(trim(coalesce(p_query, '')), '') as term
  ),
  matched as (
    select sc.id, sc.identity_id, sc.display_name, sc.business_name, i.phone,
           public.customer_balance_total(sc.id) as balance,
           case
             when q.term is null then 5
             when i.phone = public.normalize_phone(q.term) then 0
             when lower(sc.display_name) = lower(q.term) then 1
             when sc.display_name ilike q.term || '%' then 2
             when sc.display_name ilike '%' || q.term || '%' then 3
             when i.phone like '%' || public.normalize_phone(q.term) || '%' then 3
             else 4
           end as rank,
           case
             when q.term is null then 0
             else similarity(sc.display_name, q.term)
           end as score
      from public.store_customers sc
      cross join q
      join public.identities i on i.id = sc.identity_id
     where sc.store_id = p_store_id
       and public.is_store_member(p_store_id)
       and (
         q.term is null
         or i.phone like '%' || public.normalize_phone(q.term) || '%'
         or sc.display_name  ilike '%' || q.term || '%'
         or sc.business_name ilike '%' || q.term || '%'
         or similarity(sc.display_name, q.term) > 0.3
       )
       and (
         p_after_name is null
         or (sc.display_name, sc.id) > (p_after_name, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
       )
       and (
         p_filter <> 'empties' or p_filter is null
         or exists (
           select 1 from public.customer_empties ce
            where ce.store_customer_id = sc.id and coalesce(ce.side, 'they_hold') = 'they_hold'
            group by ce.product_unit_id
           having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0)
       )
  )
  select m.id, m.identity_id, m.display_name, m.business_name, m.phone, m.balance
    from matched m
   where p_filter is null or p_filter in ('all', 'empties')
      or (p_filter = 'owes' and m.balance > 0.005)
      or (p_filter = 'credit' and m.balance < -0.005)
   order by m.rank, m.score desc, m.display_name, m.id
   limit greatest(1, least(coalesce(p_limit, 30), 100));
$function$;

drop function if exists public.list_sales(uuid, text, timestamptz, uuid, integer);
create or replace function public.list_sales(
  p_store_id uuid,
  p_query text default null,
  p_after_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 30,
  p_filter text default null,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table(id uuid, occurred_at timestamptz, total money_amt, paid money_amt, outstanding money_amt,
              customer_id uuid, customer_name text, note text, line_count bigint)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as term)
  select x.* from (
    select s.id,
           s.occurred_at,
           s.total,
           coalesce(pa.paid, 0)::money_amt as paid,
           (s.total - coalesce(pa.paid, 0))::money_amt as outstanding,
           s.store_customer_id as customer_id,
           sc.display_name as customer_name,
           s.note,
           (select count(*) from public.sale_lines sl where sl.sale_id = s.id) as line_count
    from public.sales s
    cross join q
    left join public.store_customers sc on sc.id = s.store_customer_id
    left join public.identities i on i.id = sc.identity_id
    left join lateral (
      select sum(amount) as paid from public.payment_allocations where sale_id = s.id
    ) pa on true
    where s.store_id = p_store_id
      and s.status = 'posted'
      and public.is_store_member(p_store_id)
      and (
        q.term is null
        or sc.display_name  ilike '%' || q.term || '%'
        or sc.business_name ilike '%' || q.term || '%'
        or i.phone like '%' || public.normalize_phone(q.term) || '%'
        or s.note ilike '%' || q.term || '%'
      )
      and (p_from is null or s.occurred_at >= p_from)
      and (p_to   is null or s.occurred_at <  p_to)
      and (p_after_at is null or (s.occurred_at, s.id) < (p_after_at, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  ) x
  where p_filter is null or p_filter = 'all'
     or (p_filter = 'unpaid' and x.outstanding > 0.005)
     or (p_filter = 'paid' and x.outstanding <= 0.005)
  order by x.occurred_at desc, x.id desc
  limit greatest(1, least(coalesce(p_limit, 30), 100));
$function$;

grant execute on function public.list_products(uuid, text, uuid, integer, text) to authenticated;
grant execute on function public.list_customers(uuid, text, text, uuid, integer, text) to authenticated;
grant execute on function public.list_sales(uuid, text, timestamptz, uuid, integer, text, timestamptz, timestamptz) to authenticated;

notify pgrst, 'reload schema';
