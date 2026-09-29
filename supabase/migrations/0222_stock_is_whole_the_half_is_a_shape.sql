-- 0222 - Stock is counted whole; the half lives in a smaller shape
--
-- "we should remove 0.5 allowed in product qty ... malta guinness the initial qty entered 133.5
-- cans so that is wrong, there shouldnt be decimals entered, only whole. The solution to the half
-- is that we have two shapes, can and pieces, so that will be 133 cans, 12 pieces, since pieces is
-- not sold but the can shape has half sold, and we say pieces go into cans as 24."
--
-- 0211 let a fractional BASE quantity through whenever any shape of the item sold in parts. That
-- was the wrong fix for Malta Guinness: its only shape was worth one base unit, so a half of it had
-- no base figure, and 0211 invented one. The shop's answer is the right one — a smaller shape.
-- Half a can of 24 is 12 pieces, a whole number, and nothing needs a fraction.
--
-- So:
--   1. `tg_check_fraction` and `record_sale` go back to the unit's own rule: a piece is whole.
--   2. A COUNT is held to the same rule (new). Counts were never checked, which is how 133.5 got
--      into the shelf figure as well as the ledger.
--   3. Malta Guinness Can (330mL) is re-said: a Piece shape (the base, counted, neither sold nor
--      bought) and the Can shape defined as 24 pieces. Its one ledger row and its one count —
--      133.5 cans, entered at opening, nothing sold since — become 3,204 pieces: 133 cans and
--      12 pieces. This is the same stock said in a smaller unit, not a change to what happened, so
--      the append-only guard is lifted for exactly that one row and restored in the same
--      transaction.

-- ─── 1. Whole base units again ────────────────────────────────────────────────────────

create or replace function public.tg_check_fraction()
returns trigger
language plpgsql
as $$
declare
  v_allows boolean;
begin
  select u.allows_fraction into v_allows
  from public.products p
  join public.units u on u.code = p.base_unit
  where p.id = new.product_id;

  if not coalesce(v_allows, true) and new.qty_delta <> trunc(new.qty_delta) then
    raise exception 'this product is counted in whole units — % is not valid. Use a smaller shape '
      'for the part.', new.qty_delta
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create or replace function public.record_sale(p_store_id uuid, p_lines jsonb, p_customer_id uuid DEFAULT NULL::uuid, p_occurred_at timestamp with time zone DEFAULT now(), p_client_uuid uuid DEFAULT NULL::uuid, p_charges jsonb DEFAULT '[]'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
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
    /*
     * NOT BELOW ZERO (0186).
     *
     * Here rather than up front: the previous lines of this same basket have already written
     * their movements, so two lines of one product are judged together. Before the layers are
     * consumed, so a refused sale has moved nothing at all.
     */
    perform public.assert_stock_available(v_product_id, v_base_qty);

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
      /*
       * THE SHAPE IT WAS SOLD IN, so what is owed is owed in that shape.
       *
       * Without it the reader falls back to a row per pool: four crates of Goldberg owed four
       * crates AND forty-eight bottles, so a customer who took four things was recorded as holding
       * fifty-two. `v_sale_unit` has been on the line since 0085 and was simply not being passed.
       */
      select * from public.returnables_for_sale(v_product_id, v_base_qty, v_containers, v_sale_unit)
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

  /*
   * A PART OF A SHAPE IS ALLOWED; A PART OF A BASE UNIT IS NOT (0222, undoing 0211's widening).
   *
   * What follows is 0211's reasoning, kept because it is why the rule was once wider.
   *
   * `units.allows_fraction` is a property of a UNIT CODE — "a piece cannot be halved" — and it is
   * a sound default. It is not the shop's answer. Every product in the first shop to use this has
   * `base_unit = 'piece'`, and the shop has ticked "halves too" on 103 of the 104.
   */
  select count(*) into v_bad
  from public.sale_lines sl
  join public.products p on p.id = sl.product_id
  join public.units u on u.code = p.base_unit
  where sl.sale_id = v_sale_id
    and not u.allows_fraction
    -- 0222: whole base units again, whatever the shapes say. Half a crate of twelve is six;
    -- half of something whose smallest shape is one has no base figure, so it needs a smaller shape.
    and sl.base_qty <> trunc(sl.base_qty);

  if v_bad > 0 then
    raise exception 'one of these products is counted in whole units only' using errcode = '22023';
  end if;

  return v_sale_id;
end;
$function$;

-- ─── 2. A count is whole too ──────────────────────────────────────────────────────────

create or replace function public.tg_count_is_whole()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_allows boolean;
  v_name   text;
begin
  if new.actual_closing_qty is null
     or new.actual_closing_qty = trunc(new.actual_closing_qty) then
    return new;
  end if;

  select u.allows_fraction, p.name into v_allows, v_name
    from public.products p
    join public.units u on u.code = p.base_unit
   where p.id = new.product_id;

  if not coalesce(v_allows, true) then
    raise exception '% is counted in whole units. Count the part in a smaller shape.',
      coalesce(v_name, 'This item')
      using errcode = '22023';
  end if;
  return new;
end;
$fn$;

drop trigger if exists count_is_whole on public.stock_periods;
create trigger count_is_whole
  before insert or update of actual_closing_qty on public.stock_periods
  for each row execute function public.tg_count_is_whole();

-- ─── 3. Malta Guinness Can: 133 cans and 12 pieces ────────────────────────────────────

do $malta$
declare
  v_product uuid := 'cba8c191-102a-4fc5-a4f5-045bf7bfaa91';
  v_can     uuid := '217d0d07-54e9-4176-a312-fe29407721f1';
  v_move    uuid := 'e4062be5-0356-49d8-a207-0ecd1ac9cfc3';
  v_piece   uuid;
  v_unit    uuid;
begin
  -- Only as found: one opening row of 133.5, nothing sold. Anything else and this stops.
  if (select count(*) from public.stock_movements where product_id = v_product) <> 1
     or (select qty_delta from public.stock_movements where id = v_move) <> 133.5
     or exists (select 1 from public.sale_lines where product_id = v_product) then
    raise exception 'Malta Guinness Can is not as it was found; not re-saying it';
  end if;

  select su.id into v_unit
    from public.store_units su
    join public.products p on p.store_id = su.store_id
   where p.id = v_product and su.name = 'Piece' and su.status = 'active';

  insert into public.product_units
    (product_id, store_unit_id, base_qty, is_bought, is_sold, sell_price, is_returnable,
     whole_digit, allow_quarter, allow_half, allow_three_quarter, sort_order)
  values
    (v_product, v_unit, 1, false, false, null, false, true, false, false, false, 1)
  returning id into v_piece;

  -- The can becomes 24 pieces. The trigger works out base_qty from this.
  update public.product_units
     set defined_against_id = v_piece, defined_qty = 24, sort_order = 0
   where id = v_can;

  alter table public.stock_movements disable trigger no_mutation;
  alter table public.stock_movements disable trigger check_fraction;
  update public.stock_movements
     set qty_delta = 3204, balance_after = 3204
   where id = v_move;
  alter table public.stock_movements enable trigger check_fraction;
  alter table public.stock_movements enable trigger no_mutation;

  update public.stock_periods
     set opening_qty = 3204, expected_at_count = 3204, actual_closing_qty = 3204
   where product_id = v_product;
end;
$malta$;

notify pgrst, 'reload schema';
