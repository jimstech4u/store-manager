-- 0214 - A new day is a new period
--
-- "so a new day is a difference in date. so if today is 12/9/2026, once it is 13/9/2026, then we
-- have to count again."
--
-- That is the shop's own rule and the software half-knew it: the till already refuses to sell an
-- item that has not been counted TODAY. What it did not do was end yesterday's period. One period
-- stayed open across days, so yesterday's count and today's sales sat in the same arithmetic —
-- and after 0213 froze the expectation at the count, today's movements were in a period that had
-- already stopped counting them.
--
-- A period now ends where the shop says its day ends: at the count that closed it. The first
-- thing that touches an item on a new day rolls it — the old period closes AT ITS COUNT, and a
-- fresh one opens there with that figure as its opening, picking up everything since.
--
-- Aquafina, all the way through:
--
--     28th 09:44   opening 2 packs                    period A opens
--     29th 08:14   counted 2 packs                    period A: expected 2, counted 2, square
--     29th 08:18   sold 1 pack                        period B opens at the count, opening 2
--                                                     period B: sold 1, expected 1
--     29th        count again -> 1 pack               period B: square
--
-- ROLLED ONLY WHEN YESTERDAY IS SETTLED. A period whose count disagreed with its records, and
-- where nobody has explained the difference, stays open and stays in the shop's face. Rolling it
-- away would file an unexplained loss under "yesterday" where nobody looks again — which is the
-- one thing a stock count exists to prevent. Trading is not blocked by this: the till's own
-- count gate is what asks for today's figure, and it is reached either way.
--
-- IN THE SHOP'S OWN TIMEZONE. `stores.timezone`, the same way `enter_stock_count` already decides
-- whether a count happened "today" — a shop closing at eleven at night is not filing its evening
-- under tomorrow because a server in another country has already turned over.

create or replace function public.ensure_open_period(p_product_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id       uuid;
  v_store_id uuid;
  v_opening  qty;
  v_p        record;
  v_tz       text;
  v_prev_end timestamptz;
begin
  select * into v_p from public.stock_periods
   where product_id = p_product_id and status = 'open';

  if found then
    select coalesce(st.timezone, 'UTC') into v_tz
      from public.stores st where st.id = v_p.store_id;

    /*
     * HAS THE DAY TURNED SINCE THIS PERIOD WAS COUNTED? (0214)
     *
     * Only a counted period can roll — an uncounted one has nothing to open the next with — and
     * only a settled one, so an unexplained difference is not quietly filed under yesterday.
     */
    if v_p.counted_at is not null
       and (v_p.counted_at at time zone v_tz)::date < (now() at time zone v_tz)::date
       and (v_p.variance_qty is not distinct from 0
            or public.variance_within_tolerance(v_p.id))
    then
      update public.stock_periods
         set status     = 'closed',
             period_end = v_p.counted_at,
             closed_at  = now()
       where id = v_p.id;

      insert into public.stock_periods (store_id, product_id, period_start, opening_qty, status)
      values (v_p.store_id, p_product_id, v_p.counted_at, v_p.actual_closing_qty, 'open')
      returning id into v_id;

      -- Everything that has happened since that count belongs to the day that is starting.
      perform public.refresh_period(v_id);
      return v_id;
    end if;

    return v_p.id;
  end if;

  select store_id into v_store_id from public.products where id = p_product_id;
  if v_store_id is null then
    raise exception 'unknown product' using errcode = '23503';
  end if;

  /*
   * The next period opens where the last one ENDED, not at this moment — otherwise anything
   * recorded in between belongs to no period at all.
   */
  select sp.actual_closing_qty, sp.period_end into v_opening, v_prev_end
    from public.stock_periods sp
   where sp.product_id = p_product_id and sp.status <> 'open'
   order by sp.period_end desc nulls last, sp.created_at desc
   limit 1;

  if v_opening is null then
    -- First ever period: whatever the ledger already holds (an opening backfill, typically).
    select coalesce(sum(qty_delta), 0) into v_opening
      from public.stock_movements where product_id = p_product_id;
  end if;

  insert into public.stock_periods (store_id, product_id, period_start, opening_qty)
  values (v_store_id, p_product_id, coalesce(v_prev_end, now()), coalesce(v_opening, 0))
  returning id into v_id;

  perform public.refresh_period(v_id);
  return v_id;
end;
$$;

notify pgrst, 'reload schema';
