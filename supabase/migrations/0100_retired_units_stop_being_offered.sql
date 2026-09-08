-- 0100 — A retired unit stops being offered, and the picker says what a unit is used for
--
-- 0099 gave `store_units` a status and nothing reads it, so retiring one changed nothing anybody
-- could see. Half a feature, and the half that makes the other half pointless.
--
-- The reader also gains the COUNT of products measured in each unit, for the same reason the pools
-- reader did: a screen offering to retire something needs to say what that would affect, and asking
-- per row is a round trip per row.

drop function if exists public.store_units_for(uuid);

create function public.store_units_for(p_store_id uuid)
returns table (id uuid, name text, plural text, divisible boolean, products int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select su.id,
         su.name,
         su.plural,
         su.divisible,
         /*
          * How many ACTIVE products are measured in it.
          *
          * What a screen needs to answer "is this safe to put away", and what `archive_store_unit`
          * refuses on. Archived products are not counted: a unit is not kept alive by something the
          * shop has already stopped selling.
          */
         (select count(*)::int
            from public.product_units pu
            join public.products p on p.id = pu.product_id
           where pu.store_unit_id = su.id
             and p.status = 'active')
    from public.store_units su
   where su.store_id = p_store_id
     and su.status = 'active'
     and public.is_store_member(p_store_id)
   order by su.name;
$$;

revoke all on function public.store_units_for(uuid) from public;
grant execute on function public.store_units_for(uuid) to authenticated;

do $check$
declare n int;
begin
  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'store_units_for';
  if n <> 1 then
    raise exception 'store_units_for has % overloads', n;
  end if;
end;
$check$;
