-- 0107 — The shop's own clock, and whether it counts kobo
--
-- Two columns on `stores` that a shop has never been able to reach, and that were not doing much
-- when it got there.
--
-- `timezone` has been on the table since 0001 and is READ BY NOTHING. Every day boundary in the
-- database is the server's, which is UTC — so a Lagos shop closing a stock period at half past
-- midnight has it filed against yesterday, and one closing at half past eleven at night has it
-- filed against today only by accident. An hour is enough to put a day's takings in the wrong day.
--
-- `money_decimals` has been there since 0009 and is read by exactly one function, `price_check`,
-- which has no screen. Nigerian trade is in whole naira and the default of 0 is right; a shop that
-- deals in something divisible has had nowhere to say so.
--
-- CURRENCY IS DELIBERATELY NOT HERE. The naira sign is written into eighty-five places in the app
-- and the whole product is Nigerian wholesale. A function to change the column would let a shop set
-- something the screens cannot honour, which is the failure this migration exists to stop, not to
-- repeat. UI_AUDIT.md records it.

create or replace function public.set_store_clock(p_store_id uuid, p_timezone text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_permission(p_store_id, 'store.settings') then
    raise exception 'only an owner can set the shop clock' using errcode = '42501';
  end if;

  /*
   * CHECKED AGAINST THE DATABASE'S OWN LIST, not a regex.
   *
   * `pg_timezone_names` is what `at time zone` will actually accept, so anything that passes here
   * works everywhere it is used. A pattern match would let "Africa/Lagos " or "GMT+1" through and
   * the failure would surface later, in a report, as a day boundary nobody could explain.
   */
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception '% is not a timezone this database knows', p_timezone using errcode = '22023';
  end if;

  update public.stores set timezone = p_timezone, updated_at = now() where id = p_store_id;
end;
$$;

revoke all on function public.set_store_clock(uuid, text) from public;
grant execute on function public.set_store_clock(uuid, text) to authenticated;

-- The ones a Nigerian shop plausibly wants, without shipping the whole 1,200-row list to a phone.
create or replace function public.store_clock_choices()
returns table (name text, offset_now text)
language sql
stable
as $$
  select name,
         to_char(utc_offset, 'FMHH24:MI') as offset_now
    from pg_timezone_names
   where name in (
     'Africa/Lagos', 'Africa/Abidjan', 'Africa/Accra', 'Africa/Cairo', 'Africa/Johannesburg',
     'Africa/Nairobi', 'Europe/London', 'America/New_York', 'Asia/Dubai', 'UTC'
   )
   order by utc_offset, name;
$$;

revoke all on function public.store_clock_choices() from public;
grant execute on function public.store_clock_choices() to authenticated;

-- ─── Kobo, or not ───────────────────────────────────────────────────────────────────

create or replace function public.set_store_money_decimals(p_store_id uuid, p_decimals smallint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_permission(p_store_id, 'store.settings') then
    raise exception 'only an owner can change how money is shown' using errcode = '42501';
  end if;

  if p_decimals is null or p_decimals < 0 or p_decimals > 2 then
    raise exception 'money is shown to between 0 and 2 places' using errcode = '22023';
  end if;

  /*
   * SAFE TO CHANGE AT ANY TIME, unlike the currency, and worth saying why.
   *
   * Storage is `numeric(18,2)` and stays that way whatever this says — 0009 chose that on purpose,
   * because derived figures like average cost and allocated delivery fees need the precision even
   * when prices do not. This column decides ENTRY and DISPLAY only, so turning it up reveals
   * fractions that were always there and turning it down hides them. Nothing is rounded away and no
   * past figure changes meaning.
   */
  update public.stores set money_decimals = p_decimals, updated_at = now() where id = p_store_id;
end;
$$;

revoke all on function public.set_store_money_decimals(uuid, smallint) from public;
grant execute on function public.set_store_money_decimals(uuid, smallint) to authenticated;

-- ─── And the clock is actually used ─────────────────────────────────────────────────

/*
 * THE ONE PLACE A DAY BOUNDARY IS DECIDED IN SQL.
 *
 * `date_trunc('day', now())` truncates in the SERVER's timezone, which is UTC. For a shop in Lagos
 * that is one o'clock in the morning — so between midnight and 1am local, `period_end >= today`
 * compares against a boundary that has not arrived yet, and an item counted yesterday evening reads
 * as still needing a count. An hour a day, every day, on the screen that decides whether a seller
 * is stopped before selling.
 *
 * COPIED FROM 0073 AND CHANGED ON ONE LINE. The first draft of this file invented a function called
 * `open_period_for(p_store_id)` from memory — the real one is `needs_count_today(p_product_id)`,
 * takes a different argument, answers a different question and joins through `products`. Applying
 * it would have created a second function nobody calls and left the actual boundary untouched. This
 * is the rule 0058 and 0080 each cost a day by ignoring, and it is why the store is reached THROUGH
 * the product here rather than passed in.
 */
create or replace function public.needs_count_today(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select not exists (
    select 1
      from public.stock_periods sp
      join public.products p on p.id = sp.product_id
      join public.stores s on s.id = p.store_id
     where sp.product_id = p_product_id
       and public.is_store_member(p.store_id)
       and (
         sp.status = 'open'
         or (
           sp.status = 'closed'
           and sp.period_end >= (now() at time zone coalesce(s.timezone, 'UTC'))::date
         )
       )
  );
$fn$;

grant execute on function public.needs_count_today(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('set_store_clock', 'store_clock_choices', 'set_store_money_decimals')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a shop-settings function has % overloads', n;
    end if;
  end loop;
end;
$check$;
