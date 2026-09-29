-- 0218 - The day keeps running; the variance stays pinned to the count
--
-- 0213 stopped a period's arithmetic at the count, so that a sale made afterwards could not turn
-- a correct count into a phantom surplus. It worked — 28 bogus variances went to 2 — but it paid
-- for it with a second oddity the shop would meet within the hour: the card then read "should be
-- on the shelf: 2 packs" all day, while the shelf really held 1, because the period had stopped
-- counting anything after the morning count.
--
-- Those are two different questions and they were sharing one answer:
--
--   WHAT SHOULD BE ON THE SHELF NOW — a running figure, moving with every sale, which is what a
--   shop looks at during the day.
--
--   WHAT THE RECORDS EXPECTED WHEN THE SHELF WAS COUNTED — a fact about one moment, which is the
--   only thing a count can honestly be compared against.
--
-- So the aggregates track the whole period again, and `expected_at_count` holds the figure the
-- count was measured against. `variance_qty` is generated from that when it exists, so a count
-- stays square however much trading follows it.
--
-- `resolve_variance` goes back to dating its movements `now()`: they are real events in the
-- running period, and the variance no longer moves under them. A 'miscount' now restates the
-- count to the figure it was measured against, which is what "I miscounted" actually means.

alter table public.stock_periods
  add column if not exists expected_at_count numeric;

/*
 * BACKFILLED BEFORE THE WINDOW CHANGES.
 *
 * Right now `expected_closing_qty` IS the as-at-count figure, because 0213 clamped the window
 * there. Copying it first is what carries the corrected variances through this migration instead
 * of recreating every phantom the moment the window widens again.
 */
update public.stock_periods
   set expected_at_count = expected_closing_qty
 where counted_at is not null and expected_at_count is null;

-- ── The variance is measured against the count's own expectation ────────────────
alter table public.stock_periods drop column if exists variance_qty;

alter table public.stock_periods
  add column variance_qty numeric
  generated always as (
    case
      when actual_closing_qty is null then null
      else actual_closing_qty
           - coalesce(expected_at_count,
                      opening_qty + receiving_qty - sales_qty - damaged_qty + other_qty)
    end
  ) stored;

