-- =====================================================================================
-- 0160 — An order placed from the marketplace is a draft order, not a new thing
--
-- A shopper on the public side fills a basket and asks a shop for it. The shop looks at it and
-- either takes it or turns it down; if it takes it, it becomes a sale exactly as a sale made at the
-- counter does.
--
-- That is a DRAFT ORDER (0016) with one difference: who wrote it. Everything else already exists
-- and has been working for months — a code that can be read aloud, lines with their own prices,
-- `settle_draft_order` to make it real through `settle_sale`, `cancel_draft_order` to drop it. An
-- `orders` table would be a second way to mean the same thing, and the day the two disagreed about
-- what a shop is owed would be the day nobody could say which was right.
--
-- So: one column saying where an order came from, and two reads for the shop's side of it.
--
--   accept  → settle_draft_order  (already exists; becomes a sale, moves stock, takes the money)
--   reject  → cancel_draft_order  (already exists)
-- =====================================================================================

alter table public.draft_orders
  add column if not exists source text not null default 'counter'
    check (source in ('counter', 'online'));

comment on column public.draft_orders.source is
  'counter = written by staff at the till. online = asked for by a shopper from the marketplace, and waiting on the shop to accept or decline it.';

/*
 * Which orders are waiting on this shop.
 *
 * Only `online` ones: a draft written at the counter is not waiting for a decision, it is somebody's
 * open tab, and mixing the two would put a colleague's half-finished sale in a queue of requests
 * from strangers.
 */
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
    and public.has_permission(p_store_id, 'sell')
  order by d.created_at asc
$$;

comment on function public.pending_online_orders(uuid) is
  'Orders a shopper has asked for and the shop has not yet accepted or declined. Sell permission required.';

/*
 * Just the number, for the badge on the Sell screen.
 *
 * Its own function rather than counting the rows of the list, because the badge is read on every
 * visit to the till and the list is not — and a badge that costs a full listing is a badge that
 * makes the busiest screen in the app slower.
 */
create or replace function public.pending_online_orders_count(p_store_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(count(*), 0)::int
  from public.draft_orders d
  where d.store_id = p_store_id
    and d.status = 'open'
    and d.source = 'online'
    and public.has_permission(p_store_id, 'sell')
$$;

grant execute on function public.pending_online_orders(uuid) to authenticated;
grant execute on function public.pending_online_orders_count(uuid) to authenticated;
