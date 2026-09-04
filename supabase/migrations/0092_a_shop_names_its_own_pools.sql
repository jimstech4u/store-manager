-- 0092 — A shop names its own empties pools, and says what it holds against them
--
-- «the bad container out you collect 125 naira each … no where to manage that»
--
-- `empties_categories` carries a shop's pools — "NBL crate", "NBL bottle" — and the deposit it
-- usually holds against each. NBL bottle says ₦125. Nothing in the app can change it, add a pool,
-- or retire one: `save_empties_category` was added in 0082 for a screen that was never built, and
-- it EDITS only — it raises if the id does not exist, so there has never been a way to make the
-- first one either. Every pool in this shop was seeded by a migration.
--
-- Three writers and a status column. Retiring rather than deleting, because a pool that has ever
-- had a container move through it is referenced by an append-only ledger: deleting it would either
-- fail or take the history with it, and the history is the point.

alter table public.empties_categories
  add column if not exists status text not null default 'active'
    check (status in ('active', 'archived'));

comment on column public.empties_categories.status is
  'Retired pools stay, because the ledger references them and it is append-only. Archived ones are '
  'out of every picker and still explain the rows that already point at them.';

-- ─── Making one ─────────────────────────────────────────────────────────────────────

create or replace function public.create_empties_category(
  p_store_id uuid,
  p_name     text,
  p_kind     text,
  p_deposit  money_amt default 0
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to manage empties'
      using errcode = '42501';
  end if;

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'a pool needs a name' using errcode = '22023';
  end if;

  /*
   * CONTENT or CONTAINER, and the difference is not cosmetic.
   *
   * A content pool is counted from what was sold — twelve bottles in a crate of twelve — and a
   * container pool is counted from the containers that physically left. `returnables_for_sale`
   * branches on exactly this, so a pool created with the wrong kind is owed in the wrong quantity
   * for ever.
   */
  if p_kind not in ('content', 'container') then
    raise exception 'a pool is either content or container, not %', p_kind using errcode = '22023';
  end if;

  -- A shop with two pools called "NBL crate" cannot tell its own returns apart.
  if exists (
    select 1 from public.empties_categories
     where store_id = p_store_id
       and status = 'active'
       and lower(btrim(name)) = lower(btrim(p_name))
  ) then
    raise exception 'you already have a pool called %', btrim(p_name) using errcode = '22023';
  end if;

  insert into public.empties_categories (store_id, name, kind, deposit)
  values (p_store_id, btrim(p_name), p_kind, coalesce(p_deposit, 0))
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.create_empties_category(uuid, text, text, money_amt) from public;
grant execute on function public.create_empties_category(uuid, text, text, money_amt) to authenticated;

-- ─── Retiring one ───────────────────────────────────────────────────────────────────

create or replace function public.archive_empties_category(p_category_id uuid, p_restore boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store uuid;
  v_out   qty;
begin
  select store_id into v_store from public.empties_categories where id = p_category_id;
  if v_store is null then
    raise exception 'That pool does not exist.' using errcode = '22023';
  end if;

  if not public.has_permission(v_store, 'deposits.manage') then
    raise exception 'you do not have permission to manage empties' using errcode = '42501';
  end if;

  /*
   * NOT WHILE SOMEBODY IS STILL HOLDING THEM.
   *
   * Retiring a pool takes it out of every picker, so containers already out against it could never
   * be settled — the shop would be owed crates it had no screen to take back. Told plainly, with
   * the number, because "cannot archive" without it is a dead end.
   */
  if not p_restore then
    select coalesce(sum(case when dl.direction = 'collected' then dl.qty_units
                             else -dl.qty_units end), 0)
      into v_out
      from public.deposit_ledger dl
     where dl.empties_category_id = p_category_id;

    if v_out > 0 then
      raise exception 'Customers are still holding % of these. Settle them first.', v_out
        using errcode = '22023';
    end if;
  end if;

  update public.empties_categories
     set status = case when p_restore then 'active' else 'archived' end
   where id = p_category_id;
end;
$fn$;

revoke all on function public.archive_empties_category(uuid, boolean) from public;
grant execute on function public.archive_empties_category(uuid, boolean) to authenticated;

-- ─── And the reader stops offering retired ones ─────────────────────────────────────

-- Dropped first: the reader gains a column, and Postgres will not change the return type of an
-- existing function in place — `create or replace` answers 42P13 and tells you to drop it.
drop function if exists public.store_empties_categories(uuid);

CREATE OR REPLACE FUNCTION public.store_empties_categories(p_store_id uuid)
 RETURNS TABLE(id uuid, name text, kind text, deposit money_amt, in_use boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select ec.id, ec.name, ec.kind, ec.deposit,
         /*
          * Whether anything has ever moved through this pool.
          *
          * Returned with the list so a screen can say "this one has history" without asking again
          * per row — and so retiring is offered as retiring rather than as a delete that will fail.
          */
         exists (select 1 from public.deposit_ledger dl where dl.empties_category_id = ec.id)
    from public.empties_categories ec
   where ec.status = 'active'
     and ec.store_id = p_store_id
     and public.is_store_member(p_store_id)
   order by ec.name;
$function$;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('create_empties_category', 'archive_empties_category',
                          'store_empties_categories')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a pool function has % overloads', n;
    end if;
  end loop;
end;
$check$;
