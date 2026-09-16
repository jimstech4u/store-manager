-- 0145 — A day's count is said once, and changing it is a correction with a name on it
--
-- «once counted, not possible to change unless permitted role … trace the values from who entered
--  first to edited … if server already has counted value the other user did, then the next can be
--  prompted [not] to count»
--
-- ─── ONE: the count screen could overwrite the till's count ─────────────────────────
--
-- 0144 made `count_from_till` refuse a second count in a day, and left `enter_stock_count` alone on
-- the reasoning that a manager recounting a shelf is a different act. It is not different enough: the
-- count screen called it directly, so a seller who had counted Gulder at the till at nine could be
-- silently overwritten by somebody opening Stock → Count at ten. The figure the variance was worked
-- out from changed, the name on it changed, and nothing recorded that there had ever been another.
--
-- Every path now refuses a second count on the shop's calendar day, with `unique_violation`, naming
-- who counted it first. The till reads that as "already done"; the count screen shows the count that
-- stands.
--
-- ─── TWO: a wrong count must still be fixable — by somebody allowed to, in the open ─
--
-- `counts.correct` (owner, manager — the same people who may resolve a variance, for the same reason:
-- the person who can make stock disappear must not also be able to re-count it away).
-- `correct_todays_count` never edits history silently: it appends a row to `stock_count_edits` with
-- the figure before, the figure after, the reason, who and when, then moves the period's count. The
-- ORIGINAL counter and time stay on the period, so "who counted it first" is always answerable.
--
-- A period already CLOSED on that count has handed its figure on as the next period's opening, so the
-- correction moves both by the same difference — otherwise tomorrow would start from the figure that
-- was just declared wrong.
--
-- ─── THREE: readers, so the screens can say who counted and what changed ─────────────

-- ─── The permission ─────────────────────────────────────────────────────────────────

insert into public.permissions (code, description)
values ('counts.correct', 'Change a shelf count after it has been entered, with a reason')
on conflict (code) do nothing;

insert into public.role_permissions (role_code, permission_code)
values ('owner', 'counts.correct'), ('manager', 'counts.correct')
on conflict do nothing;

-- ─── A person, as the shop knows them ───────────────────────────────────────────────

create or replace function public.member_name(p_store_id uuid, p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
           nullif(trim(concat_ws(' ', m.first_name, m.last_name)), ''),
           nullif(m.login_email, ''),
           u.email::text,
           'Someone'
         )
    from auth.users u
    left join public.store_members m on m.user_id = u.id and m.store_id = p_store_id
   where u.id = p_user_id;
$fn$;

revoke all on function public.member_name(uuid, uuid) from public;
-- Not granted: called only from the readers below, which do their own membership test.

-- ─── The trail ──────────────────────────────────────────────────────────────────────

create table if not exists public.stock_count_edits (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references public.stores (id) on delete cascade,
  product_id      uuid not null references public.products (id) on delete cascade,
  stock_period_id uuid not null references public.stock_periods (id) on delete cascade,
  old_qty         qty not null,
  new_qty         qty not null,
  reason          text not null check (length(trim(reason)) > 0),
  edited_by       uuid default auth.uid() references auth.users (id),
  edited_at       timestamptz not null default now()
);

create index if not exists stock_count_edits_period
  on public.stock_count_edits (stock_period_id, edited_at);

alter table public.stock_count_edits enable row level security;

drop trigger if exists no_mutation on public.stock_count_edits;
create trigger no_mutation before update or delete on public.stock_count_edits
  for each row execute function public.tg_append_only();

drop policy if exists stock_count_edits_read on public.stock_count_edits;
create policy stock_count_edits_read on public.stock_count_edits
  for select using (public.is_store_member(store_id));

drop policy if exists stock_count_edits_none on public.stock_count_edits;
create policy stock_count_edits_none on public.stock_count_edits
  for insert with check (false);

-- ─── Enter a physical count (0006, plus: once a day) ────────────────────────────────

