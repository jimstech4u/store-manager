-- 0146 — The shelf can be counted again; the figure it replaces is never lost
--
-- «we allow a fresh count each time (not from mid sales, that one is once), but the one in the stock
--  stack can be fresh, but we do not lose the old entry, we show the logs of changes so we can track
--  what was written before, with role permission — because only a manager or allowed role can submit
--  a fresh one. So we ensure that any trace of one trying to manipulate the stock is known»
--
-- ─── What 0145 got wrong ────────────────────────────────────────────────────────────
--
-- It made a day's count a single figure and turned any second count into a "correction". That is the
-- right shape for the TILL — counting mid-sale is one figure, entered by whoever reaches the shelf
-- first — and the wrong shape for the shop: a delivery arrives at two, a manager walks the shelf at
-- six, and that is a COUNT, not an admission that the morning count was a mistake.
--
-- So the count screen may count again, as often as the shop likes, and each fresh count:
--   · needs `counts.correct` — a seller cannot quietly replace a figure somebody else recorded;
--   · needs a reason, which is what makes a trail readable a week later;
--   · writes the figure it replaces to `stock_count_edits` before it moves anything.
--
-- The till is untouched: `count_from_till` still refuses a second count for anybody, whatever their
-- role. One count per item per day mid-sale, exactly as before.
--
-- A single act, not two. `correct_todays_count` (0145) is dropped: counting again with a reason IS
-- the correction, and two ways to change one figure is two trails and one more thing to explain.

-- ─── The trail says which kind of change it was ─────────────────────────────────────

alter table public.stock_count_edits
  add column if not exists kind text not null default 'recount';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_count_edits_kind_check') then
    alter table public.stock_count_edits
      add constraint stock_count_edits_kind_check check (kind in ('recount', 'correction'));
  end if;
end;
$$;

create index if not exists stock_count_edits_product
  on public.stock_count_edits (product_id, edited_at desc);

-- ─── Entering a count, including one that replaces today's ──────────────────────────
--
-- Dropped and recreated rather than replaced: the reason is a new argument, and a second overload
-- would make PostgREST answer 300 to every call (0058). Existing callers pass two arguments and
-- still resolve, because the third has a default.

drop function if exists public.enter_stock_count(uuid, qty);

