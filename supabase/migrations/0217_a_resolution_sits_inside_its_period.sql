-- 0217 - A variance resolution sits INSIDE the period it settles
--
-- 0216 dated a resolution's stock movements to `counted_at`. That was one millisecond too late.
--
-- A period's window ends EXCLUSIVELY at the count (0213) and the next period begins exactly
-- there, so a movement stamped at that instant belongs to the next period — where it was
-- subtracted from an opening figure that was itself the counted quantity, and the loss came off
-- twice. The benchmark caught it: "the count is fifteen short — -6, expected -15", the six being
-- the nine of a previous scenario's resolution reappearing.
--
-- A resolution explains what the count FOUND, so it happened during the period, before the count.
-- A millisecond inside the boundary says exactly that and is the one place the movement is
-- counted once.
--
-- Everything else is the live definition, byte for byte.

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
      update public.stock_periods
         set actual_closing_qty = expected_closing_qty
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
              coalesce(v_p.counted_at - interval '1 millisecond', now()));
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

grant execute on function public.resolve_variance(uuid, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
