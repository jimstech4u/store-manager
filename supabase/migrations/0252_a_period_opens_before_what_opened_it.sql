-- 0252 - A count period opens on the shelf BEFORE the movement that opened it
--
-- "Check this Pepsi bottle: stock history says I counted 80 crates 10 bottles short." The shop was
-- 10 bottles short. The other 80 crates were the delivery that opened the period, counted twice.
--
-- `ensure_open_period` is called by a sale, a delivery or a count AFTER that writer has put its own
-- movement on the ledger. For an item's first ever period it took the opening from the whole ledger
-- (including that movement) and started the period at now(), and `refresh_period` then counted the
-- same movement again, inside the period, because it is dated now(). A delivery opening the period
-- made every count afterwards look short by the delivery; a sale opening it made every count look
-- OVER by the sale: "Trophy +6", "Amstel Malta +12", "Maltina +5 crates", all of them the sale
-- that happened to be first.
--
-- It stayed hidden while every item had a period from its opening stock (an `opening` movement is
-- not one the period counts). 0251 removed Ashabi's periods, so every item there reopened from a
-- sale or a delivery, and every one of them doubled.
--
-- Two things here:
--
--   1. The first period's opening is the ledger LESS anything the period itself will count
--      (dated at or after its start), so opening + the period's own movements = the ledger.
--   2. The periods it opened wrongly are put right, item by item along their chain:
--        - the opening loses what it double-counted, and what each count was measured against
--          (`expected_at_count`) moves with it, so the variance becomes what was really there;
--        - where a phantom gap was explained as "the count was wrong", the count was overwritten
--          with the phantom figure (that is what a miscount does: `resolve_variance` sets the count
--          to the expectation). The figure the shop actually entered comes back: the overwritten
--          count plus the gap the miscount explained;
--        - a period opened from a count that changed opens from the corrected count.
--      The movements are not touched: the ledger was right all along.

-- ─── 1. The function, copied and one statement changed ─────────────────────────────────────
create or replace function public.ensure_open_period(p_product_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
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
    /*
     * First ever period: what the ledger held BEFORE it (0252). The sale or delivery that called
     * this is already on the ledger, dated now(), and the period counts it as its own; taking it
     * into the opening as well counted it twice, and every count after it was out by exactly that.
     */
    select coalesce(sum(qty_delta), 0) into v_opening
      from public.stock_movements
     where product_id = p_product_id
       and not (occurred_at >= now()
                and kind in ('receive', 'transfer_in', 'sale', 'damage', 'return_in',
                             'repack_loss', 'adjustment', 'transfer_out'));
  end if;

  insert into public.stock_periods (store_id, product_id, period_start, opening_qty)
  values (v_store_id, p_product_id, coalesce(v_prev_end, now()), coalesce(v_opening, 0))
  returning id into v_id;

  perform public.refresh_period(v_id);
  return v_id;
end;
$function$;

-- ─── 2. The periods it opened wrongly, put right along each item's chain ─────────────────────
do $$
declare
  v_prod       uuid;
  v_p          record;
  v_doubled    numeric;
  v_new_open   numeric;
  v_delta      numeric;
  v_miscount   numeric;
  v_new_actual numeric;
  v_carry_old  numeric;
  v_carry_new  numeric;
  v_carry_end  timestamptz;
begin
  for v_prod in
    select distinct sp.product_id
      from public.stock_periods sp
     where not exists (select 1 from public.stock_periods x
                        where x.product_id = sp.product_id and x.id <> sp.id
                          and x.status <> 'open' and x.period_end <= sp.period_start)
       and exists (select 1 from public.stock_movements m
                    where m.product_id = sp.product_id
                      and m.kind in ('receive', 'transfer_in', 'sale', 'damage', 'return_in',
                                     'repack_loss', 'adjustment', 'transfer_out')
                      and m.occurred_at >= sp.period_start
                      and m.created_at <= sp.created_at)
  loop
    v_carry_old := null; v_carry_new := null; v_carry_end := null;

    for v_p in
      select * from public.stock_periods where product_id = v_prod order by period_start, created_at
    loop
      -- What this period's opening counted twice: its own movements that already existed when it opened.
      select coalesce(sum(m.qty_delta), 0) into v_doubled
        from public.stock_movements m
       where m.product_id = v_prod
         and m.kind in ('receive', 'transfer_in', 'sale', 'damage', 'return_in',
                        'repack_loss', 'adjustment', 'transfer_out')
         and m.occurred_at >= v_p.period_start
         and m.created_at <= v_p.created_at;

      if v_carry_end is not null and v_p.period_start = v_carry_end and v_p.opening_qty = v_carry_old then
        -- Opened from the count before it, which has just been corrected.
        v_new_open := v_carry_new;
      elsif v_carry_end is null and not exists (
              select 1 from public.stock_periods x
               where x.product_id = v_prod and x.id <> v_p.id
                 and x.status <> 'open' and x.period_end <= v_p.period_start) then
        -- The first period: the ledger before it.
        v_new_open := v_p.opening_qty - v_doubled;
      else
        v_new_open := v_p.opening_qty;
      end if;
      v_delta := v_new_open - v_p.opening_qty;

      -- A "the count was wrong" that explained a gap this arithmetic made: the count as entered.
      select coalesce(sum(vr.qty), 0) into v_miscount
        from public.variance_resolutions vr
       where vr.stock_period_id = v_p.id and vr.reason = 'miscount';
      v_new_actual := case
                        when v_p.actual_closing_qty is null then null
                        when v_delta <> 0 and v_miscount <> 0 then v_p.actual_closing_qty + v_miscount
                        else v_p.actual_closing_qty
                      end;

      if v_delta <> 0 or v_new_actual is distinct from v_p.actual_closing_qty then
        update public.stock_periods
           set opening_qty        = v_new_open,
               expected_at_count  = case when expected_at_count is null then null
                                         else expected_at_count + v_delta end,
               actual_closing_qty = v_new_actual
         where id = v_p.id;
      end if;

      if v_p.status <> 'open' and v_new_actual is distinct from v_p.actual_closing_qty then
        v_carry_old := v_p.actual_closing_qty;
        v_carry_new := v_new_actual;
        v_carry_end := v_p.period_end;
      elsif v_p.status <> 'open' then
        v_carry_old := null; v_carry_new := null; v_carry_end := v_p.period_end;
      end if;
    end loop;
  end loop;
end;
$$;
