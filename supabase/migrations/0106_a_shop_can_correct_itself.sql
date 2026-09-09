-- 0106 — A shop can be renamed, and one made by accident can be closed
--
-- «why am i signed in into ashabi global resources and then i got routed to setup route»
--
-- The account behind that question owns two shops: ASHABI GLOBAL RESOURCES, trading since August,
-- and "Yh" — created at 05:53 this morning, never onboarded, a name typed into the setup form and
-- abandoned. It cannot be renamed and it cannot be closed, because nothing in the database lets a
-- shop correct ITSELF.
--
-- That is a strange omission next to everything else. A shop can rename its units (0099), retire
-- them (0100), name and archive its pools (0092), name and archive its product groups (0093),
-- archive a product, archive a customer, remove a member. The one row it can do nothing to is its
-- own. Somebody who mistypes their shop's name at signup lives with it for ever, and an accidental
-- shop stays in the switcher permanently — and, until the fix that accompanies this, took over the
-- session and answered with a setup wizard.
--
-- Owner only, all three. Renaming the shop changes what every customer sees on every receipt, and
-- closing one takes it off the switcher for everybody in it.
--
-- The permission is `store.settings`. The first version of this file invented `settings.manage`,
-- which is not a code this database has — `has_permission` would have answered false for every
-- caller including the owner, and all three functions would have refused everybody with a message
-- saying they were not the owner. A guessed identifier that is merely WRONG fails safe and looks
-- like a permissions bug for as long as nobody reads the codes; the list is
-- `select code from permissions`.

alter table public.stores
  add column if not exists status text not null default 'active'
    check (status in ('active', 'closed'));

comment on column public.stores.status is
  'A closed shop keeps every row it ever wrote — the ledgers are append-only and a receipt a '
  'customer is holding must stay readable — it simply stops being offered. Reopening is the same '
  'function with p_restore.';

create index if not exists stores_active_idx on public.stores (id) where status = 'active';

-- ─── Renaming ───────────────────────────────────────────────────────────────────────

create or replace function public.rename_store(p_store_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  /*
   * OWNER ONLY, and read from the caller rather than trusted from the payload.
   *
   * `has_permission` answers "may this person act in this shop", which is the whole question here
   * because the row being written IS the shop. There is no second id to be lied about.
   */
  if not public.has_permission(p_store_id, 'store.settings') then
    raise exception 'only an owner can rename the shop' using errcode = '42501';
  end if;

  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'a shop needs a name' using errcode = '22023';
  end if;

  update public.stores set name = btrim(p_name), updated_at = now() where id = p_store_id;
end;
$$;

revoke all on function public.rename_store(uuid, text) from public;
grant execute on function public.rename_store(uuid, text) to authenticated;

-- ─── Where it is ────────────────────────────────────────────────────────────────────

-- The storefront is public and `public_stores_near` sorts by distance, so a shop that switches its
-- storefront on has always been able to be found by people nearby — and has never had any way to
-- say where it is. The columns were written by nothing.
create or replace function public.set_store_place(
  p_store_id  uuid,
  p_address   text,
  p_latitude  double precision default null,
  p_longitude double precision default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_permission(p_store_id, 'store.settings') then
    raise exception 'only an owner can set where the shop is' using errcode = '42501';
  end if;

  -- Refused rather than clamped. A latitude of 200 is a mistake, and silently turning it into 90
  -- puts the shop somewhere real and wrong.
  if p_latitude is not null and (p_latitude < -90 or p_latitude > 90) then
    raise exception 'that latitude is not a place' using errcode = '22023';
  end if;
  if p_longitude is not null and (p_longitude < -180 or p_longitude > 180) then
    raise exception 'that longitude is not a place' using errcode = '22023';
  end if;

  update public.stores
     set address   = nullif(btrim(coalesce(p_address, '')), ''),
         latitude  = p_latitude,
         longitude = p_longitude,
         updated_at = now()
   where id = p_store_id;
end;
$$;

revoke all on function public.set_store_place(uuid, text, double precision, double precision) from public;
grant execute on function public.set_store_place(uuid, text, double precision, double precision)
  to authenticated;

-- ─── Closing one ────────────────────────────────────────────────────────────────────

create or replace function public.close_store(
  p_store_id uuid,
  p_restore  boolean default false,
  p_force    boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sales int;
begin
  if not public.has_permission(p_store_id, 'store.settings') then
    raise exception 'only an owner can close the shop' using errcode = '42501';
  end if;

  if p_restore then
    update public.stores set status = 'active', updated_at = now() where id = p_store_id;
    return;
  end if;

  /*
   * A SHOP THAT HAS TRADED IS NOT CLOSED BY ACCIDENT.
   *
   * The case this exists for is the shop created by a mistyped name and abandoned the same
   * morning, and for that there is nothing to protect. A shop with sales on it is a different
   * thing entirely — its receipts are in customers' hands and its ledgers are append-only — so
   * closing that one has to be said twice, the way archiving a product with stock on it does.
   */
  select count(*) into v_sales from public.sales where store_id = p_store_id;

  if v_sales > 0 and not p_force then
    raise exception 'that shop has % sale(s) on it; closing it needs confirming', v_sales
      using errcode = '23514';
  end if;

  update public.stores set status = 'closed', updated_at = now() where id = p_store_id;
end;
$$;

revoke all on function public.close_store(uuid, boolean, boolean) from public;
grant execute on function public.close_store(uuid, boolean, boolean) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('rename_store', 'set_store_place', 'close_store')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a shop-settings function has % overloads', n;
    end if;
  end loop;
end;
$check$;
