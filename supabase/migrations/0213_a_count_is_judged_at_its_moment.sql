-- 0213 - A count is judged against the shelf as it was WHEN IT WAS COUNTED
--
-- Reported, and it is the most dangerous thing found so far:
--
--   "i counted aquafina, i started with 2 ... a day after i wanted to sell which asked correctly
--    to count before selling, which was still the 2, and i sold one, but the stock count page said
--    i counted one more and that is wrong."
--
-- Aquafina: counted 2 packs at 08:14, sold 1 pack at 08:18. The count was right when it was made.
-- Four minutes later `refresh_period` recomputed `sales_qty` from every movement in the period,
-- the generated `expected_closing_qty` dropped to 1 pack, and `actual_closing_qty` still held the
-- 2 that had been counted. The screen then reported a surplus of one pack that never existed.
--
-- THIS WAS NOT RARE. Of 28 products showing a variance in the first shop to use this, TWENTY-TWO
-- were entirely movement recorded after the count, and most of the rest were partly so. Every one
-- of them is an invitation to `resolve_variance`, which writes REAL stock movements — so the
-- software was inviting shops to correct their stock to make a phantom add up.
--
-- WHY IT HAPPENED. A count is a statement about a MOMENT. The period's expectation is a running
-- figure. Nothing tied the two together: `refresh_period` aggregated the whole period regardless
-- of when the count was taken, so the expectation went on moving under a fact that could not.
--
-- ── THE COUNT IS THE BOUNDARY ───────────────────────────────────────────────────
--
-- Once a shelf has been counted, that instant ends the period's arithmetic. Movements after it
-- belong to what happens next, which is exactly what a stock period is for.
--
--   · `refresh_period` aggregates up to `period_end`, else `counted_at`, else now. A count freezes
--     the expectation; counting again moves the boundary forward, which is right, because the
--     later count is the newer statement.
--
--   · `close_stock_period` ends the period AT THE COUNT rather than at the moment somebody
--     happened to press close, and opens the next one there. It used to end at `now()`, so every
--     sale between the count and the close was pulled back into the period it came after — the
--     same fault, in the other direction, and it would have survived a fix to `refresh_period`
--     alone. Nothing falls in a gap and nothing is counted twice.

create or replace function public.refresh_period(p_period_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
        and m.occurred_at < coalesce(v_p.period_end, v_p.counted_at, 'infinity'::timestamptz)
    ) agg
   where sp.id = p_period_id;
end;
$$;

create or replace function public.close_stock_period(p_period_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p        record;
  v_resolved numeric;
  v_next_id  uuid;
  v_at       timestamptz;
begin
  select * into v_p from public.stock_periods where id = p_period_id;
  if not found then
    raise exception 'unknown stock period' using errcode = '23503';
  end if;
  if not public.has_permission(v_p.store_id, 'stock.count') then
    raise exception 'you do not have permission to close periods' using errcode = '42501';
  end if;
  if v_p.status <> 'open' then
    raise exception 'this period is already %', v_p.status using errcode = '22023';
  end if;
  if v_p.actual_closing_qty is null then
    raise exception 'enter a physical count before closing' using errcode = '22023';
  end if;

  if v_p.variance_qty is distinct from 0
     and not public.variance_within_tolerance(p_period_id) then
    select coalesce(sum(abs(qty)), 0) into v_resolved
      from public.variance_resolutions where stock_period_id = p_period_id;

    if v_resolved < abs(v_p.variance_qty) then
      raise exception
        'this period is off by %, and only % of that has been explained',
        abs(v_p.variance_qty), v_resolved
        using errcode = '22023';
    end if;
  end if;

  /*
   * THE PERIOD ENDS AT THE COUNT, not at the moment somebody pressed close (0213).
   *
   * Otherwise every sale between the two is pulled back into a period whose closing figure was
   * measured before they happened — the same fault `refresh_period` had, arriving by a different
   * road. The next period starts at the same instant, so nothing falls in a gap.
   */
  v_at := coalesce(v_p.counted_at, now());

  update public.stock_periods
     set status     = 'closed',
         period_end = v_at,
         closed_by  = auth.uid(),
         closed_at  = now()
   where id = p_period_id;

  insert into public.stock_periods (store_id, product_id, period_start, opening_qty, status)
  values (v_p.store_id, v_p.product_id, v_at, v_p.actual_closing_qty, 'open')
  returning id into v_next_id;

  perform public.refresh_period(v_next_id);

  return v_next_id;
end;
$$;

/*
 * AND THE PHANTOM VARIANCES ALREADY ON THE BOOKS.
 *
 * Every open period is recomputed under the corrected window. Nothing is invented and no stock
 * moves: these columns are a restatement of `stock_movements`, which is untouched. What changes
 * is that a count is now measured against the shelf it was actually taken from.
 */
do $$
declare
  r record;
begin
  for r in select id from public.stock_periods where status = 'open'
  loop
    perform public.refresh_period(r.id);
  end loop;
end $$;

notify pgrst, 'reload schema';