create or replace function public.enter_stock_count(
  p_period_id uuid,
  p_counted   qty,
  p_reason    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_p      record;
  v_within boolean;
  v_name   text;
  v_prev   numeric;
  v_by     text;
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

  /*
   * IS THERE ALREADY A COUNT TODAY — in this period or in one closed earlier today?
   *
   * The item row is locked first, so two people counting in the same second queue rather than both
   * writing: the second sees the first's figure and records that it is replacing it.
   */
  select name into v_name from public.products where id = v_p.product_id for update;

  select sp.actual_closing_qty, public.member_name(sp.store_id, sp.counted_by)
    into v_prev, v_by
    from public.stock_periods sp
    join public.stores st on st.id = sp.store_id
   where sp.product_id = v_p.product_id
     and sp.counted_at is not null
     and (sp.counted_at at time zone coalesce(st.timezone, 'UTC'))::date
         = (now() at time zone coalesce(st.timezone, 'UTC'))::date
   order by sp.counted_at desc
   limit 1;

  if v_prev is not null then
    -- A FRESH COUNT REPLACES A FIGURE SOMEBODY ELSE RECORDED, so it is not everybody's to make.
    if not public.has_permission(v_p.store_id, 'counts.correct') then
      raise exception
        '% was already counted today by %. Only an owner or manager can count it again.',
        coalesce(v_name, 'This item'), coalesce(v_by, 'someone')
        using errcode = 'unique_violation';
    end if;
    if coalesce(trim(p_reason), '') = '' then
      raise exception 'Say why the shelf is being counted again.' using errcode = '22023';
    end if;

    -- WRITTEN BEFORE ANYTHING MOVES. The figure being replaced is the whole point of the trail.
    insert into public.stock_count_edits
      (store_id, product_id, stock_period_id, old_qty, new_qty, reason, kind)
    values (v_p.store_id, v_p.product_id, p_period_id, v_prev, p_counted, trim(p_reason), 'recount');

    insert into public.audit_log (store_id, table_name, record_id, op, prior_value, new_value, reason)
    values (v_p.store_id, 'stock_periods', p_period_id, 'update',
            jsonb_build_object('counted', v_prev),
            jsonb_build_object('counted', p_counted), trim(p_reason));
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
$fn$;

revoke all on function public.enter_stock_count(uuid, qty, text) from public;
grant execute on function public.enter_stock_count(uuid, qty, text) to authenticated;

-- ONE ACT, not two: counting again with a reason is the correction.
drop function if exists public.correct_todays_count(uuid, qty, text);

-- ─── Who counted what today, first and last ─────────────────────────────────────────

drop function if exists public.todays_counts(uuid[]);

create function public.todays_counts(p_product_ids uuid[])
returns table (
  product_id       uuid,
  period_id        uuid,
  period_status    text,
  counted_qty      numeric,
  first_qty        numeric,
  counted_by_name  text,
  counted_by_you   boolean,
  counted_at       timestamptz,
  first_by_name    text,
  first_at         timestamptz,
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
  with today as (
    select sp.*
      from public.stock_periods sp
      join public.stores st on st.id = sp.store_id
     where sp.product_id = any (p_product_ids)
       and public.is_store_member(sp.store_id)
       and sp.counted_at is not null
       and (sp.counted_at at time zone coalesce(st.timezone, 'UTC'))::date
           = (now() at time zone coalesce(st.timezone, 'UTC'))::date
  ),
  changes as (
    select e.*
      from public.stock_count_edits e
     where e.product_id = any (p_product_ids)
       and e.stock_period_id in (select id from today)
  )
  select distinct on (t.product_id)
         t.product_id,
         t.id,
         t.status,
         t.actual_closing_qty,
         -- What was said FIRST today: the figure the earliest change replaced, or the count itself
         -- when nothing has replaced anything.
         coalesce(
           (select c.old_qty from changes c
             where c.product_id = t.product_id order by c.edited_at limit 1),
           t.actual_closing_qty
         ),
         public.member_name(t.store_id, t.counted_by),
         t.counted_by = auth.uid(),
         t.counted_at,
         (select public.member_name(f.store_id, f.counted_by) from today f
           where f.product_id = t.product_id order by f.counted_at limit 1),
         (select f.counted_at from today f
           where f.product_id = t.product_id order by f.counted_at limit 1),
         (select count(*)::int from changes c where c.product_id = t.product_id),
         (select public.member_name(c.store_id, c.edited_by) from changes c
           where c.product_id = t.product_id order by c.edited_at desc limit 1),
         (select c.edited_at from changes c
           where c.product_id = t.product_id order by c.edited_at desc limit 1),
         (select c.reason from changes c
           where c.product_id = t.product_id order by c.edited_at desc limit 1)
    from today t
   order by t.product_id, t.counted_at desc;
$fn$;

grant execute on function public.todays_counts(uuid[]) to authenticated;

-- ─── Every count of the day for one item, oldest first ──────────────────────────────

drop function if exists public.todays_count_trail(uuid);

create function public.todays_count_trail(p_product_id uuid)
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
  ),
  changes as (
    select e.* from public.stock_count_edits e
     where e.stock_period_id in (select id from today)
  ),
  -- The first walk of the shelf today. Every later one is a change row, with what it replaced.
  first_count as (
    select * from today order by counted_at limit 1
  )
  select 'counted',
         coalesce((select c.old_qty from changes c order by c.edited_at limit 1),
                  f.actual_closing_qty),
         null::numeric,
         null::text,
         public.member_name(f.store_id, f.counted_by),
         f.counted_by = auth.uid(),
         f.counted_at
    from first_count f
  union all
  select c.kind, c.new_qty, c.old_qty, c.reason,
         public.member_name(c.store_id, c.edited_by),
         c.edited_by = auth.uid(),
         c.edited_at
    from changes c
   order by 7;
$fn$;

grant execute on function public.todays_count_trail(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('enter_stock_count', 'todays_counts', 'todays_count_trail',
                          'count_from_till', 'needs_count_today')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a count function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;

  if exists (select 1 from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
              where ns.nspname = 'public' and pr.proname = 'correct_todays_count') then
    raise exception 'correct_todays_count still exists; counting again is the only correction';
  end if;
end;
$check$;