create or replace function public.refresh_period(p_period_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_p record;
begin
  select * into v_p from public.stock_periods where id = p_period_id;
  if not found or v_p.status <> 'open' then
    return;
  end if;

  update public.stock_periods sp
     set receiving_qty = coalesce(agg.receiving, 0),
         sales_qty     = coalesce(agg.sales, 0),
         damaged_qty   = coalesce(agg.damaged, 0),
         other_qty     = coalesce(agg.other, 0)
    from (
      select
        sum(case when m.kind in ('receive','transfer_in')      then m.qty_delta else 0 end) as receiving,
        -- Stored positive: the CRODS formula subtracts them, and a double negative reads badly
        -- to anyone checking the arithmetic by hand, which people will do.
        sum(case when m.kind = 'sale'   then -m.qty_delta else 0 end) as sales,
        sum(case when m.kind = 'damage' then -m.qty_delta else 0 end) as damaged,
        sum(case when m.kind in ('return_in','repack_loss','adjustment','transfer_out')
                 then m.qty_delta else 0 end) as other
      from public.stock_movements m
      where m.product_id  = v_p.product_id
        and m.occurred_at >= v_p.period_start
        /*
         * UP TO THE COUNT, once there is one (0213).
         *
         * A count is a statement about a moment; the expectation it is compared against has to be
         * about the same moment. This read to the end of the period, so a sale made after the
         * shelf was counted moved the expectation and left the count looking like a surplus.
         */
        /*
         * THE WHOLE PERIOD AGAIN (0218). 0213 ended this at the count so a sale afterwards could
         * not make the count look wrong; that job has moved to `expected_at_count`, which pins
         * the comparison to the moment of counting. These figures are "what has happened in this
         * period", and a shop watching its day needs them to keep moving.
         */
        and m.occurred_at < coalesce(v_p.period_end, 'infinity'::timestamptz)
    ) agg
   where sp.id = p_period_id;
end;
$function$;

create or replace function public.enter_stock_count(
  p_period_id uuid,
  p_counted qty,
  p_reason text DEFAULT NULL::text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
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

  /*
   * THE COUNT IS STAMPED FIRST, AND THE ARITHMETIC FOLLOWS IT (0215).
   *
   * `refresh_period` now aggregates up to `counted_at` (0213), so the order of these two matters
   * and it used to be the wrong way round. Refreshing first meant a RE-COUNT was computed against
   * the PREVIOUS count's boundary: everything received or sold since the last count was left out
   * of the expectation, and the fresh count then looked like a surplus of exactly that amount.
   *
   * Stamping first makes the boundary the moment being recorded, and the refresh that follows
   * reflects every movement up to it — including anything that synced from an offline device
   * seconds ago, which is what the original note here was about.
   */
  /*
   * WHAT THE RECORDS EXPECTED AT THIS INSTANT, kept (0218).
   *
   * The variance is a statement about the moment of counting and must not drift as the day goes
   * on. The period's running figures DO go on — the shop still needs "what should be on the shelf
   * now" — so the two are separated: the aggregates track the whole period, and this holds the
   * figure the count was actually measured against.
   */
  update public.stock_periods sp
     set actual_closing_qty = p_counted,
         counted_by = auth.uid(),
         counted_at = now(),
         expected_at_count = sp.opening_qty + coalesce(agg.receiving, 0)
                             - coalesce(agg.sales, 0) - coalesce(agg.damaged, 0)
                             + coalesce(agg.other, 0)
    from (
      select
        sum(case when m.kind in ('receive','transfer_in') then m.qty_delta else 0 end) as receiving,
        sum(case when m.kind = 'sale'   then -m.qty_delta else 0 end) as sales,
        sum(case when m.kind = 'damage' then -m.qty_delta else 0 end) as damaged,
        sum(case when m.kind in ('return_in','repack_loss','adjustment','transfer_out')
                 then m.qty_delta else 0 end) as other
      from public.stock_movements m
      where m.product_id = v_p.product_id
        and m.occurred_at >= v_p.period_start
        and m.occurred_at <= now()
    ) agg
   where sp.id = p_period_id;

  perform public.refresh_period(p_period_id);

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
$function$;

create or replace function public.resolve_variance(
  p_period_id uuid,
  p_parts jsonb,
  p_note text DEFAULT NULL::text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_p        record;
  v_avg_cost unit_cost;
  v_parts    jsonb;
  v_part     jsonb;
  v_qty      numeric;
  v_reason   text;
  -- What the SHOP called it. 'unlogged_damage' is the treatment; "Fell off the truck" is the reason
  -- somebody will recognise in a report six weeks later.
  v_label    text;
  v_sum      numeric := 0;
  v_id       uuid;
  v_ids      uuid[] := '{}';
  v_member   uuid;
  v_customer uuid;
  v_charge   numeric;
  v_sign     int;
begin
  select * into v_p from public.stock_periods where id = p_period_id;
  if not found then
    raise exception 'unknown stock period' using errcode = '23503';
  end if;
  if not public.has_permission(v_p.store_id, 'variance.resolve') then
    raise exception 'you do not have permission to resolve variances' using errcode = '42501';
  end if;
  if v_p.variance_qty is null then
    raise exception 'enter a physical count before resolving' using errcode = '22023';
  end if;
  if v_p.status <> 'open' then
    raise exception 'this period is already %', v_p.status using errcode = '22023';
  end if;

  /*
   * A BARE OBJECT IS ONE PART.
   *
   * The single-reason case is still the common one — most gaps are a miscount — and making every
   * caller wrap it in an array would be ceremony for nothing.
   */
  v_parts := case
               when jsonb_typeof(p_parts) = 'object' then jsonb_build_array(p_parts)
               else p_parts
             end;

  if v_parts is null or jsonb_typeof(v_parts) <> 'array' or jsonb_array_length(v_parts) = 0 then
    raise exception 'say what happened to the missing stock' using errcode = '22023';
  end if;

  select avg_unit_cost into v_avg_cost from public.products where id = v_p.product_id;

  /*
   * THE PARTS MUST ADD UP TO THE VARIANCE, EXACTLY.
   *
   * Not "at most". A remainder is an unexplained shortfall, and an unexplained shortfall is the one
   * thing a period is not allowed to close on — letting the parts fall short would move that gap
   * from a blocked close to a number nobody ever looks at again.
   *
   * The parts are given as PLAIN QUANTITIES and take the variance's sign. Asking somebody to type
   * "-24" for twenty-four broken bottles is asking for a sign error in front of a shelf.
   */
  v_sign := case when v_p.variance_qty < 0 then -1 else 1 end;

  for v_part in select * from jsonb_array_elements(v_parts)
  loop
    v_qty := abs((v_part ->> 'qty')::numeric);
    if v_qty is null or v_qty <= 0 then
      raise exception 'each reason needs a quantity' using errcode = '22023';
    end if;
    v_sum := v_sum + v_qty;
  end loop;

  if v_sum <> abs(v_p.variance_qty) then
    raise exception 'the reasons add up to %, but the count is off by % — every one has to be accounted for',
      v_sum, abs(v_p.variance_qty) using errcode = '22023';
  end if;

  for v_part in select * from jsonb_array_elements(v_parts)
  loop
    v_qty    := abs((v_part ->> 'qty')::numeric) * v_sign;
    v_reason := v_part ->> 'reason';
    v_label  := nullif(v_part ->> 'label', '');
    v_member := nullif(v_part ->> 'charge_to_member_id', '')::uuid;  -- a user_id in this shop
    v_customer := nullif(v_part ->> 'charge_to_customer_id', '')::uuid;

    insert into public.variance_resolutions (store_id, stock_period_id, qty, reason, reason_label,
                                             note, value_at_cost)
    values (v_p.store_id, p_period_id, v_qty, v_reason, v_label,
            coalesce(v_part ->> 'note', p_note),
            case when v_reason = 'miscount' then 0
                 else abs(v_qty) * coalesce(v_avg_cost, 0) end)
    returning id into v_id;
    v_ids := v_ids || v_id;

    /*
     * ONE MOVEMENT PER PART, and the KIND says which.
     *
     * The old function wrote a single blended `adjustment`. Twenty-four broken and thirty-five
     * stolen became "adjustment 59", and no report could ever separate them again — which is the
     * report an owner actually wants. `damage` is its own movement kind and has been since 0003.
     */
    if v_reason = 'miscount' then
      -- To the figure the count was MEASURED against, which is what "I miscounted" means (0218).
      update public.stock_periods
         set actual_closing_qty = coalesce(expected_at_count, expected_closing_qty)
       where id = p_period_id;
    else
      insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                          ref_table, ref_id, note, occurred_at)
      values (v_p.store_id, v_p.product_id,
              case when v_reason = 'unlogged_damage' then 'damage' else 'adjustment' end,
              v_qty, coalesce(v_avg_cost, 0), 'variance_resolutions', v_id,
              coalesce(v_part ->> 'note', p_note, v_reason),
              /*
               * DATED INSIDE THE PERIOD IT SETTLES (0216, corrected by 0217).
               *
               * A resolution is not a new event in the shop's day. It explains a difference the
               * count FOUND — breakage, or a theft that happened during the period — so it
               * belongs before the count rather than after it.
               *
               * Stamped `now()` it fell outside the period's window once 0213 ended that window
               * at `counted_at`, so a resolution stopped reconciling the period it was resolving.
               * Stamped exactly AT `counted_at` it fell into the NEXT period instead — the window
               * ends exclusively and the next one begins there — so the loss came off a second
               * time, from an opening figure that already reflected it. A millisecond inside the
               * boundary is the one place it is counted once.
               */
              now());
    end if;

    /*
     * AND WHO ANSWERS FOR IT, when somebody does.
     *
     * The amount defaults to what the stock cost and can be overridden, because a shop recovers
     * what it sells for rather than what it paid. Naming nobody is the common case and stays
     * perfectly valid — a form that demands a culprit gets a guess, and a guess in this table is
     * worse than a blank.
     */
    if v_member is not null or v_customer is not null then
      v_charge := coalesce((v_part ->> 'charge_amount')::numeric,
                           abs(v_qty) * coalesce(v_avg_cost, 0));

      if v_charge > 0 and v_member is not null then
        perform public.record_staff_charge(
          v_p.store_id, v_member, v_charge, 'charged',
          coalesce(v_part ->> 'note', 'Stock missing at a count'),
          'variance_resolutions', v_id);
      end if;

      if v_charge > 0 and v_customer is not null then
        perform public.record_customer_charge(
          v_p.store_id, v_customer, v_charge,
          coalesce(v_part ->> 'note', 'Stock missing at a count'),
          false);
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'period_id', p_period_id,
    'parts',     jsonb_array_length(v_parts),
    'ids',       to_jsonb(v_ids)
  );
end;
$function$;

grant execute on function public.enter_stock_count(uuid, qty, text) to authenticated;
grant execute on function public.resolve_variance(uuid, jsonb, text) to authenticated;

/*
 * Every open period recomputed under the full window; the pinned expectations are untouched.
 *
 * ONLY WHERE THE SHOP STILL EXISTS. Fifty-eight periods here belong to benchmark shops that have
 * been dropped, and their `store_id` no longer resolves — so any update to them is refused by the
 * foreign key, which took the whole migration down with it on the first attempt. They are
 * unreachable rows for a shop nobody can open; they are left exactly as they are.
 */
do $$
declare r record;
begin
  for r in
    select sp.id from public.stock_periods sp
     join public.stores st on st.id = sp.store_id
    where sp.status = 'open'
  loop
    perform public.refresh_period(r.id);
  end loop;
end $$;

notify pgrst, 'reload schema';
