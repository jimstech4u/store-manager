-- =====================================================================================
-- 0041 — "Covered by a deposit" means the ones money was actually taken for
--
-- `customer_deposits_held` summed every unit in the pool and paired it with the money held, so a
-- customer with three crates out on trust and ten paid for read as "13 covered by ₦20,000". The
-- money was right; the count beside it was not, and the account page used that count to work out
-- how many were out on trust — which therefore came to zero.
--
-- Units and money have to be filtered the same way: only rows where a rate was actually recorded
-- represent a deposit. Everything else is stock out on trust, which is a different obligation
-- that settles differently.
-- =====================================================================================

create or replace function public.customer_deposits_held(p_store_customer_id uuid)
returns table (
  category_id   uuid,
  category_name text,
  qty_units     qty,
  amount        money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select d.empties_category_id,
         ec.name,
         coalesce(sum(d.qty_units) filter (where d.deposit_per_unit > 0), 0)::qty,
         coalesce(sum(d.qty_units * d.deposit_per_unit), 0)::money_amt
    from public.deposit_ledger d
    join public.empties_categories ec on ec.id = d.empties_category_id
    join public.store_customers sc on sc.id = d.store_customer_id
   where d.store_customer_id = p_store_customer_id
     and d.direction = 'collected'
     and public.is_store_member(sc.store_id)
   group by d.empties_category_id, ec.name
  having coalesce(sum(d.qty_units) filter (where d.deposit_per_unit > 0), 0) <> 0
      or coalesce(sum(d.qty_units * d.deposit_per_unit), 0) <> 0
   order by ec.name;
$fn$;

grant execute on function public.customer_deposits_held(uuid) to authenticated;
