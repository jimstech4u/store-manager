-- 0277 — WHO DID WHAT, OVER ANY WINDOW
--
-- "No record tied to the team member, even the report shows Olanike sold 0, which is the only user
-- and sold everything" (10 Nov).
--
-- `staff_activity` tested every window as `x >= p_from and x < p_to`. The Reports page sends an
-- open bound for "All time" (and for any period still running), and in SQL `x < null` is null —
-- never true — so every count came back 0 while the sales were all there, each with its
-- `created_by`. Checked against live: with an explicit end the same call reads 205 receipts and
-- ₦8,239,150 for November, matching `sales_summary`.
--
-- An open bound now means no limit, as it already did in `sales_summary`, `sales_by_day`,
-- `sales_by_product`, `takings_by_*`, `report_counts` and `report_payments` (each compared with an
-- open and a set end on 10 Nov; only this one differed). Same signature, so no overload.
--
-- Rollback: re-run the `staff_activity` definition in 0132.

create or replace function public.staff_activity(
  p_store_id uuid,
  p_from     timestamptz,
  p_to       timestamptz,
  p_user_id  uuid default null
)
returns table (
  user_id       uuid,
  who           text,
  receipts      int,
  sold          money_amt,
  corrections   int,
  deliveries    int,
  counts        int,
  write_offs    int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with allowed as (
    select m.user_id, coalesce(u.email::text, 'Someone') as who
      from public.store_members m
      left join auth.users u on u.id = m.user_id
     where m.store_id = p_store_id
       and (p_user_id is null or m.user_id = p_user_id)
       and (public.has_permission(p_store_id, 'staff.manage') or m.user_id = auth.uid())
  )
  select a.user_id,
         a.who,
         coalesce((select count(*) from public.sales s
                    where s.store_id = p_store_id and s.created_by = a.user_id
                      and s.status = 'posted'
                      and (p_from is null or s.occurred_at >= p_from) and (p_to is null or s.occurred_at < p_to)), 0)::int,
         coalesce((select sum(s.total) from public.sales s
                    where s.store_id = p_store_id and s.created_by = a.user_id
                      and s.status = 'posted'
                      and (p_from is null or s.occurred_at >= p_from) and (p_to is null or s.occurred_at < p_to)), 0)::money_amt,
         coalesce((select count(*) from public.sale_revisions r
                    where r.store_id = p_store_id and r.amended_by = a.user_id
                      and (p_from is null or r.amended_at >= p_from) and (p_to is null or r.amended_at < p_to)), 0)::int,
         coalesce((select count(*) from public.purchases p
                    where p.store_id = p_store_id and p.created_by = a.user_id
                      and (p_from is null or p.occurred_at >= p_from) and (p_to is null or p.occurred_at < p_to)), 0)::int,
         coalesce((select count(*) from public.stock_periods sp
                    where sp.store_id = p_store_id and sp.counted_by = a.user_id
                      and (p_from is null or sp.counted_at >= p_from) and (p_to is null or sp.counted_at < p_to)), 0)::int,
         coalesce((select count(*) from public.stock_movements sm
                    where sm.store_id = p_store_id and sm.created_by = a.user_id
                      and sm.kind = 'damage'
                      and (p_from is null or sm.occurred_at >= p_from) and (p_to is null or sm.occurred_at < p_to)), 0)::int
    from allowed a
   order by 4 desc;
$fn$;

do $check$
declare n int;
begin
  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'staff_activity';
  if n <> 1 then
    raise exception 'staff_activity has % overloads; PostgREST answers 300 to every call', n;
  end if;
end;
$check$;
