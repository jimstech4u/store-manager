-- 0130 — Stock has a date on it
--
-- «each product from delivery entry should take expiry date (very important and also filter to get
--  this and alarm)»
--
-- A delivery was recorded as a quantity and a cost and nothing else, so the shelf could say what it
-- was worth and never what it was worth BY WHEN. For a distributor carrying beer, milk, juice and
-- bread that is not a reporting nicety: stock that goes out of date is a total loss, it is
-- avoidable up to the day it happens, and the whole value of knowing is that somebody is told
-- BEFORE rather than while throwing it away.
--
-- IT BELONGS ON THE LAYER, not on the product. `stock_layers` already tracks each delivery
-- separately with its own `remaining_base` and consumes oldest-first, which is exactly the grain an
-- expiry date has: two deliveries of the same milk expire on two different days, and the one that
-- matters is whichever is still on the shelf. A column on `products` could only ever hold the last
-- one entered, and would go stale the moment a second delivery arrived.
--
-- OPTIONAL, ALWAYS. Most of what this trade carries does not expire in any useful sense — a crate
-- of Gulder has a date on it that nobody has ever reached — and a required field would be answered
-- with a guess. A blank means "not dated", which is a different fact from "expires today".

alter table public.purchase_lines
  add column if not exists expires_on date;

alter table public.stock_layers
  add column if not exists expires_on date;

comment on column public.stock_layers.expires_on is
  'When this delivery goes out of date. Null means undated, which is not the same as never. On the '
  'LAYER because two deliveries of the same item expire on two different days.';

/*
 * Indexed on what is actually asked: what is going off, soonest first, among stock still on the
 * shelf. A partial index, because a layer that has been sold through cannot expire.
 */
create index if not exists stock_layers_expiry_idx
  on public.stock_layers (store_id, expires_on)
  where remaining_base > 0 and expires_on is not null;

-- ─── The delivery takes the date ────────────────────────────────────────────────────

/*
 * COPY THE WORKING FUNCTION AND ADD; DO NOT TIDY IT.
 *
 * 0058 rewrote `save_draft_order` "more tidily", changed a parameter order, created a second
 * overload, and PostgREST answered 300 to every call — the till stopped saving. 0080 renamed a key
 * the client had never sent and would have erased every shape relationship in the shop. Both rules
 * are already written down and both were learnt the expensive way.
 *
 * So this reads the previous definition verbatim and adds exactly two lines: the date off the line,
 * and the date onto the layer. The signature is untouched, so there is no new overload and every
 * existing caller keeps working with no change at all.
 */
/*
 * SPLICED FROM 0098, NOT 0071 — and the difference is a security fix.
 *
 * 0071 was the last LOWERCASE `create or replace function public.record_purchase(`, so a
 * case-sensitive search found it and stopped there. 0098 rewrote the same function in uppercase to
 * add `assert_trade_target`, which stops a member of one shop receiving stock into ANOTHER shop's
 * product — silently moving the average cost every margin of theirs is computed from.
 *
 * A first version of this migration therefore reverted that guard while "only adding a date". The
 * benchmark caught it in one line: «stock cannot be received into another shop's product — it
 * RECEIVED into somebody else's shelf». Search case-insensitively for the definition you are
 * extending, and take the LAST one.
 */
CREATE OR REPLACE FUNCTION public.record_purchase(p_store_id uuid, p_lines jsonb, p_supplier text DEFAULT NULL::text, p_invoice_ref text DEFAULT NULL::text, p_distribution money_amt DEFAULT 0, p_delivery money_amt DEFAULT 0, p_occurred_at timestamp with time zone DEFAULT now(), p_client_uuid uuid DEFAULT NULL::uuid, p_charges jsonb DEFAULT '[]'::jsonb, p_rebate money_amt DEFAULT 0)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_purchase_id uuid;
  v_line        jsonb;
  v_product_id  uuid;
  v_entered     qty;
  v_free        qty;
  v_pack_id     uuid;
  v_base_qty    qty;
  v_free_base   qty;
  v_cost_entered money_amt;
  v_line_value  money_amt;
  v_goods_total money_amt := 0;
  v_extra       money_amt;
  v_landed      unit_cost;
  v_period      uuid;
  v_charge      jsonb;
  v_pos         int := 0;
  v_pack_base   qty;
  v_expires     date;