create or replace function public.enter_stock_count(
  p_period_id uuid,
  p_counted   qty
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p        record;
  v_within   boolean;
  v_name     text;
  v_by       text;
begin
  select * into v_p from public.stock_periods where id = p_period_id;
  if not found then
    raise exception 'unknown stock period' using errcode = '23503';
  end if;
  if not public.has_permission(v_p.store_id, 'stock.count') then
    raise exception 'you do not have permission to enter counts' using errcode = '42501';
  end if;
  if v_p.status <> 'open' then
    raise exception 'this period is already %', v_p.status using errcode = '22023';
  end if;

  -- ONCE A DAY. The item row is locked so two screens counting in the same second queue, and the
  -- second sees the first's count rather than overwriting it.
  select name into v_name from public.products where id = v_p.product_id for update;
  if public.product_counted_today(v_p.product_id) then
    select public.member_name(sp.store_id, sp.counted_by) into v_by
      from public.stock_periods sp
     where sp.product_id = v_p.product_id and sp.counted_at is not null
     order by sp.counted_at desc
     limit 1;
    raise exception '% was already counted today by %. An owner or manager can correct it.',
      coalesce(v_name, 'This item'), coalesce(v_by, 'someone')
      using errcode = 'unique_violation';
  end if;

  -- Recompute from the ledger first, so the expectation reflects every movement recorded up to
  -- this moment — including anything that synced from an offline device seconds ago.
  perform public.refresh_period(p_period_id);

  update public.stock_periods
     set actual_closing_qty = p_counted,
         counted_by = auth.uid(),
         counted_at = now()
   where id = p_period_id;

  select * into v_p from public.stock_periods where id = p_period_id;
  v_within := public.variance_within_tolerance(p_period_id);

  return jsonb_build_object(
    'period_id',        p_period_id,
    'opening',          v_p.opening_qty,
    'receiving',        v_p.receiving_qty,
    'sales',            v_p.sales_qty,
    'damaged',          v_p.damaged_qty,
    'other',            v_p.other_qty,
    'expected_closing', v_p.expected_closing_qty,
    'actual_closing',   v_p.actual_closing_qty,
    'variance',         v_p.variance_qty,
    'within_tolerance', v_within,
    'needs_resolution', (v_p.variance_qty is distinct from 0) and not v_within
  );
end;
$$;

-- ─── Correct today's count ──────────────────────────────────────────────────────────

create or replace function public.correct_todays_count(
  p_product_id uuid,
  p_counted    qty,
  p_reason     text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store_id uuid;
  v_name     text;
  v_p        record;
  v_old      numeric;
  v_next     uuid;
begin
  select store_id, name into v_store_id, v_name
    from public.products where id = p_product_id
     for update;
  if v_store_id is null then
    raise exception 'That item no longer exists.' using errcode = 'no_data_found';
  end if;

  if not public.has_permission(v_store_id, 'counts.correct') then
    raise exception 'Only an owner or manager can change a count once it has been entered.'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Say why the count is being changed.' using errcode = '22023';
  end if;
  if p_counted is null or p_counted < 0 then
    raise exception 'A count cannot be below nothing.' using errcode = '22023';
  end if;

  -- Today's count, on the shop's own calendar.
  select sp.* into v_p
    from public.stock_periods sp
    join public.stores st on st.id = sp.store_id
   where sp.product_id = p_product_id
     and sp.counted_at is not null
     and (sp.counted_at at time zone coalesce(st.timezone, 'UTC'))::date
         = (now() at time zone coalesce(st.timezone, 'UTC'))::date
   order by sp.counted_at desc
   limit 1
     for update of sp;

  if not found then
    raise exception '% has not been counted today, so there is nothing to correct.', v_name
      using errcode = 'no_data_found';
  end if;
  if v_p.status = 'locked' then
    raise exception 'This count is in a locked period and cannot be changed.' using errcode = '22023';
  end if;

  v_old := v_p.actual_closing_qty;
  if v_old = p_counted then
    raise exception 'That is already the figure recorded.' using errcode = '22023';
  end if;

  insert into public.stock_count_edits (store_id, product_id, stock_period_id, old_qty, new_qty, reason)
  values (v_store_id, p_product_id, v_p.id, v_old, p_counted, trim(p_reason));

  insert into public.audit_log (store_id, table_name, record_id, op, prior_value, new_value, reason)
  values (v_store_id, 'stock_periods', v_p.id, 'update',
          jsonb_build_object('actual_closing_qty', v_old),
          jsonb_build_object('actual_closing_qty', p_counted), trim(p_reason));

  if v_p.status = 'open' then
    perform public.refresh_period(v_p.id);
    -- counted_by and counted_at stay as they were: they say who counted FIRST. The edit row says the rest.
    update public.stock_periods set actual_closing_qty = p_counted where id = v_p.id;
  else
    update public.stock_periods set actual_closing_qty = p_counted where id = v_p.id;

    -- The period this one handed its count to.
    select id into v_next
      from public.stock_periods
     where product_id = p_product_id
       and period_start >= v_p.closed_at
     order by period_start
     limit 1
       for update;
    if v_next is not null then
      update public.stock_periods
         set opening_qty = opening_qty + (p_counted - v_old)
       where id = v_next;
    end if;
  end if;
end;
$fn$;

revoke all on function public.correct_todays_count(uuid, qty, text) from public;
grant execute on function public.correct_todays_count(uuid, qty, text) to authenticated;

-- ─── Who counted what today ─────────────────────────────────────────────────────────

create or replace function public.todays_counts(p_product_ids uuid[])
returns table (
  product_id       uuid,
  period_id        uuid,
  period_status    text,
  counted_qty      numeric,
  first_qty        numeric,
  counted_by_name  text,
  counted_by_you   boolean,
  counted_at       timestamptz,
  edits            int,
  last_edited_by   text,
  last_edited_at   timestamptz,
  last_reason      text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select distinct on (sp.product_id)
         sp.product_id,
         sp.id,
         sp.status,
         sp.actual_closing_qty,
         coalesce(
           (select e.old_qty from public.stock_count_edits e
             where e.stock_period_id = sp.id order by e.edited_at limit 1),
           sp.actual_closing_qty
         ),
         public.member_name(sp.store_id, sp.counted_by),
         sp.counted_by = auth.uid(),
         sp.counted_at,
         (select count(*)::int from public.stock_count_edits e where e.stock_period_id = sp.id),
         (select public.member_name(e.store_id, e.edited_by) from public.stock_count_edits e
           where e.stock_period_id = sp.id order by e.edited_at desc limit 1),
         (select e.edited_at from public.stock_count_edits e
           where e.stock_period_id = sp.id order by e.edited_at desc limit 1),
         (select e.reason from public.stock_count_edits e
           where e.stock_period_id = sp.id order by e.edited_at desc limit 1)
    from public.stock_periods sp
    join public.stores st on st.id = sp.store_id
   where sp.product_id = any (p_product_ids)
     and public.is_store_member(sp.store_id)
     and sp.counted_at is not null
     and (sp.counted_at at time zone coalesce(st.timezone, 'UTC'))::date
         = (now() at time zone coalesce(st.timezone, 'UTC'))::date
   order by sp.product_id, sp.counted_at desc;
$fn$;

grant execute on function public.todays_counts(uuid[]) to authenticated;

-- Every change to one item's count today, oldest first, starting with the count itself.
create or replace function public.todays_count_trail(p_product_id uuid)
returns table (
  kind     text,
  qty      numeric,
  old_qty  numeric,
  reason   text,
  by_name  text,
  by_you   boolean,
  at       timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with today as (
    select sp.*
      from public.stock_periods sp
      join public.stores st on st.id = sp.store_id
     where sp.product_id = p_product_id
       and public.is_store_member(sp.store_id)
       and sp.counted_at is not null
       and (sp.counted_at at time zone coalesce(st.timezone, 'UTC'))::date
           = (now() at time zone coalesce(st.timezone, 'UTC'))::date
     order by sp.counted_at desc
     limit 1
  )
  select 'counted',
         coalesce(
           (select e.old_qty from public.stock_count_edits e
             where e.stock_period_id = t.id order by e.edited_at limit 1),
           t.actual_closing_qty
         ),
         null::numeric,
         null::text,
         public.member_name(t.store_id, t.counted_by),
         t.counted_by = auth.uid(),
         t.counted_at
    from today t
  union all
  select 'corrected', e.new_qty, e.old_qty, e.reason,
         public.member_name(e.store_id, e.edited_by),
         e.edited_by = auth.uid(),
         e.edited_at
    from public.stock_count_edits e
    join today t on t.id = e.stock_period_id
   order by 7;
$fn$;

grant execute on function public.todays_count_trail(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('enter_stock_count', 'correct_todays_count', 'todays_counts',
                          'todays_count_trail', 'member_name')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a count function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$check$;
