-- =====================================================================================
-- 0162 — The orders queue asked for a permission that does not exist
--
-- 0160 gated both reads on `has_permission(store, 'sell')`. There is no permission called `sell`.
-- The codes are `sales.record`, `stock.receive` and so on, and `has_permission` answers a code it
-- has never heard of with a plain `false` — correctly, since nobody has been granted it.
--
-- So both functions returned nothing, to everybody, always. And the failure was INVISIBLE: an empty
-- queue renders as "No orders waiting", which is exactly what a shop with no orders should see, and
-- a badge of zero draws nothing at all. A shop could have taken a week of orders and seen a quiet
-- screen the whole time. It was found by placing a real order and then looking for it as the shop —
-- reading the code again would not have shown it, because the code reads as though it works.
--
-- Accepting an order opens it at the till and the next thing that happens is money and stock, so the
-- permission it asks for is the one the till itself asks for.
-- =====================================================================================

create or replace function public.pending_online_orders(p_store_id uuid)
returns table (
  id            uuid,
  code          text,
  label         text,
  customer_name text,
  lines         bigint,
  total         money_amt,
  created_at    timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.code, d.label,
         coalesce(sc.display_name, sc.business_name),
         (select count(*) from public.draft_order_lines l where l.draft_order_id = d.id),
         coalesce((select sum(l.line_total) from public.draft_order_lines l where l.draft_order_id = d.id), 0)
           + d.fee_amount,
         d.created_at
  from public.draft_orders d
  left join public.store_customers sc on sc.id = d.store_customer_id
  where d.store_id = p_store_id
    and d.status = 'open'
    and d.source = 'online'
    -- The caller must actually work here. Read from auth.uid(), never from an argument.
    and public.has_permission(p_store_id, 'sales.record')
  order by d.created_at asc
$$;

create or replace function public.pending_online_orders_count(p_store_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.draft_orders d
  where d.store_id = p_store_id
    and d.status = 'open'
    and d.source = 'online'
    and public.has_permission(p_store_id, 'sales.record')
$$;
