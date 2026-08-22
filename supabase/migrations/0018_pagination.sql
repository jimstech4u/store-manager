-- =====================================================================================
-- 0018 — Cursor pagination for the lists that grow without bound
--
-- Keyset ("seek") pagination, following the approach academix-web uses: a cursor made of the
-- last row's sort key rather than an OFFSET.
--
-- OFFSET is wrong here specifically, not just slower. A shop inserts sales continuously, so
-- between fetching page 1 and page 2 new rows arrive at the top and every later row shifts down
-- — the reader silently sees a row twice and misses another. In a list of money that is not a
-- cosmetic glitch.
--
-- Each cursor carries the sort column AND the id, because two sales can share a timestamp and a
-- cursor that cannot break the tie either loops or skips.
-- =====================================================================================

-- ─── Products, for browsing a long catalogue ────────────────────────────────────────
--
-- Only the no-search case paginates. A fuzzy search is relevance-ordered and capped: you refine
-- a search rather than page through it, and relevance order cannot be expressed as a keyset.

create or replace function public.list_products(
  p_store_id   uuid,
  p_after_name text default null,
  p_after_id   uuid default null,
  p_limit      int  default 30
)
returns table (
  id                uuid,
  name              text,
  sku               text,
  base_unit         text,
  category_id       uuid,
  category_name     text,
  avg_unit_cost     unit_cost,
  cost_is_estimated boolean,
  on_hand           qty,
  pack_id           uuid,
  pack_name         text,
  pack_qty          qty,
  list_price        money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.name, p.sku, p.base_unit, p.category_id, c.name,
         p.avg_unit_cost, p.cost_is_estimated,
         coalesce((select sum(m.qty_delta) from public.stock_movements m
                    where m.product_id = p.id), 0)::qty,
         pk.id, pk.name, pk.base_unit_qty, pr.price
  from public.products p
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
    -- (name, id) as a tuple: the id breaks ties between identically named products, which a
    -- name-only cursor would either loop on or skip past.
    and (p_after_name is null or (p.name, p.id) > (p_after_name, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  order by p.name, p.id
  limit greatest(1, least(coalesce(p_limit, 30), 100));
$$;

-- ─── Sales / receipts ───────────────────────────────────────────────────────────────

create or replace function public.list_sales(
  p_store_id   uuid,
  p_query      text default null,
  p_after_at   timestamptz default null,
  p_after_id   uuid default null,
  p_limit      int default 30
)
returns table (
  id            uuid,
  occurred_at   timestamptz,
  total         money_amt,
  paid          money_amt,
  outstanding   money_amt,
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
         coalesce(pa.paid, 0)::money_amt,
         (s.total - coalesce(pa.paid, 0))::money_amt,
         s.store_customer_id,
         sc.display_name,
         s.note,
         (select count(*) from public.sale_lines sl where sl.sale_id = s.id)
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
    -- Newest first, so the cursor walks DOWN: strictly less than the last row seen.
    and (p_after_at is null or (s.occurred_at, s.id) < (p_after_at, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  order by s.occurred_at desc, s.id desc
  limit greatest(1, least(coalesce(p_limit, 30), 100));
$$;

-- ─── Customers ──────────────────────────────────────────────────────────────────────

create or replace function public.list_customers(
  p_store_id   uuid,
  p_query      text default null,
  p_after_name text default null,
  p_after_id   uuid default null,
  p_limit      int default 30
)
returns table (
  id            uuid,
  identity_id   uuid,
  display_name  text,
  business_name text,
  phone         text,
  balance       money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as term)
  select sc.id, sc.identity_id, sc.display_name, sc.business_name, i.phone,
         public.customer_balance_total(sc.id)
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
    and (p_after_name is null or (sc.display_name, sc.id) > (p_after_name, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  order by sc.display_name, sc.id
  limit greatest(1, least(coalesce(p_limit, 30), 100));
$$;

-- ─── Activity feed ──────────────────────────────────────────────────────────────────
--
-- The change log is the longest list in the product — every stock movement, payment and edit
-- forever — so it needs a cursor more than anything else. Its rows come from three tables with
-- no shared id, so the cursor is the timestamp alone; ties are accepted here because the feed is
-- read, not reconciled against.

create or replace function public.activity_feed_page(
  p_store_id uuid,
  p_before   timestamptz default null,
  p_limit    int default 50
)
returns table (
  at        timestamptz,
  source    text,
  kind      text,
  summary   text,
  amount    money_amt,
  qty       qty,
  ref_table text,
  ref_id    uuid,
  actor     uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from (
    select m.occurred_at as at, 'stock'::text as source, m.kind as kind, p.name as summary,
           null::money_amt as amount, m.qty_delta as qty, m.ref_table as ref_table,
           m.ref_id as ref_id, m.created_by as actor
    from public.stock_movements m
    join public.products p on p.id = m.product_id
    where m.store_id = p_store_id and (p_before is null or m.occurred_at < p_before)

    union all

    select pay.occurred_at, 'payment'::text, pay.method,
           coalesce(sc.display_name, 'Walk-in'),
           case when pay.direction = 'in' then pay.amount else -pay.amount end,
           null::qty, 'payments'::text, pay.id, pay.created_by
    from public.payments pay
    left join public.store_customers sc on sc.id = pay.store_customer_id
    where pay.store_id = p_store_id and (p_before is null or pay.occurred_at < p_before)

    union all

    select a.at, 'change'::text, a.table_name || ':' || a.op,
           coalesce(a.reason, a.table_name), null::money_amt, null::qty,
           a.table_name, a.record_id, a.actor
    from public.audit_log a
    where a.store_id = p_store_id and (p_before is null or a.at < p_before)
  ) feed
  where public.is_store_member(p_store_id)
  order by at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

grant execute on function public.list_products(uuid, text, uuid, int)                   to authenticated;
grant execute on function public.list_sales(uuid, text, timestamptz, uuid, int)         to authenticated;
grant execute on function public.list_customers(uuid, text, text, uuid, int)            to authenticated;
grant execute on function public.activity_feed_page(uuid, timestamptz, int)             to authenticated;
