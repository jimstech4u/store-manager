-- =====================================================================================
-- 0165 — A glimpse of the order, in the queue
--
-- The queue said "2 items · ₦30,000" and offered Accept. It now opens the order instead, which is
-- right — but a list of totals still tells a shop nothing about which order is which. Two orders
-- for ₦30,000 are indistinguishable, and the only way to tell them apart is to open both.
--
-- So each row carries the first few product names. Enough to recognise an order at a glance and
-- decide which one to open; not enough to answer it, which happens on its own screen with the
-- quantities, the prices and the stock in front of you.
-- =====================================================================================

/*
 * DROPPED FIRST, because the row this returns has gained a column and Postgres will not let a
 * `create or replace` change the shape of one. Dropping and recreating a `security definer`
 * function loses its grants with it, so the grant is restated at the foot of this file — without
 * it every caller gets "permission denied" and the queue silently empties.
 */
drop function if exists public.pending_online_orders(uuid);

create or replace function public.pending_online_orders(p_store_id uuid)
returns table (
  id            uuid,
  code          text,
  label         text,
  customer_name text,
  lines         bigint,
  total         money_amt,
  created_at    timestamptz,
  preview       text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.code, d.label,
         coalesce(d.online_name, sc.display_name, sc.business_name),
         (select count(*) from public.draft_order_lines l where l.draft_order_id = d.id),
         coalesce((select sum(l.line_total) from public.draft_order_lines l where l.draft_order_id = d.id), 0)
           + d.fee_amount,
         d.created_at,
         /*
          * The first three, in the order they were added, with the quantity — "6 × American Cola
          * PET 60cl" is what makes one order recognisable from another. Three because a card that
          * lists everything is the order screen with worse typography; the count beside it already
          * says how much more there is.
          */
         (
           select string_agg(x.bit, ', ' order by x.position)
           from (
             select l.position,
                    trim(to_char(l.entered_qty, 'FM999999990.999')) || ' × ' || p.name as bit
             from public.draft_order_lines l
             join public.products p on p.id = l.product_id
             where l.draft_order_id = d.id
             order by l.position
             limit 3
           ) x
         )
  from public.draft_orders d
  left join public.store_customers sc on sc.id = d.store_customer_id
  where d.store_id = p_store_id
    and d.status = 'open'
    and d.source = 'online'
    -- The caller must actually work here. Read from auth.uid(), never from an argument.
    and public.has_permission(p_store_id, 'sales.record')
  order by d.created_at asc
$$;

comment on function public.pending_online_orders(uuid) is
  'Orders a shopper has asked for and the shop has not yet answered, each with a glimpse of what is on it. Sell permission required.';

grant execute on function public.pending_online_orders(uuid) to authenticated;
