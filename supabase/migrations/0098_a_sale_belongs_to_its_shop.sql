-- 0098 — A sale and a delivery belong to the shop that made them
--
-- The question 0097 asked the deposit writers, asked of the two that move stock. The answer was
-- worse.
--
-- `record_sale` and `record_purchase` check `has_permission(p_store_id, ...)` and then trust every
-- id in the payload: the customer, and a product per line. So a member of one shop could
--
--   * SELL another shop's product — stock off a shelf in a shop they have nothing to do with, and
--     the shop it was taken from cannot see who did it, because every read is scoped by membership;
--   * BILL another shop's customer, putting a debt on somebody who has never been in the shop;
--   * RECEIVE stock into another shop's product, which is the same hole from the buying side and
--     worse, because it silently moves the average cost every margin is computed from.
--
-- `settle_empties` already checks the sale against the store, and `save_product_units` derives the
-- store from the product rather than being told it. Those two needed nothing, which is the shape to
-- copy: a function that DERIVES the store cannot be lied to about it.

create or replace function public.assert_trade_target(
  p_store_id    uuid,
  p_customer_id uuid,
  p_lines       jsonb
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_stray uuid;
begin
  if p_customer_id is not null and not exists (
    select 1 from public.store_customers sc
     where sc.id = p_customer_id and sc.store_id = p_store_id
  ) then
    raise exception 'that customer is not yours' using errcode = '42501';
  end if;

  /*
   * EVERY line, and the first stray one is NAMED.
   *
   * A payload is client-authored and a mixed one is the interesting case: nine of the shop's own
   * products and one that is not. Checking that "some" belong would pass it.
   */
  select (l ->> 'product_id')::uuid into v_stray
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
   where (l ->> 'product_id') is not null
     and not exists (
       select 1 from public.products p
        where p.id = (l ->> 'product_id')::uuid and p.store_id = p_store_id
     )
   limit 1;

  if v_stray is not null then
    raise exception 'one of those products is not yours' using errcode = '42501';
  end if;
end;
$fn$;

comment on function public.assert_trade_target(uuid, uuid, jsonb) is
  'Refuses a customer or any product belonging to another shop. Called first thing by record_sale '
  'and record_purchase: having permission IN a store says nothing about whether the ids you were '
  'handed belong to it, and both used to trust them.';

revoke all on function public.assert_trade_target(uuid, uuid, jsonb) from public;
grant execute on function public.assert_trade_target(uuid, uuid, jsonb) to authenticated;



CREATE OR REPLACE FUNCTION public.record_sale(p_store_id uuid, p_lines jsonb, p_customer_id uuid DEFAULT NULL::uuid, p_occurred_at timestamp with time zone DEFAULT now(), p_client_uuid uuid DEFAULT NULL::uuid, p_charges jsonb DEFAULT '[]'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sale_id    uuid;
  v_line       jsonb;
  v_charge     jsonb;
  v_product_id uuid;
  v_base_qty   qty;
  v_entered    qty;
  v_pack_id    uuid;
  v_sale_unit  uuid;   -- the shape the seller chose, added by 0085
  v_standard   money_amt;  -- what this line's returnables are worth at the pool's own rates
  v_share      money_amt;  -- of the deposit actually taken, this pool's part of it
  v_rate       unit_cost;  -- and that share per container, which is what the ledger keeps
  v_price      money_amt;
  v_line_total money_amt;
  v_total      money_amt := 0;
  v_avg_cost   unit_cost;
  v_cogs       money_amt;
  v_containers qty;
  v_deposit    money_amt;
  v_ret        record;
  v_period     uuid;
  v_bad        int;
  v_pos        int := 0;
begin
  if not public.has_permission(p_store_id, 'sales.record') then
    raise exception 'you do not have permission to record sales' using errcode = '42501';
  end if;

  -- WHOSE customer and WHOSE products. Permission in a store says nothing about the ids you were
  -- handed, and this used to sell another shop's stock off their shelf.
  perform public.assert_trade_target(p_store_id, p_customer_id, p_lines);

  if p_client_uuid is not null then
    select id into v_sale_id from public.sales where client_uuid = p_client_uuid;
    if v_sale_id is not null then
      return v_sale_id;
    end if;
  end if;

  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'a sale needs at least one line' using errcode = '22023';
  end if;

  insert into public.sales (store_id, store_customer_id, occurred_at, client_uuid, total)
  values (p_store_id, p_customer_id, p_occurred_at, p_client_uuid, 0)
  returning id into v_sale_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_entered    := (v_line ->> 'qty')::qty;
    v_pack_id    := nullif(v_line ->> 'pack_id', '')::uuid;

    /*
     * THE SHAPE, resolved on the server.
     *
     * A shape id that does not belong to this product resolves to null rather than being written:
     * the quantity is already checked by `assert_sale_unit_allowed`, and a word that came from
     * another product is worse than no word, because a receipt showing it looks answered.
     */
    select pu.id into v_sale_unit
      from public.product_units pu
     where pu.id = nullif(v_line ->> 'sale_unit_id', '')::uuid
       and pu.product_id = v_product_id;
    v_containers := coalesce((v_line ->> 'containers_out')::qty, 0);
    v_deposit    := coalesce((v_line ->> 'deposit_charged')::money_amt, 0);

    v_base_qty := coalesce(
      nullif(v_line ->> 'base_qty', '')::qty,
      -- The shape, when the caller named one and left the arithmetic to the server. Ahead of the
      -- pack lookup because the pack is the retired model; behind the caller's own figure because
      -- a quantity already computed is not this function's to second-guess.
      (select v_entered * pu.base_qty from public.product_units pu where pu.id = v_sale_unit),
      public.to_base_qty(v_product_id, v_entered, v_pack_id)
    );

    -- Refuse a shape this product is not sold in, before anything is written.
    perform public.assert_sale_unit_allowed(v_product_id, v_base_qty);

    v_price      := nullif(v_line ->> 'unit_price', '')::money_amt;
    v_line_total := nullif(v_line ->> 'line_total', '')::money_amt;

    if v_line_total is null and v_price is null then
      raise exception 'a sale line needs either a price or a line total' using errcode = '22023';
    end if;
    if v_line_total is null then
      v_line_total := v_entered * v_price;
    end if;
    if v_price is null then
      v_price := case when v_entered <> 0 then v_line_total / v_entered else v_line_total end;
    end if;

    /*
     * WHAT THIS STOCK ACTUALLY COST, taken from the layers it came out of.
     *
     * `consume_stock_layers` draws the oldest first and returns the money, so a sale spanning a
     * ₦4,400 delivery and a ₦4,200 one is charged partly at each — which is what its margin was.
     * The average is kept as the fallback for a product with no layers yet, so a shop mid-
     * migration still records a sensible figure rather than zero.
     */
    select avg_unit_cost into v_avg_cost from public.products where id = v_product_id;

    v_cogs := public.consume_stock_layers(v_product_id, v_base_qty);
    if v_base_qty > 0 and v_cogs > 0 then
      v_avg_cost := v_cogs / v_base_qty;
    end if;

    insert into public.sale_lines (sale_id, product_id, entered_qty, entered_pack_id, base_qty,
                                   unit_price, line_total, unit_cost_at_sale, containers_out,
                                   deposit_charged, sale_unit_id)
    values (v_sale_id, v_product_id, v_entered, v_pack_id, v_base_qty,
            v_price, v_line_total, coalesce(v_avg_cost, 0), v_containers, v_deposit, v_sale_unit);

    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at)
    values (p_store_id, v_product_id, 'sale', -v_base_qty, coalesce(v_avg_cost, 0),
            'sales', v_sale_id, p_occurred_at);

    /*
     * What the whole line is worth at the pool's standard rates.
     *
     * Needed BEFORE the loop, because a line can send out two kinds of returnable at once — the
     * bottles and the crate they came in — and the counter gives one figure for the line. Split in
     * proportion to what each pool is nominally worth; where the shop has set no standard rate at
     * all, split by how many containers each pool is owed, which is the only other honest measure.
     */
    select coalesce(sum(r.deposit_total), 0) into v_standard
      from public.returnables_for_sale(v_product_id, v_base_qty, v_containers) r;

    for v_ret in
      select * from public.returnables_for_sale(v_product_id, v_base_qty, v_containers)
    loop
      if p_customer_id is not null then
        /*
         * THE RATE ACTUALLY TAKEN, not the pool's standard one.
         *
         * The line above it was already half-right: it stopped stamping a rate on containers sent
         * out on trust. It still stamped the POOL'S rate whenever any money was taken, so a shop
         * charging N125 a crate against a pool that says N500 recorded itself as holding four
         * times what it had — and would have handed back four times as much when the crates came
         * in, out of a till that never received it.
         *
         * A deposit has no fixed rate in this trade. It is agreed at the counter, per customer,
         * per load, and the only figure worth keeping is the one the money actually moved at.
         */
        if v_deposit > 0 then
          v_share := case
                       when v_standard > 0 then v_deposit * (v_ret.deposit_total / v_standard)
                       else v_deposit * (v_ret.qty_units /
                              nullif((select sum(r2.qty_units)
                                        from public.returnables_for_sale(
                                               v_product_id, v_base_qty, v_containers) r2), 0))
                     end;
          v_rate := case when v_ret.qty_units <> 0
                         then (coalesce(v_share, 0) / v_ret.qty_units)::unit_cost
                         else 0 end;
        else
          v_rate := 0;
        end if;

        insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                           direction, qty_units, deposit_per_unit,
                                           ref_table, ref_id, occurred_at)
        values (p_store_id, p_customer_id, v_ret.empties_category_id, 'collected',
                v_ret.qty_units,
                v_rate,
                'sales', v_sale_id, p_occurred_at);

      elsif v_deposit <= 0 and v_ret.deposit_total > 0 then
        raise exception
          'This sale includes % that must come back. Either add a customer, or charge the % deposit as cash.',
          v_ret.category_name, to_char(v_ret.deposit_total, 'FM999999990.00')
          using errcode = '22023';
      end if;
    end loop;

    /*
     * THE MONEY IS HELD AGAINST THIS RECEIPT, and said so where the receipt can find it.
     *
     * The ledger already carries the rate, and `customer_deposits_held` totals a customer's whole
     * position from it. But settling asks a narrower question — how much is held against THIS
     * receipt — and reads `deposit_holdings`, which nothing has ever written for a sale.
     * `hold_receipt_deposit` was added in 0076 for exactly this and has no caller.
     *
     * Without the row the settle screen says "Nothing was held for these" on a receipt that took
     * ₦500, and the shop cannot apply it to a shortfall or hand it back. It took money it had no
     * way to return.
     */
    if v_deposit > 0 and p_customer_id is not null then
      insert into public.deposit_holdings (store_id, store_customer_id, amount, reason,
                                           ref_table, ref_id, occurred_at)
      values (p_store_id, p_customer_id, v_deposit, 'taken',
              'sales', v_sale_id, p_occurred_at);
    end if;

    v_total  := v_total + v_line_total + v_deposit;
    v_period := public.ensure_open_period(v_product_id);
    perform public.refresh_period(v_period);
  end loop;

  -- Named charges: each keeps its own label, because "what was this for?" is the question that
  -- gets asked when a customer disputes a bill weeks later.
  for v_charge in select * from jsonb_array_elements(coalesce(p_charges, '[]'::jsonb)) loop
    continue when coalesce((v_charge ->> 'amount')::money_amt, 0) <= 0;
    insert into public.sale_charges (sale_id, label, amount, sort_order)
    values (v_sale_id,
            coalesce(nullif(trim(v_charge ->> 'label'), ''), 'Charge'),
            (v_charge ->> 'amount')::money_amt,
            v_pos);
    v_total := v_total + (v_charge ->> 'amount')::money_amt;
    v_pos := v_pos + 1;
  end loop;

  update public.sales set total = v_total where id = v_sale_id;

  select count(*) into v_bad
  from public.sale_lines sl
  join public.products p on p.id = sl.product_id
  join public.units u on u.code = p.base_unit
  where sl.sale_id = v_sale_id
    and not u.allows_fraction
    and sl.base_qty <> trunc(sl.base_qty);

  if v_bad > 0 then
    raise exception 'one of these products is counted in whole units only' using errcode = '22023';
  end if;

  return v_sale_id;
end;
$function$;

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
                                       base_qty, unit_cost_raw, unit_cost_landed, free_qty)
    values (v_purchase_id, v_product_id, v_entered, v_pack_id,
            v_base_qty + v_free_base,
            case when v_base_qty > 0 then v_line_value / v_base_qty else 0 end,
            v_landed, v_free);

    -- The layer this delivery becomes. Everything after this prices against it.
    insert into public.stock_layers (store_id, product_id, qty_base, remaining_base, unit_cost,
                                     ref_table, ref_id, received_at)
    values (p_store_id, v_product_id, v_base_qty + v_free_base, v_base_qty + v_free_base,
            v_landed, 'purchases', v_purchase_id, p_occurred_at);

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


do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('record_sale', 'record_purchase', 'assert_trade_target')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a trade writer has % overloads', n;
    end if;
  end loop;
end;
$check$;
