-- =====================================================================================
-- 0170 — Opening stock can carry expiry dates, and more than one
--
-- Expiry lives on `stock_layers.expires_on`, and only a PURCHASE ever made a layer. So a shop
-- adding an item it already has on the shelf could say how many and what they cost, and had no way
-- to say when any of it goes off — the one fact that matters most about stock that is already
-- sitting there, and the reason the item is being added at all for half the shops that do it.
--
-- AND IT IS RARELY ONE DATE. A shelf of the same product is routinely two or three deliveries deep
-- with different dates on them: forty crates going off in March and twelve in June is two facts,
-- and averaging them into one loses the only one worth acting on.
--
-- `open_stock_by_count` keeps doing exactly what it did — a movement, a count, an average cost —
-- and takes an optional list of dated batches. Existing callers pass nothing and behave as before;
-- the parameter has a default, so nothing needed changing anywhere to keep working.
--
-- WHY LAYERS AND NOT A COLUMN ON THE PRODUCT: because that is where expiry already lives, so the
-- expiry screen, the FIFO consumption in `consume_stock_layers` and everything downstream read
-- opening stock the same way they read a delivery. A second place to put a date would be a second
-- answer to "what goes off next".
-- =====================================================================================

/*
 * THE FIVE-ARGUMENT VERSION IS DROPPED FIRST, and that is not tidiness.
 *
 * Adding a parameter with a default does not REPLACE a function, it overloads it — so the old
 * five-argument one survives, and every existing call that passes five arguments then matches
 * both. Postgres refuses an ambiguous call, which would have broken opening stock for every item
 * added from the product form: a change that looked purely additive, taking out the path it was
 * extending. Caught by listing the signatures afterwards rather than by reading the migration.
 */
drop function if exists public.open_stock_by_count(uuid, uuid, qty, money_amt, text);

create or replace function public.open_stock_by_count(
  p_store_id   uuid,
  p_product_id uuid,
  p_qty        qty,
  p_unit_cost  money_amt default null,
  p_note       text default null,
  /*
   * `[{ "qty": 40, "expires_on": "2027-03-01" }, …]`, in BASE units like `p_qty`.
   *
   * Optional, and when it is given the quantities must add up to `p_qty` — the count and the
   * batches are two descriptions of one shelf, and a shop that has said both should be told when
   * they disagree rather than have one silently win.
   */
  p_batches    jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner   uuid;
  v_id      uuid;
  v_batch   jsonb;
  v_sum     numeric := 0;
  v_qty     numeric;
  v_expires date;
begin
  if not (public.has_permission(p_store_id, 'sales.record')
          or public.has_permission(p_store_id, 'stock.count')
          or public.has_permission(p_store_id, 'products.manage')) then
    raise exception 'You do not have permission to record opening stock.'
      using errcode = 'insufficient_privilege';
  end if;

  select store_id into v_owner from public.products where id = p_product_id;
  if v_owner is null or v_owner <> p_store_id then
    raise exception 'That item does not belong to this shop.' using errcode = '22023';
  end if;

  if p_qty is null or p_qty < 0 then
    raise exception 'How many are on the shelf? Zero is an answer; nothing is not.'
      using errcode = '22023';
  end if;

  /*
   * THE BATCHES MUST DESCRIBE THE SAME SHELF AS THE COUNT.
   *
   * Checked before anything is written, so a mismatch leaves no half-opened item behind.
   */
  if p_batches is not null and jsonb_array_length(p_batches) > 0 then
    for v_batch in select * from jsonb_array_elements(p_batches)
    loop
      v_qty := coalesce((v_batch ->> 'qty')::numeric, 0);
      if v_qty <= 0 then
        raise exception 'Every dated batch needs a quantity.' using errcode = '22023';
      end if;
      v_sum := v_sum + v_qty;
    end loop;

    if v_sum <> p_qty then
      raise exception
        'The dated batches come to % but the count says %. They describe the same shelf, so they have to agree.',
        v_sum, p_qty
        using errcode = '22023';
    end if;
  end if;

  /*
   * ZERO IS A REAL ANSWER, AND IT IS A COUNT, NOT A MOVEMENT. `stock_movements` refuses a zero
   * delta and is right to — nothing moved — but "there are none on the shelf" is still a fact
   * somebody established, and it is what separates a shop that has run out from one nobody looked
   * at. So the quantity becomes a movement and the act of counting becomes a count.
   */
  if (p_qty > 0) then
    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at, note)
    values (p_store_id, p_product_id, 'opening', p_qty, coalesce(p_unit_cost, 0),
            'products', p_product_id, now(),
            coalesce(p_note, 'Opening stock, counted on the shelf'))
    returning id into v_id;

    /*
     * ONE LAYER PER DATED BATCH, so what goes off first is consumed first.
     *
     * Ordered by date through `received_at`: `consume_stock_layers` takes them oldest-received
     * first, so dating the earliest-expiring batch as the earliest received is what makes FIFO and
     * "sell the one going off soonest" the same thing. An undated shelf gets no layer, exactly as
     * before — there is nothing to date and nothing to order.
     */
    if p_batches is not null and jsonb_array_length(p_batches) > 0 then
      for v_batch in
        select * from jsonb_array_elements(p_batches)
         order by nullif(value ->> 'expires_on', '')::date nulls last
      loop
        v_qty := (v_batch ->> 'qty')::numeric;
        v_expires := nullif(v_batch ->> 'expires_on', '')::date;

        insert into public.stock_layers (store_id, product_id, qty_base, remaining_base, unit_cost,
                                         ref_table, ref_id, received_at, expires_on)
        values (p_store_id, p_product_id, v_qty, v_qty, coalesce(p_unit_cost, 0),
                'products', p_product_id, now(), v_expires);
      end loop;
    end if;
  end if;

  perform public.enter_stock_count(public.ensure_open_period(p_product_id), p_qty);

  update public.products
     set avg_unit_cost     = coalesce(p_unit_cost, avg_unit_cost),
         cost_is_estimated = true
   where id = p_product_id;

  return v_id;
end;
$$;

comment on function public.open_stock_by_count(uuid, uuid, qty, money_amt, text, jsonb) is
  'Opening stock for an item the shop already has. `p_batches` optionally splits it into dated lots — [{qty, expires_on}] in base units, adding up to p_qty — each becoming a stock layer so expiry and FIFO read it exactly as they read a delivery.';
