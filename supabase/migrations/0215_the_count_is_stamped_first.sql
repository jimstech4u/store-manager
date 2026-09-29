-- 0215 - The count is stamped before the arithmetic that depends on it
--
-- My regression from 0213, caught by the benchmark: ten checks across the two recount scenarios.
--
-- 0213 made `refresh_period` aggregate up to `counted_at`, so that a count is measured against the
-- shelf as it stood when it was taken. `enter_stock_count` refreshed BEFORE stamping the new
-- `counted_at`, which was harmless while the window ran to the end of the period and is not now: a
-- re-count was computed against the PREVIOUS count's boundary, so everything received or sold since
-- was left out of the expectation and the new count read as a surplus of exactly that amount.
--
-- "the records expected what the shelf said before — 240, expected 396", which is the benchmark
-- saying a delivery of 156 had gone missing from the arithmetic.
--
-- Stamp, then compute. Everything else is the live definition, byte for byte.

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
  update public.stock_periods
     set actual_closing_qty = p_counted,
         counted_by = auth.uid(),
         counted_at = now()
   where id = p_period_id;

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

grant execute on function public.enter_stock_count(uuid, qty, text) to authenticated;

notify pgrst, 'reload schema';
