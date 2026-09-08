-- 0099 — A unit's name can be corrected, and one nobody uses put away
--
-- `create_store_unit` exists and the app calls it. Nothing renames one and nothing retires one, so a
-- shop that types "Crat" has it for ever — and not in one place: the name is on every product that
-- uses that unit, on every receipt those products print, and in every picker. It is the single most
-- visible piece of text a shop owns and the only one it cannot fix.
--
-- The other half is a unit nobody uses. A shop trying "Keg" once and abandoning it has it in the
-- picker for ever, and pickers are how a hurried seller chooses the wrong thing.
--
-- RENAMING IS SAFE AND RETIRING IS NOT, and they are treated differently for that reason. A name is
-- a label — every row still points at the same unit and reads correctly afterwards. Retiring one
-- that a product is measured in would leave that product's shapes pointing at something no picker
-- offers, so it is refused with the count.

create or replace function public.rename_store_unit(
  p_unit_id uuid,
  p_name    text,
  p_plural  text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store uuid;
begin
  -- DERIVED, not taken as an argument. A function told which store it is acting in can be lied to
  -- about it, which is how 0097 and 0098 both happened.
  select store_id into v_store from public.store_units where id = p_unit_id;
  if v_store is null then
    raise exception 'that unit does not exist' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'you do not have permission to change units' using errcode = '42501';
  end if;

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'a unit needs a name' using errcode = '22023';
  end if;

  -- Two units called "Crate" in one shop cannot be told apart in a picker, which is where they are
  -- chosen from in a hurry.
  if exists (
    select 1 from public.store_units
     where store_id = v_store
       and id <> p_unit_id
       and lower(btrim(name)) = lower(btrim(p_name))
  ) then
    raise exception 'you already have a unit called %', btrim(p_name) using errcode = '22023';
  end if;

  update public.store_units
     set name   = btrim(p_name),
         plural = coalesce(nullif(btrim(coalesce(p_plural, '')), ''), btrim(p_name) || 's')
   where id = p_unit_id;
end;
$fn$;

comment on function public.rename_store_unit(uuid, text, text) is
  'Correct a unit''s name. Safe by nature: every row still points at the same unit, so a typo fixed '
  'here is fixed on every product, receipt and picker at once — which is also why it could not be '
  'left unfixable.';

revoke all on function public.rename_store_unit(uuid, text, text) from public;
grant execute on function public.rename_store_unit(uuid, text, text) to authenticated;

-- ─── Putting one away ───────────────────────────────────────────────────────────────

alter table public.store_units
  add column if not exists status text not null default 'active'
    check (status in ('active', 'archived'));

create or replace function public.archive_store_unit(p_unit_id uuid, p_restore boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store uuid;
  v_used  int;
begin
  select store_id into v_store from public.store_units where id = p_unit_id;
  if v_store is null then
    raise exception 'that unit does not exist' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'you do not have permission to change units' using errcode = '42501';
  end if;

  /*
   * NOT WHILE SOMETHING IS MEASURED IN IT.
   *
   * A product's shapes point at a unit. Retiring one still in use would leave those shapes naming
   * something no picker offers — the product would go on working and become unreadable, which is
   * the worst kind of broken. Told with the count, because the way out is to change those products
   * first and a refusal without a number gives nowhere to start.
   */
  if not p_restore then
    select count(*) into v_used
      from public.product_units pu
      join public.products p on p.id = pu.product_id
     where pu.store_unit_id = p_unit_id
       and p.status = 'active';

    if v_used > 0 then
      raise exception '% product(s) are measured in this. Change those first.', v_used
        using errcode = '22023';
    end if;
  end if;

  update public.store_units
     set status = case when p_restore then 'active' else 'archived' end
   where id = p_unit_id;
end;
$fn$;

revoke all on function public.archive_store_unit(uuid, boolean) from public;
grant execute on function public.archive_store_unit(uuid, boolean) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('rename_store_unit', 'archive_store_unit')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a unit writer has % overloads', n;
    end if;
  end loop;
end;
$check$;
