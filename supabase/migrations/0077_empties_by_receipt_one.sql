-- 0077 — `empties_by_receipt` can be asked about ONE receipt
--
-- The settle screen is a pushed page, not a sheet — a form that records money survives a rotation
-- and a reload, which a sheet's local state does not. A page is reached by id, and per this
-- project's navigation rule a push carries an id and an intent, never a record: what it needs is a
-- database fallback that can answer for one sale, because `isProvided` is false on a cold start and
-- on a deep link.
--
-- DROPPED AND RECREATED, NOT `create or replace`.
--
-- Adding a parameter to a function through `create or replace` does not replace it — it creates a
-- SECOND overload, and PostgREST then answers 300 Multiple Choices to every call because it cannot
-- tell which one a request means. That is exactly how 0058 stopped the till saving. The old
-- signature goes first, and the live overload count is checked at the bottom of this file.

drop function if exists public.empties_by_receipt(uuid, uuid, int);

create function public.empties_by_receipt(
  p_store_id    uuid,
  p_customer_id uuid default null,
  p_limit       int default 50,
  -- One receipt, for the page that settles it.
  p_sale_id     uuid default null
)
returns table (
  sale_id           uuid,
  occurred_at       timestamptz,
  store_customer_id uuid,
  customer_name     text,
  sale_total        money_amt,
  expected          jsonb,
  outstanding_units qty,
  pool_outstanding  qty,
  held              money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with mine as (
    select d.ref_id as sale_id,
           d.store_customer_id,
           d.empties_category_id,
           sum(d.qty_units) as units
      from public.deposit_ledger d
     where d.store_id = p_store_id
       and d.direction = 'collected'
       and d.ref_table = 'sales'
       and d.ref_id is not null
       and (p_customer_id is null or d.store_customer_id = p_customer_id)
       and (p_sale_id is null or d.ref_id = p_sale_id)
     group by d.ref_id, d.store_customer_id, d.empties_category_id
    having sum(d.qty_units) > 0
  )
  select s.id,
         s.occurred_at,
         m.store_customer_id,
         coalesce(sc.display_name, 'Walk-in'),
         s.total,
         jsonb_agg(
           jsonb_build_object(
             'category_id', ec.id,
             'category', ec.name,
             'kind', ec.kind,
             'units', m.units,
             'suggested_deposit', ec.deposit
           ) order by ec.name
         ),
         sum(m.units)::qty,
         -- What this customer owes across every receipt, so a return recorded at the account level
         -- is visible here instead of silently disagreeing with it.
         coalesce(
           (select sum(public.empties_outstanding(m.store_customer_id, x.empties_category_id))
              from (select distinct empties_category_id from mine m2
                     where m2.store_customer_id = m.store_customer_id) x),
           0
         )::qty,
         coalesce((select sum(h.amount) from public.deposit_holdings h
                    where h.ref_table = 'sales' and h.ref_id = s.id), 0)::money_amt
    from mine m
    join public.sales s on s.id = m.sale_id
    join public.empties_categories ec on ec.id = m.empties_category_id
    left join public.store_customers sc on sc.id = m.store_customer_id
   where public.is_store_member(p_store_id)
   group by s.id, s.occurred_at, m.store_customer_id, sc.display_name, s.total
   order by s.occurred_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$fn$;

revoke all on function public.empties_by_receipt(uuid, uuid, int, uuid) from public;
grant execute on function public.empties_by_receipt(uuid, uuid, int, uuid) to authenticated;

-- ─── What a product has out ─────────────────────────────────────────────────────────
--
-- The stock screen knows what is on the shelf and what it cost, and says nothing about the
-- containers that went out with it — so an item whose crates are all in customers' yards looks
-- identical to one whose crates are stacked out the back. For a shop whose containers are worth
-- more than a day's takings, that is the more urgent number.
--
-- Answered through the pools a product belongs to, because that is where the obligation lives: a
-- Gulder bottle and a Star bottle are the same NBL bottle to everyone involved. So this is "what is
-- out in the pools this product uses", which is the true and checkable answer — not "how many
-- Gulder bottles specifically", which nobody can know once the pool is shared.

create or replace function public.product_empties(p_product_id uuid)
returns table (
  category_id      uuid,
  category         text,
  kind             text,
  qty_per_base_unit qty,
  suggested_deposit money_amt,
  units_out        qty,
  customers_out    int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select ec.id,
         ec.name,
         ec.kind,
         pr.qty_per_base_unit,
         ec.deposit,
         coalesce(sum(d.qty_units), 0)::qty,
         count(distinct d.store_customer_id)::int
    from public.product_returnables pr
    join public.empties_categories ec on ec.id = pr.empties_category_id
    join public.products p on p.id = pr.product_id
    left join public.deposit_ledger d
           on d.empties_category_id = ec.id
          and d.direction = 'collected'
   where pr.product_id = p_product_id
     and public.is_store_member(p.store_id)
   group by ec.id, ec.name, ec.kind, pr.qty_per_base_unit, ec.deposit
   order by ec.name;
$fn$;

revoke all on function public.product_empties(uuid) from public;
grant execute on function public.product_empties(uuid) to authenticated;

-- ─── The overload check the 0058 outage taught us to run ────────────────────────────

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_proc pr
    join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'empties_by_receipt';

  if n <> 1 then
    raise exception 'empties_by_receipt has % overloads; PostgREST answers 300 to every call', n;
  end if;
end;
$$;
