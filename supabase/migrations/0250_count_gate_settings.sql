-- 0250 - The count gate is the shop's to set: aggressive, or relaxed on the days it picks, and
--        "count when low"
--
-- "Ashabi has over 30 items and counting every day is a challenge. We are not removing the count
-- gate but controlling it." Two ways it works, chosen in Settings:
--
--   aggressive  every day, before anything goes out — what it has always done (and the default, so
--               no shop changes until it chooses);
--   relaxed     only on the days of the week the shop picks, like an alarm's "Repeat" (every day
--               ticked is the same as aggressive, but chosen).
--
-- And on the Running low settings, "count when low": an item that has run low must be counted before
-- it sells, on any day. The shop sets it for everything; an item can follow the shop or set its own
-- (on or off) beside its own running-low level.
--
-- One rule decides it, `count_required_today(item)`: not if it was counted today; otherwise yes when
-- the shop is aggressive, or today is one of its days, or count-when-low applies and the item is
-- running low (on hand at or below `product_low_threshold`, the rule the Running low list uses). The
-- sale trigger and the till's "not counted" reader (`needs_count_today`) both read it.

alter table public.store_settings
  add column if not exists count_gate_mode text not null default 'aggressive',
  add column if not exists count_gate_days smallint[] not null default '{}',
  add column if not exists count_when_low boolean not null default false;

alter table public.store_settings drop constraint if exists store_settings_count_gate_mode_check;
alter table public.store_settings
  add constraint store_settings_count_gate_mode_check check (count_gate_mode in ('aggressive', 'relaxed'));

-- An item's own say: null follows the shop.
alter table public.products add column if not exists count_when_low boolean;

-- ─── The one rule ───────────────────────────────────────────────────────────────────────────
create or replace function public.count_required_today(p_product_id uuid)
returns boolean
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select case
           when public.product_counted_today(p.id) then false
           when coalesce(ss.count_gate_mode, 'aggressive') = 'aggressive' then true
           -- ISO weekday: 1 Monday ... 7 Sunday, in the shop's own time.
           when extract(isodow from now() at time zone coalesce(st.timezone, 'UTC'))::smallint
                = any (coalesce(ss.count_gate_days, '{}'::smallint[])) then true
           when coalesce(p.count_when_low, ss.count_when_low, false)
                and public.product_low_threshold(p.id) is not null
                and coalesce((select sum(m.qty_delta) from public.stock_movements m
                               where m.product_id = p.id), 0)
                    <= public.product_low_threshold(p.id) then true
           else false
         end
    from public.products p
    join public.stores st on st.id = p.store_id
    left join public.store_settings ss on ss.store_id = p.store_id
   where p.id = p_product_id;
$function$;
revoke all on function public.count_required_today(uuid) from public, anon;
grant execute on function public.count_required_today(uuid) to authenticated;

-- ─── The till's reader: which of these need counting today ─────────────────────────────────
create or replace function public.needs_count_today(p_product_id uuid)
returns boolean
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select exists (
           select 1 from public.products p
            where p.id = p_product_id and public.is_store_member(p.store_id)
         )
     and coalesce(public.count_required_today(p_product_id), false);
$function$;

-- ─── The sale's own check ──────────────────────────────────────────────────────────────────
create or replace function public.tg_sale_line_needs_todays_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_new  boolean;
  v_name text;
begin
  select s.created_at = now() into v_new from public.sales s where s.id = new.sale_id;
  if not coalesce(v_new, false) then
    return new;
  end if;
  -- The shop's count gate (0250): aggressive, its relaxed days, or count-when-low.
  if not coalesce(public.count_required_today(new.product_id), false) then
    return new;
  end if;
  select name into v_name from public.products where id = new.product_id;
  raise exception '% has not been counted today. Count the shelf before selling it.',
    coalesce(v_name, 'An item on this sale')
    using errcode = '22023';
end;
$function$;

-- ─── Reading and setting it ────────────────────────────────────────────────────────────────
create or replace function public.count_gate_settings(p_store_id uuid)
returns jsonb
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
           'mode', coalesce(ss.count_gate_mode, 'aggressive'),
           'days', to_jsonb(coalesce(ss.count_gate_days, '{}'::smallint[])),
           'count_when_low', coalesce(ss.count_when_low, false),
           'today', extract(isodow from now() at time zone coalesce(st.timezone, 'UTC'))::int
         )
    from public.stores st
    left join public.store_settings ss on ss.store_id = st.id
   where st.id = p_store_id
     and public.is_store_member(p_store_id);
$function$;
revoke all on function public.count_gate_settings(uuid) from public, anon;
grant execute on function public.count_gate_settings(uuid) to authenticated;

create or replace function public.set_count_gate(p_store_id uuid, p_mode text, p_days smallint[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if not public.has_permission(p_store_id, 'store.settings') then
    raise exception 'Only an owner or manager can change this' using errcode = '42501';
  end if;
  if p_mode not in ('aggressive', 'relaxed') then
    raise exception '% is not a way to count', p_mode using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(p_days, '{}'::smallint[])) d where d < 1 or d > 7) then
    raise exception 'a day of the week is 1 (Monday) to 7 (Sunday)' using errcode = '22023';
  end if;
  insert into public.store_settings (store_id, count_gate_mode, count_gate_days)
  values (p_store_id, p_mode,
          (select coalesce(array_agg(distinct d order by d), '{}') from unnest(coalesce(p_days, '{}'::smallint[])) d))
  on conflict (store_id) do update
     set count_gate_mode = excluded.count_gate_mode,
         count_gate_days = excluded.count_gate_days,
         updated_at = now();
end;
$function$;
revoke all on function public.set_count_gate(uuid, text, smallint[]) from public, anon;
grant execute on function public.set_count_gate(uuid, text, smallint[]) to authenticated;

create or replace function public.set_count_when_low(p_store_id uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if not public.has_permission(p_store_id, 'store.settings') then
    raise exception 'Only an owner or manager can change this' using errcode = '42501';
  end if;
  insert into public.store_settings (store_id, count_when_low)
  values (p_store_id, coalesce(p_on, false))
  on conflict (store_id) do update set count_when_low = excluded.count_when_low, updated_at = now();
end;
$function$;
revoke all on function public.set_count_when_low(uuid, boolean) from public, anon;
grant execute on function public.set_count_when_low(uuid, boolean) to authenticated;

-- An item's own say. Null puts it back on the shop's.
create or replace function public.set_product_count_when_low(p_product_id uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_store uuid;
begin
  select store_id into v_store from public.products where id = p_product_id;
  if v_store is null then
    raise exception 'No such item';
  end if;
  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'Only somebody who manages products can change this' using errcode = '42501';
  end if;
  update public.products set count_when_low = p_on, updated_at = now() where id = p_product_id;
end;
$function$;
revoke all on function public.set_product_count_when_low(uuid, boolean) from public, anon;
grant execute on function public.set_product_count_when_low(uuid, boolean) to authenticated;

create or replace function public.product_count_when_low(p_product_id uuid)
returns jsonb
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select jsonb_build_object('own', p.count_when_low, 'shop', coalesce(ss.count_when_low, false))
    from public.products p
    left join public.store_settings ss on ss.store_id = p.store_id
   where p.id = p_product_id
     and public.is_store_member(p.store_id);
$function$;
revoke all on function public.product_count_when_low(uuid) from public, anon;
grant execute on function public.product_count_when_low(uuid) to authenticated;

notify pgrst, 'reload schema';
