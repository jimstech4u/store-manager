-- 0144 — "Counted today" means a count was entered today, once, and nothing sells before it
--
-- «we are to check if the item count for the day has been entered, not the timestamp in receipt or
--  draft … something that will not accept multiple entry … not double count when open multiple
--  receipts … block on take payment or accept payment until the item is counted»
--
-- ─── ONE: the question being asked was the wrong one ────────────────────────────────
--
-- `needs_count_today` (0107) said an item was fine if it had ANY OPEN counting period, or a period
-- closed today. An open period is not a count: a period opened three weeks ago and never counted
-- satisfied it every day since. The question the shop is asking is simpler and is the one answered
-- now — has somebody entered a count for this item on the shop's own calendar day?
--
-- ─── TWO: two devices, one item, two counts ─────────────────────────────────────────
--
-- `count_from_till` opened a period and entered the figure, every time it was called. Two tills with
-- the same item on two receipts both got the count page, both counted, and the second silently
-- overwrote the first. It now takes a lock on the item, looks for today's count, and REFUSES a
-- second one with `unique_violation` — which the till reads as "somebody already did this" rather
-- than as a failure, drops the line and carries on. The lock is what makes it true under a race:
-- two calls in the same second queue, and the second sees the first's count.
--
-- The count SCREEN (`enter_stock_count` directly) is untouched. A manager recounting a shelf to
-- resolve a variance is a different act from the day's opening count at a till, and must be allowed.
--
-- ─── THREE: the server refuses the sale, not just the screen ────────────────────────
--
-- The till and Take payment block settling while an item on the sale is uncounted, but a screen is
-- only a screen — another device, an old build, a retry. A trigger on `sale_lines` refuses a NEW
-- sale's line for an item not counted today. "New" is exactly `sales.created_at = now()`: `now()` is
-- the transaction's start, so it is true for the sale being settled in this transaction and false for
-- a correction to an old receipt (`amend_sale` re-inserts lines on a sale created long ago), which
-- must stay possible whatever today's shelf says.
--
-- THE CHECK DOES NOT ASK WHO IS ASKING. The reader keeps its membership test, because an empty
-- answer is right for a READ; the guard uses a membership-free twin, because "not a member, so
-- nothing counted" would fail CLOSED for the service role and OPEN nowhere — see the
-- `assert_product_units_settled` lesson in CLAUDE.md.

-- ─── The fact itself, without a membership test, for guards ─────────────────────────

create or replace function public.product_counted_today(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from public.stock_periods sp
      join public.products p on p.id = sp.product_id
      join public.stores st on st.id = p.store_id
     where sp.product_id = p_product_id
       and sp.counted_at is not null
       and (sp.counted_at at time zone coalesce(st.timezone, 'UTC'))::date
           = (now() at time zone coalesce(st.timezone, 'UTC'))::date
  );
$fn$;

revoke all on function public.product_counted_today(uuid) from public;
-- Not granted to clients: it answers for any product regardless of shop. Readers go through
-- `needs_count_today`, which keeps the membership test.

-- ─── The reader the till asks ───────────────────────────────────────────────────────

create or replace function public.needs_count_today(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
           select 1 from public.products p
            where p.id = p_product_id and public.is_store_member(p.store_id)
         )
     and not public.product_counted_today(p_product_id);
$fn$;

grant execute on function public.needs_count_today(uuid) to authenticated;

-- ─── One count per item per day, from the till ──────────────────────────────────────

create or replace function public.count_from_till(
  p_product_id uuid,
  p_counted    qty
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store_id uuid;
  v_period   uuid;
  v_name     text;
begin
  /*
   * THE ITEM ROW IS LOCKED FIRST.
   *
   * Two tills counting the same item in the same second both used to pass any check and both write.
   * With the row locked the second call waits, then finds the first call's count and is refused.
   */
  select store_id, name into v_store_id, v_name
    from public.products where id = p_product_id
     for update;
  if v_store_id is null then
    raise exception 'That item no longer exists.' using errcode = 'no_data_found';
  end if;

  if not (public.has_permission(v_store_id, 'sales.record')
          or public.has_permission(v_store_id, 'stock.count')) then
    raise exception 'You do not have permission to record what is on the shelf.'
      using errcode = 'insufficient_privilege';
  end if;

  if public.product_counted_today(p_product_id) then
    raise exception '% has already been counted today.', v_name
      using errcode = 'unique_violation';
  end if;

  v_period := public.ensure_open_period(p_product_id);
  perform public.enter_stock_count(v_period, p_counted);

  return v_period;
end;
$fn$;

grant execute on function public.count_from_till(uuid, qty) to authenticated;

-- ─── Nothing sells before it is counted ─────────────────────────────────────────────

create or replace function public.tg_sale_line_needs_todays_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_new  boolean;
  v_name text;
begin
  -- Only a sale being created in THIS transaction. A correction to an old receipt is not a sale made
  -- today and must stay possible whatever today's shelf says.
  select s.created_at = now() into v_new from public.sales s where s.id = new.sale_id;
  if not coalesce(v_new, false) then
    return new;
  end if;

  if public.product_counted_today(new.product_id) then
    return new;
  end if;

  select name into v_name from public.products where id = new.product_id;
  raise exception '% has not been counted today. Count the shelf before selling it.',
    coalesce(v_name, 'An item on this sale')
    using errcode = '22023';
end;
$fn$;

drop trigger if exists sale_line_needs_todays_count on public.sale_lines;
create trigger sale_line_needs_todays_count
  before insert on public.sale_lines
  for each row execute function public.tg_sale_line_needs_todays_count();

comment on function public.tg_sale_line_needs_todays_count() is
  'Refuses a line on a sale created in this transaction for an item nobody has counted today (shop '
  'day). Corrections to older sales are not affected.';

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('needs_count_today', 'count_from_till', 'product_counted_today',
                          'which_need_count')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a count function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$check$;
