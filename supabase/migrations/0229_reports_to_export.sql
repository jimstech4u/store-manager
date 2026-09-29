-- 0229 - Reports to export, the way a bank gives a statement
--
-- "we should be able to export based on report, like all I have counted today, all low, all still
-- in stock, who is owing me, who I owe, set a range based on amount owing me, who are the people
-- that have paid me, when they did and all of that ... just like a bank fintech does."
--
-- Each is one server question with its filters, returning every matching row (no paging: a report is
-- read whole). Stock and counts need membership; anything about money needs `reports.view`, the same
-- permission the Reports screen asks for — what customers owe is the owner's business.
--
--   report_counts(store, from, to)                   every shelf count in a period, who, and the difference
--   report_balances(store, side, min, max)           who owes / who is owed, within an amount range,
--                                                    with their last sale and last payment
--   report_payments(store, from, to, direction)      money in (and given back) in a period: who, how, when
--   report_empties_holders(store)                    who holds the shop's containers, per product and shape
--   list_products gains filter 'in_stock'            everything with some on the shelf

create or replace function public.report_counts(p_store_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  product_id uuid, product text, base_unit text, counted_at timestamptz, counted_by text,
  expected qty, counted qty, difference qty
)
language sql
stable security definer
set search_path = public, pg_temp
as $fn$
  select p.id, p.name, p.base_unit, sp.counted_at,
         coalesce(public.member_name(sp.store_id, sp.counted_by), 'Someone'),
         coalesce(sp.expected_at_count, sp.expected_closing_qty)::qty,
         sp.actual_closing_qty::qty,
         coalesce(sp.variance_qty, 0)::qty
    from public.stock_periods sp
    join public.products p on p.id = sp.product_id
   where sp.store_id = p_store_id
     and public.is_store_member(p_store_id)
     and sp.counted_at is not null
     and sp.actual_closing_qty is not null
     and (p_from is null or sp.counted_at >= p_from)
     and (p_to   is null or sp.counted_at <  p_to)
   order by sp.counted_at desc, p.name;
$fn$;

create or replace function public.report_balances(
  p_store_id uuid,
  p_side text default 'owes',
  p_min numeric default null,
  p_max numeric default null
)
returns table (
  customer_id uuid, name text, business text, phone text, balance money_amt,
  last_sale_at timestamptz, last_payment_at timestamptz
)
language sql
stable security definer
set search_path = public, pg_temp
as $fn$
  with b as (
    select sc.id, sc.display_name, sc.business_name, i.phone,
           public.customer_balance_total(sc.id) as balance
      from public.store_customers sc
      join public.identities i on i.id = sc.identity_id
     where sc.store_id = p_store_id
       and public.has_permission(p_store_id, 'reports.view')
       and coalesce(sc.status, 'active') = 'active'
  )
  select b.id, b.display_name, b.business_name, b.phone, b.balance,
         (select max(s.occurred_at) from public.sales s
           where s.store_customer_id = b.id and s.status = 'posted'),
         (select max(pm.occurred_at) from public.payments pm
           where pm.store_customer_id = b.id and pm.direction = 'in')
    from b
   where (
           (p_side = 'owes'  and b.balance > 0.005)
        or (p_side = 'owed'  and b.balance < -0.005)
        or (p_side = 'clear' and abs(b.balance) <= 0.005)
        or (p_side = 'all')
         )
     -- The range is on the size of the figure, whichever way it runs: "owes between 10k and 50k".
     and (p_min is null or abs(b.balance) >= p_min)
     and (p_max is null or abs(b.balance) <= p_max)
   order by abs(b.balance) desc, b.display_name;
$fn$;

create or replace function public.report_payments(
  p_store_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_direction text default 'in'
)
returns table (
  payment_id uuid, occurred_at timestamptz, customer_id uuid, customer text, phone text,
  amount money_amt, method text, reference text, direction text, recorded_by text
)
language sql
stable security definer
set search_path = public, pg_temp
as $fn$
  select pm.id, pm.occurred_at, pm.store_customer_id, coalesce(sc.display_name, 'Walk-in'), i.phone,
         pm.amount, pm.method, pm.reference, pm.direction,
         coalesce(public.member_name(pm.store_id, pm.created_by), 'Someone')
    from public.payments pm
    left join public.store_customers sc on sc.id = pm.store_customer_id
    left join public.identities i on i.id = sc.identity_id
   where pm.store_id = p_store_id
     and public.has_permission(p_store_id, 'reports.view')
     and (p_direction is null or p_direction = 'all' or pm.direction = p_direction)
     and (p_from is null or pm.occurred_at >= p_from)
     and (p_to   is null or pm.occurred_at <  p_to)
     -- A payment taken back is not money the shop has: both it and its reversal are left out.
     and pm.reverses_payment_id is null
     and not exists (select 1 from public.payments r where r.reverses_payment_id = pm.id)
   order by pm.occurred_at desc;
$fn$;

create or replace function public.report_empties_holders(p_store_id uuid)
returns table (
  customer_id uuid, customer text, phone text, product text, shape text, shape_plural text,
  maker text, owed qty
)
language sql
stable security definer
set search_path = public, pg_temp
as $fn$
  select sc.id, sc.display_name, i.phone, p.name, su.name, su.plural,
         (select c.name from public.product_category_links l
            join public.product_categories c on c.id = l.category_id
           where l.product_id = p.id and coalesce(c.status, 'active') = 'active'
           order by c.name limit 1),
         sum(case when ce.direction = 'out' then ce.qty else -ce.qty end)::qty
    from public.customer_empties ce
    join public.store_customers sc on sc.id = ce.store_customer_id
    join public.identities i on i.id = sc.identity_id
    join public.products p on p.id = ce.product_id
    join public.product_units pu on pu.id = ce.product_unit_id
    join public.store_units su on su.id = pu.store_unit_id
   where ce.store_id = p_store_id
     and public.is_store_member(p_store_id)
     and coalesce(ce.side, 'they_hold') = 'they_hold'
   group by sc.id, sc.display_name, i.phone, p.id, p.name, su.name, su.plural
  having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0
   order by sc.display_name, p.name;
$fn$;

grant execute on function public.report_counts(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.report_balances(uuid, text, numeric, numeric) to authenticated;
grant execute on function public.report_payments(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.report_empties_holders(uuid) to authenticated;

-- Everything with some on the shelf: the live definition from 0228 with one condition added.
CREATE OR REPLACE FUNCTION public.list_products(p_store_id uuid, p_after_name text DEFAULT NULL::text, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 30, p_filter text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, name text, sku text, base_unit text, category_id uuid, category_name text, avg_unit_cost unit_cost, cost_is_estimated boolean, on_hand qty, pack_id uuid, pack_name text, pack_qty qty, list_price money_amt, low_stock_level numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
     or (p_filter = 'in_stock' and x.on_hand > 0)
     or (p_filter = 'low' and x.on_hand > 0 and x.low_stock_level is not null and x.on_hand <= x.low_stock_level)
     or (p_filter = 'no_price' and not exists (
           select 1 from public.product_units pu
            where pu.product_id = x.id and pu.is_sold and pu.sell_price > 0))
  order by x.name, x.id
  limit greatest(1, least(coalesce(p_limit, 30), 100));
$function$;

notify pgrst, 'reload schema';
