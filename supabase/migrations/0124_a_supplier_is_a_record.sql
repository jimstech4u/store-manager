-- 0124 — A supplier is a record, not a line of text
--
-- `purchases.supplier_name` is free text, and has been since 0004. So "Nigerian Breweries", "NBL",
-- "nigerian breweries" and "NBL depot" are four suppliers as far as anything can tell, and none of
-- them has a history: no list of what was bought, no note of who to call, and — now that containers
-- go back — no account of what they are owed.
--
-- That last one is what forces the change. `supplier_empties` (0123) records crates leaving on the
-- lorry, and "who took them" written as text cannot be totalled. A shop asking "how many NBL crates
-- have we sent back this month" would be matching strings, and every spelling is a different answer.
--
-- So a supplier is a row, chosen from a picker, created without leaving whatever you are doing —
-- the same shape as a customer, for the same reason: nobody abandons a half-entered delivery to go
-- and file somebody on another screen.
--
-- THE TEXT COLUMN STAYS. Every delivery recorded so far carries a name and nothing else, and those
-- are real deliveries. `supplier_id` is added beside it and the two are reconciled by name where
-- they agree.

create table if not exists public.suppliers (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       text not null check (btrim(name) <> ''),
  phone      text,
  note       text,
  -- Retired rather than deleted, like every other name a shop stops using: past deliveries keep
  -- pointing at it and must stay readable.
  status     text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One supplier per name per shop, case-insensitively — which is the whole point of having a row.
create unique index if not exists suppliers_name_idx
  on public.suppliers (store_id, lower(btrim(name)));

comment on table public.suppliers is
  'Who a shop buys from. A row rather than the free text on `purchases`, so deliveries and returned '
  'containers can be totalled against one of them instead of matched by spelling.';

alter table public.suppliers enable row level security;

create policy suppliers_read on public.suppliers
  for select using (public.is_store_member(store_id));

create policy suppliers_none on public.suppliers
  for insert with check (false);

alter table public.purchases
  add column if not exists supplier_id uuid references public.suppliers (id) on delete set null;

alter table public.supplier_empties
  add column if not exists supplier_id uuid references public.suppliers (id) on delete set null;

-- ─── Naming one ─────────────────────────────────────────────────────────────────────

/*
 * RETURNS THE EXISTING ONE RATHER THAN REFUSING.
 *
 * Somebody typing "NBL" into a picker that already holds "NBL" means the one that is there. The
 * product groups learnt this in 0093: a shop that forgot it already had a supplier gets that
 * supplier, not a telling-off in the middle of entering a load.
 */
create or replace function public.upsert_supplier(
  p_store_id uuid,
  p_name     text,
  p_phone    text default null,
  p_note     text default null,
  p_id       uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare v_id uuid;
begin
  if not public.has_permission(p_store_id, 'stock.receive') then
    raise exception 'you do not have permission to name a supplier' using errcode = '42501';
  end if;

  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'a supplier needs a name' using errcode = '22023';
  end if;

  if p_id is not null then
    update public.suppliers
       set name = btrim(p_name),
           phone = nullif(btrim(coalesce(p_phone, '')), ''),
           note = nullif(btrim(coalesce(p_note, '')), ''),
           updated_at = now()
     where id = p_id and store_id = p_store_id
    returning id into v_id;

    if v_id is null then
      raise exception 'that supplier does not belong to this shop' using errcode = '42501';
    end if;
    return v_id;
  end if;

  select id into v_id
    from public.suppliers
   where store_id = p_store_id
     and lower(btrim(name)) = lower(btrim(p_name));

  if v_id is not null then
    -- Bring it back if it was retired: naming it again is asking for it.
    update public.suppliers
       set status = 'active',
           phone = coalesce(nullif(btrim(coalesce(p_phone, '')), ''), phone),
           updated_at = now()
     where id = v_id;
    return v_id;
  end if;

  insert into public.suppliers (store_id, name, phone, note)
  values (p_store_id, btrim(p_name), nullif(btrim(coalesce(p_phone, '')), ''),
          nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.upsert_supplier(uuid, text, text, text, uuid) from public;
grant execute on function public.upsert_supplier(uuid, text, text, text, uuid) to authenticated;

create or replace function public.archive_supplier(p_supplier_id uuid, p_restore boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare v_store uuid;
begin
  select store_id into v_store from public.suppliers where id = p_supplier_id;
  if v_store is null then
    raise exception 'that supplier does not exist' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_store, 'stock.receive') then
    raise exception 'you do not have permission to retire a supplier' using errcode = '42501';
  end if;

  update public.suppliers
     set status = case when p_restore then 'active' else 'archived' end,
         updated_at = now()
   where id = p_supplier_id;
end;
$fn$;

revoke all on function public.archive_supplier(uuid, boolean) from public;
grant execute on function public.archive_supplier(uuid, boolean) to authenticated;

-- ─── Reading them ───────────────────────────────────────────────────────────────────

create or replace function public.store_suppliers(p_store_id uuid, p_include_archived boolean default false)
returns table (
  id         uuid,
  name       text,
  phone      text,
  note       text,
  status     text,
  deliveries int,
  last_at    timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select s.id, s.name, s.phone, s.note, s.status,
         count(p.id)::int,
         max(p.occurred_at)
    from public.suppliers s
    left join public.purchases p on p.supplier_id = s.id
   where s.store_id = p_store_id
     and (p_include_archived or s.status = 'active')
     and public.is_store_member(p_store_id)
   group by s.id, s.name, s.phone, s.note, s.status
   order by max(p.occurred_at) desc nulls last, s.name;
$fn$;

revoke all on function public.store_suppliers(uuid, boolean) from public;
grant execute on function public.store_suppliers(uuid, boolean) to authenticated;

/*
 * WHAT HAS GONE BACK TO ONE SUPPLIER, shape by shape — the ledger the free text could not carry.
 *
 * Totalled from the rows rather than from a running column, for the same reason every other ledger
 * here is: a sum of what happened cannot drift from what happened.
 */
create or replace function public.supplier_empties_sent(p_supplier_id uuid)
returns table (
  product_id      uuid,
  product_name    text,
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text,
  sent            qty,
  last_at         timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.id, p.name, pu.id, su.name, su.plural, sum(se.qty)::qty, max(se.occurred_at)
    from public.supplier_empties se
    join public.suppliers s on s.id = se.supplier_id
    join public.products p on p.id = se.product_id
    join public.product_units pu on pu.id = se.product_unit_id
    join public.store_units su on su.id = pu.store_unit_id
   where se.supplier_id = p_supplier_id
     and public.is_store_member(s.store_id)
   group by p.id, p.name, pu.id, su.name, su.plural
   order by p.name, pu.base_qty desc;
$fn$;

revoke all on function public.supplier_empties_sent(uuid) from public;
grant execute on function public.supplier_empties_sent(uuid) to authenticated;

-- ─── The names already recorded become rows ─────────────────────────────────────────

/*
 * Every distinct supplier name on a past delivery, made into a supplier, and the deliveries
 * pointed at it.
 *
 * Matched case-insensitively on the trimmed name, which is the best that free text allows: "NBL"
 * and "nbl" become one, "NBL" and "NBL depot" stay two. A shop can merge those itself now that
 * they are rows; nothing here guesses at it.
 */
insert into public.suppliers (store_id, name)
select p.store_id, btrim(p.supplier_name)
  from public.purchases p
  join public.stores st on st.id = p.store_id
 where btrim(coalesce(p.supplier_name, '')) <> ''
 group by p.store_id, lower(btrim(p.supplier_name)), btrim(p.supplier_name)
on conflict do nothing;

update public.purchases p
   set supplier_id = s.id
  from public.suppliers s
 where s.store_id = p.store_id
   and lower(btrim(s.name)) = lower(btrim(coalesce(p.supplier_name, '')))
   and p.supplier_id is null;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('upsert_supplier', 'archive_supplier', 'store_suppliers',
                          'supplier_empties_sent')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a supplier function has % overloads', n;
    end if;
  end loop;
end;
$check$;