begin
  if not public.has_permission(p_store_id, 'stock.receive') then
    raise exception 'you do not have permission to receive stock' using errcode = '42501';
  end if;

  -- WHOSE products. This used to receive stock into another shop's item, moving the average cost
  -- every margin of theirs is computed from.
  perform public.assert_trade_target(p_store_id, null, p_lines);

  if p_client_uuid is not null then
    select id into v_purchase_id from public.purchases where client_uuid = p_client_uuid;
    if v_purchase_id is not null then
      return v_purchase_id;
    end if;
  end if;

  -- `distribution_fee` and `delivery_fee`: the names the table actually uses.
  insert into public.purchases (store_id, supplier_name, invoice_ref, distribution_fee,
                                delivery_fee, rebate_amount, occurred_at, client_uuid, created_by)
  values (p_store_id, nullif(trim(p_supplier), ''), nullif(trim(p_invoice_ref), ''),
          coalesce(p_distribution, 0), coalesce(p_delivery, 0), coalesce(p_rebate, 0),
          p_occurred_at, p_client_uuid, auth.uid())
  returning id into v_purchase_id;

  for v_charge in select * from jsonb_array_elements(coalesce(p_charges, '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    if coalesce((v_charge ->> 'amount')::money_amt, 0) > 0 then
      insert into public.purchase_charges (purchase_id, label, amount, note, sort_order)
      values (v_purchase_id,
              coalesce(nullif(trim(v_charge ->> 'label'), ''), 'Charge'),
              (v_charge ->> 'amount')::money_amt,
              nullif(trim(v_charge ->> 'note'), ''),
              v_pos);
    end if;
  end loop;

  /*
   * EVERYTHING THAT IS NOT THE GOODS, in one figure.
   *
   * The two fixed fields stay for what already used them; the named charges add to them rather
   * than replacing them, so a delivery recorded before this change still reads correctly.
   */
  v_extra := coalesce(p_distribution, 0) + coalesce(p_delivery, 0)
           + coalesce((select sum(amount) from public.purchase_charges
                        where purchase_id = v_purchase_id), 0)
           - coalesce(p_rebate, 0);

  -- What the goods themselves came to, needed before any line can take its share of the extras.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_goods_total := v_goods_total + ((v_line ->> 'qty')::qty * (v_line ->> 'unit_cost')::money_amt);
  end loop;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product_id   := (v_line ->> 'product_id')::uuid;
    v_entered      := (v_line ->> 'qty')::qty;
    v_free         := coalesce((v_line ->> 'free_qty')::qty, 0);
    v_pack_id      := nullif(v_line ->> 'pack_id', '')::uuid;
    v_cost_entered := (v_line ->> 'unit_cost')::money_amt;
    -- When it goes out of date. Optional, and a blank stays a blank: most of what this
    -- trade carries has a date nobody ever reaches, and a required field gets a guess.
    v_expires      := nullif(v_line ->> 'expires_on', '')::date;

    /*
     * How many base units one of whatever arrived is.
     *
     * `base_factor` when the form knows — it is reading the shop's own bought-in units now, which
     * a pack row may not exist for at all. The pack lookup stays underneath it for callers that
     * still send a `pack_id`, and 1 when neither says anything, which is a delivery in base units.
     */
    v_pack_base := (v_line ->> 'base_factor')::qty;

    if v_pack_base is null then
      select coalesce(pk.base_unit_qty, 1) into v_pack_base
        from public.product_packs pk where pk.id = v_pack_id;
    end if;

    v_pack_base := coalesce(v_pack_base, 1);

    v_line_value := v_entered * v_cost_entered;
    v_base_qty   := v_entered * v_pack_base;
    -- Free units are stock that arrived and cost nothing extra, so they go into the divisor.
    v_free_base  := v_free * v_pack_base;

    /*
     * The landed cost: this line's goods, plus its share of everything else, over everything that
     * actually arrived — the free units included, which is exactly what makes them worth taking.
     */
    v_landed := case
      when (v_base_qty + v_free_base) > 0
        then (v_line_value
              + case when v_goods_total > 0
                     then v_extra * (v_line_value / v_goods_total)
                     else 0 end
             ) / (v_base_qty + v_free_base)
      else 0
    end;

    -- Never below zero: a rebate larger than the goods would otherwise make stock cost a negative
    -- amount, and every margin computed from it would be nonsense.
    v_landed := greatest(v_landed, 0);

    insert into public.purchase_lines (purchase_id, product_id, entered_qty, entered_pack_id,
                                       base_qty, unit_cost_raw, unit_cost_landed, free_qty,
                                       expires_on)
    values (v_purchase_id, v_product_id, v_entered, v_pack_id,
            v_base_qty + v_free_base,
            case when v_base_qty > 0 then v_line_value / v_base_qty else 0 end,
            v_landed, v_free, v_expires);

    -- The layer this delivery becomes. Everything after this prices against it.
    insert into public.stock_layers (store_id, product_id, qty_base, remaining_base, unit_cost,
                                     ref_table, ref_id, received_at, expires_on)
    values (p_store_id, v_product_id, v_base_qty + v_free_base, v_base_qty + v_free_base,
            v_landed, 'purchases', v_purchase_id, p_occurred_at, v_expires);

    perform public.apply_weighted_average(v_product_id, v_base_qty + v_free_base, v_landed);

    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at)
    values (p_store_id, v_product_id, 'receive', v_base_qty + v_free_base, v_landed,
            'purchases', v_purchase_id, p_occurred_at);

    v_period := public.ensure_open_period(v_product_id);
    perform public.refresh_period(v_period);
  end loop;

  return v_purchase_id;
end;
$function$;

revoke all on function public.record_purchase(uuid, jsonb, text, text, money_amt, money_amt, timestamptz, uuid, jsonb, money_amt) from public;
grant execute on function public.record_purchase(uuid, jsonb, text, text, money_amt, money_amt, timestamptz, uuid, jsonb, money_amt) to authenticated;

-- ─── What is going off ──────────────────────────────────────────────────────────────

/*
 * The filter and the alarm are the same question asked with a different window, so they are one
 * function. `p_within_days` is how far ahead to look; anything ALREADY out of date comes back
 * whatever the window, because a window is a warning and expired stock is a fact.
 *
 * Said in the shop's own shapes, because "84 pieces expiring" is not something anybody can go and
 * find on a shelf. Seven crates is.
 */
create or replace function public.expiring_stock(
  p_store_id    uuid,
  p_within_days int default 30
)
returns table (
  layer_id     uuid,
  product_id   uuid,
  product_name text,
  expires_on   date,
  days_left    int,
  remaining    qty,
  unit_cost    unit_cost,
  value_at_cost money_amt,
  received_at  timestamptz,
  supplier     text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select l.id,
         p.id,
         p.name,
         l.expires_on,
         (l.expires_on - (now() at time zone coalesce(s.timezone, 'UTC'))::date)::int,
         l.remaining_base,
         l.unit_cost,
         (l.remaining_base * l.unit_cost)::money_amt,
         l.received_at,
         pu.supplier_name
    from public.stock_layers l
    join public.products p on p.id = l.product_id
    join public.stores s on s.id = l.store_id
    left join public.purchase_lines pl on pl.id = l.ref_id and l.ref_table = 'purchase_lines'
    left join public.purchases pu on pu.id = pl.purchase_id
   where l.store_id = p_store_id
     and l.remaining_base > 0
     and l.expires_on is not null
     /*
      * THE SHOP'S OWN DAY, not the server's and not the phone's.
      *
      * Eight seconds of clock skew once put a delivery in the wrong counting period and wrote 147
      * phantom bottles into stock. "Expires today" is exactly the kind of figure that is read at
      * seven in the morning and must agree with the calendar on the wall.
      */
     and l.expires_on <= ((now() at time zone coalesce(s.timezone, 'UTC'))::date
                          + coalesce(p_within_days, 30))
     and coalesce(p.status, 'active') = 'active'
     and public.is_store_member(p_store_id)
   order by l.expires_on, p.name;
$fn$;

revoke all on function public.expiring_stock(uuid, int) from public;
grant execute on function public.expiring_stock(uuid, int) to authenticated;

/*
 * The alarm, which is the same question reduced to what a badge can carry.
 *
 * One row, so a screen that only wants to know "is there anything to worry about" does not read a
 * list to find out. `soon` deliberately EXCLUDES what has already gone: they are two different
 * calls to action — one is "sell these first", the other is "take these off the shelf".
 */
create or replace function public.expiring_summary(
  p_store_id    uuid,
  p_within_days int default 30
)
returns table (
  expired_items  int,
  expired_value  money_amt,
  soon_items     int,
  soon_value     money_amt,
  next_date      date
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select count(*) filter (where days_left < 0)::int,
         coalesce(sum(value_at_cost) filter (where days_left < 0), 0)::money_amt,
         count(*) filter (where days_left >= 0)::int,
         coalesce(sum(value_at_cost) filter (where days_left >= 0), 0)::money_amt,
         min(expires_on) filter (where days_left >= 0)
    from public.expiring_stock(p_store_id, p_within_days);
$fn$;

revoke all on function public.expiring_summary(uuid, int) from public;
grant execute on function public.expiring_summary(uuid, int) to authenticated;

-- ─── Taking expired stock off the shelf ─────────────────────────────────────────────

/*
 * Knowing is only half of it. Expired stock has to be able to LEAVE, as damage, at what it cost —
 * and against the layer it came from, so the loss is attributed to the delivery that caused it
 * rather than to the average.
 *
 * It is `damage`, not `adjustment`: the same distinction 0129 drew between a crate that broke and a
 * crate that walked. Out-of-date stock is breakage the calendar caused.
 */
create or replace function public.write_off_expired(
  p_layer_id uuid,
  p_qty      qty default null,
  p_reason   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_l  record;
  v_qty numeric;
  v_id uuid;
begin
  select * into v_l from public.stock_layers where id = p_layer_id;
  if not found then
    raise exception 'unknown stock layer' using errcode = '23503';
  end if;
  if not public.has_permission(v_l.store_id, 'stock.adjust') then
    raise exception 'you do not have permission to write stock off' using errcode = '42501';
  end if;

  -- All of what is left, unless a smaller amount is named: half a crate can be salvageable.
  v_qty := coalesce(p_qty, v_l.remaining_base);
  if v_qty <= 0 then
    raise exception 'nothing to write off' using errcode = '22023';
  end if;
  if v_qty > v_l.remaining_base then
    raise exception 'only % of that delivery is left', v_l.remaining_base using errcode = '22023';
  end if;

  update public.stock_layers
     set remaining_base = remaining_base - v_qty
   where id = p_layer_id;

  insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                      ref_table, ref_id, note)
  values (v_l.store_id, v_l.product_id, 'damage', -v_qty, v_l.unit_cost,
          'stock_layers', p_layer_id,
          coalesce(nullif(btrim(p_reason), ''), 'Out of date'))
  returning id into v_id;

  /*
   * THE AVERAGE COST IS LEFT ALONE, deliberately.
   *
   * An earlier draft called `refresh_avg_cost`, which does not exist — the real function here is
   * `apply_weighted_average(product, qty, cost)`, and it is for stock ARRIVING. Taking stock out at
   * the cost it came in at does not move the average of what is left, and calling the receipt
   * function with a negative quantity would corrupt it.
   *
   * The period is refreshed instead, so the count screen's expectation includes the write-off
   * rather than reporting it as a fresh shortfall tomorrow morning.
   */
  perform public.refresh_period(public.ensure_open_period(v_l.product_id));

  return v_id;
end;
$fn$;

revoke all on function public.write_off_expired(uuid, qty, text) from public;
grant execute on function public.write_off_expired(uuid, qty, text) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('record_purchase', 'expiring_stock', 'expiring_summary',
                          'write_off_expired')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'an expiry function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$check$;
