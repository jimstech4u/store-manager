-- 0103 — The sale says which shape it sold, and the form says which shape a pool is for
--
-- 0102 taught `returnables_for_sale` to owe in the shape that was sold and gave
-- `product_returnables` a column to say which shape each pool belongs to. Neither does anything
-- until its caller uses it.
--
-- `record_sale` has known the shape since 0085 — it is sitting in `v_sale_unit` — and was passing
-- everything except that. And `set_product_returnable` had no way to be told, so the product form
-- could only create pools that a backfill then had to guess the shape of by matching names.

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

-- ─── And the form can say which shape a pool is for ────────────────────────────────

-- Dropped first. Adding a parameter with a default makes a SECOND overload rather than replacing
-- the first, and PostgREST answers 300 to every call when it cannot choose — the failure that
-- stopped the till in 0058, and the reason the check at the bottom of every one of these exists.
drop function if exists public.set_product_returnable(uuid, uuid, text, text, qty, money_amt);


CREATE OR REPLACE FUNCTION public.set_product_returnable(p_store_id uuid, p_product_id uuid, p_category_name text, p_kind text DEFAULT 'content'::text, p_qty_per_base_unit qty DEFAULT 1, p_deposit money_amt DEFAULT 0, p_product_unit_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_category uuid;
  v_owner    uuid;
begin
  if not (public.has_permission(p_store_id, 'products.manage')
          or public.has_permission(p_store_id, 'sales.record')) then
    raise exception 'You do not have permission to change what comes back.'
      using errcode = 'insufficient_privilege';
  end if;

  select store_id into v_owner from public.products where id = p_product_id;
  if v_owner is null or v_owner <> p_store_id then
    raise exception 'That item does not belong to this shop.' using errcode = '22023';
  end if;

  if coalesce(btrim(p_category_name), '') = '' then
    raise exception 'What comes back? Give the pool a name.' using errcode = '22023';
  end if;

  if p_kind not in ('content', 'container') then
    raise exception 'A returnable is either a content or a container.' using errcode = '22023';
  end if;

  -- The shop's own word for it, reused when it already has one. Matched case-insensitively for the
  -- same reason `quick_add_sellable` does: "NBL crate" and "NBL Crate" are one pool to a shop.
  select id into v_category
    from public.empties_categories
   where store_id = p_store_id and lower(name) = lower(btrim(p_category_name));

  if v_category is null then
    insert into public.empties_categories (store_id, name, kind, deposit)
    values (p_store_id, btrim(p_category_name), p_kind, coalesce(p_deposit, 0))
    returning id into v_category;
  end if;

  insert into public.product_returnables (product_id, empties_category_id, qty_per_base_unit,
                                         product_unit_id)
  values (p_product_id, v_category,
          -- A container's count cannot be derived from quantity — whether the crate physically left
          -- is declared at the till — so it is null here by design, not by omission.
          case when p_kind = 'content' then coalesce(p_qty_per_base_unit, 1) end,
          -- WHICH SHAPE this pool is the container for, so a sale can owe in the shape it sold.
          -- Checked against the product: a shape from another item would owe the wrong thing.
          (select pu.id from public.product_units pu
            where pu.id = p_product_unit_id and pu.product_id = p_product_id))
  on conflict (product_id, empties_category_id) do update
     set qty_per_base_unit = excluded.qty_per_base_unit,
         product_unit_id   = coalesce(excluded.product_unit_id,
                                      public.product_returnables.product_unit_id);

  return v_category;
end;
$function$;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public' and pr.proname in ('record_sale', 'set_product_returnable')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a returnable writer has % overloads', n;
    end if;
  end loop;
end;
$check$;
