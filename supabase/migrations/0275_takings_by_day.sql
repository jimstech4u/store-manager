-- 0275 - What came in each day, by how it was paid
--
-- "We should be able to see each day's breakdown in money for cash, transfer, POS and other."
-- takings_by_method answered for a whole window and only on Reports. This answers per DAY of the
-- shop's own calendar (its timezone, as sales_by_day does), per method, NET: money in less what
-- went back out the same way — a payment taken back in a correction, change handed over — because
-- the figure is checked against a drawer and a bank app, which only ever saw the net.

create or replace function public.takings_by_day(
  p_store_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null
)
 returns table(day date, cash money_amt, transfer money_amt, pos money_amt, other money_amt,
               total money_amt, payments integer)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  with p as (
    select (p.occurred_at at time zone coalesce(st.timezone, 'UTC'))::date as day,
           p.method,
           case when p.direction = 'in' then p.amount else -p.amount end as signed,
           p.direction
      from public.payments p
      join public.stores st on st.id = p.store_id
     where p.store_id = p_store_id
       and (p_from is null or p.occurred_at >= p_from)
       and (p_to   is null or p.occurred_at <  p_to)
       and public.has_permission(p_store_id, 'reports.view')
  )
  select day,
         coalesce(sum(signed) filter (where method = 'cash'), 0)::money_amt,
         coalesce(sum(signed) filter (where method = 'transfer'), 0)::money_amt,
         coalesce(sum(signed) filter (where method = 'pos'), 0)::money_amt,
         coalesce(sum(signed) filter (where method not in ('cash', 'transfer', 'pos')), 0)::money_amt,
         coalesce(sum(signed), 0)::money_amt,
         (count(*) filter (where direction = 'in'))::int
    from p
   group by day
   order by day desc;
$function$;

revoke all on function public.takings_by_day(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.takings_by_day(uuid, timestamptz, timestamptz) to authenticated;

notify pgrst, 'reload schema';
