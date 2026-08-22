-- =====================================================================================
-- 0026 — One record_sale signature, not two
--
-- Adding `p_charges` in 0023 created a SECOND overload rather than replacing the first: Postgres
-- treats record_sale(uuid, jsonb, uuid, timestamptz, uuid) and
-- record_sale(uuid, jsonb, uuid, timestamptz, uuid, jsonb) as different functions. Because every
-- parameter after the second has a default, a two-argument call matches both, and Postgres
-- refuses to guess:
--
--     function public.record_sale(uuid, jsonb) is not unique
--
-- Every existing caller broke, including settle_sale — while the migration itself applied
-- cleanly, because creating an ambiguous overload is not an error until something calls it.
--
-- Academix hit the same shape with create_or_get_academix_profile and settled on the same rule:
-- ONE signature per function. An overload set where the extra parameters are optional is a trap
-- that springs at call time, far from the change that set it.
-- =====================================================================================

drop function if exists public.record_sale(uuid, jsonb, uuid, timestamptz, uuid);

-- Prove only one remains, so this cannot quietly regress.
do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'record_sale';

  if v_count <> 1 then
    raise exception 'expected exactly one record_sale, found %', v_count;
  end if;
end;
$$;
