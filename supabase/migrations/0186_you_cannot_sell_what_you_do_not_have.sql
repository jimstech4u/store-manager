-- 0186 — You cannot sell what you do not have
--
-- Ashabi is holding Goldberg 60cl at MINUS 1,512, Malta Guinness Can 33cl at minus 792 and
-- American Cola PET 60cl at minus 246. Nothing in the ledger is wrong — every movement reconciles
-- exactly against its sale — the shop has simply been allowed to sell stock it never booked in,
-- over and over, and the stock card faithfully recorded the hole getting deeper.
--
-- A negative figure is worth SHOWING: it is how a shop finds out a delivery was never entered. It
-- is not worth SELLING against. Once the count is a work of fiction, every margin, every valuation
-- and every "what do I need to reorder" is computed from it, and a stock take months later finds a
-- difference nobody can explain because the explanation is spread over two hundred sales.
--
-- So the ledger keeps telling the truth and the till stops making it worse.
--
-- WHERE THE CHECK GOES. Inside the per-line loop, immediately before the movement is written —
-- not up front over the whole basket. Two lines of the same product in one sale must be judged
-- TOGETHER, and they are, because the earlier line's movement is already inserted by the time the
-- later one asks. Checking the basket up front would let a shop sell the last crate twice.
--
-- `amend_sale` gets it too, and gets it in the right place: that function reverses everything the
-- sale did before writing the correction, so by the time the new movement is written the old stock
-- is already back. Guarding earlier would refuse corrections that are only putting things right.

-- ─── The guard itself ───────────────────────────────────────────────────────────────

create or replace function public.assert_stock_available(p_product_id uuid, p_base_qty qty)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_have qty;
  v_name text;
  v_unit text;
begin
  /*
   * Nothing leaving the shelf, nothing to check.
   *
   * A correction that REDUCES a quantity arrives here as a negative, and a zero line is a line
   * somebody cleared. Refusing either would block the two operations a shop uses to fix exactly
   * the problem this function exists to stop.
   */
  if p_base_qty is null or p_base_qty <= 0 then
    return;
  end if;

  select p.name, p.base_unit into v_name, v_unit
    from public.products p where p.id = p_product_id;

  select coalesce(sum(m.qty_delta), 0) into v_have
    from public.stock_movements m where m.product_id = p_product_id;

  if v_have >= p_base_qty then
    return;
  end if;

  /*
   * IN BASE UNITS, and said plainly.
   *
   * The seller chose crates and this talks in pieces, which is not ideal — but it is the figure
   * the stock card shows and the one they will be reconciling against, and inventing a conversion
   * here would mean two places deciding what a crate is worth. What matters is that the message
   * names the item and both numbers, so somebody at a counter knows what to do rather than
   * seeing "constraint violated".
   */
  if v_have <= 0 then
    raise exception 'There is no % left to sell. Book in a delivery first.',
      coalesce(v_name, 'that item')
      using errcode = '23514';
  else
    raise exception 'Only % % of % left, and this sale needs %. Book in a delivery first.',
      trim(to_char(v_have, 'FM999999990.####')),
      coalesce(v_unit, 'units'),
      coalesce(v_name, 'that item'),
      trim(to_char(p_base_qty, 'FM999999990.####'))
      using errcode = '23514';
  end if;
end;
$$;

comment on function public.assert_stock_available(uuid, qty) is
  'Refuses to let a sale take a product below zero. Called per line, immediately before the '
  'movement is written, so two lines of the same product in one sale are judged together. '
  'A zero or negative quantity passes: that is a correction putting stock back, not a sale.';

grant execute on function public.assert_stock_available(uuid, qty) to authenticated;

-- ─── And the two places a sale takes stock off the shelf ────────────────────────────
--
-- Both bodies below are the live definitions, byte for byte, plus one `perform` each.

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

CREATE OR REPLACE FUNCTION public.amend_sale(p_sale_id uuid, p_reason text, p_lines jsonb DEFAULT NULL::jsonb, p_customer_id uuid DEFAULT NULL::uuid, p_charges jsonb DEFAULT NULL::jsonb, p_payments jsonb DEFAULT NULL::jsonb, p_deposit money_amt DEFAULT NULL::numeric, p_deposit_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sale     record;
  v_line     record;
  v_new      jsonb;
  v_customer uuid;
  v_total    money_amt := 0;
  v_paid     money_amt := 0;
  v_charge   record;
  v_pay      record;
  v_fee      money_amt;
  v_amount   money_amt;
  v_payment  uuid;
  v_sort     int := 0;
  v_owing    money_amt;
  v_out      numeric := 0;
  v_prod     uuid;
  v_unit     uuid;
  v_entered  numeric;
  v_base     numeric;
  v_price    numeric;
  v_ltotal   numeric;
  v_cout     numeric;
  v_cost     unit_cost;
  v_line_id  uuid;
  v_rev      int;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    raise exception 'that sale does not exist' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_sale.store_id, 'sales.amend') then
    raise exception 'you do not have permission to correct a sale' using errcode = '42501';
  end if;

  if v_sale.status <> 'posted' then
    raise exception 'that sale is %, so there is nothing to correct', v_sale.status
      using errcode = '22023';
  end if;

  -- A reason, always. "Why does this receipt differ from the one I was given" is asked weeks later
  -- by somebody who was not there, and it is the part that settles the argument.
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'say why this receipt is being corrected' using errcode = '22023';
  end if;

  /*
   * NOT IF THE CONTAINERS HAVE STARTED COMING BACK.
   *
   * The same guard `void_sale` keeps, and for the same reason: reversing four crates when three
   * have already been handed in leaves the customer owing minus one, which means nothing and
   * cannot be chased. The way out is to finish settling first, and the message says so.
   */
  if exists (
    select 1 from public.customer_empties
     where ref_table = 'sale_lines'
       and ref_id in (select id from public.sale_lines where sale_id = p_sale_id)
       and direction in ('returned', 'damaged')
  ) then
    raise exception
      'Some of the containers on this receipt have already come back. Settle the rest first, then correct it.'
      using errcode = '22023';
  end if;

  v_customer := coalesce(p_customer_id, v_sale.store_customer_id);
  v_new      := coalesce(p_lines, (public.sale_document(p_sale_id) -> 'lines'));

  /*
   * ─── TAKING EVERYTHING OFF A RECEIPT CANCELS IT ──────────────────────────────────
   *
   * The correction screen is the till: a seller removes the lines that should not be there. Remove
   * the last one and the honest answer is that the sale did not happen — and until now this
   * function would have written it as a POSTED receipt with no lines on it, whose total was
   * whatever transport had been added. A document that says a customer owes ₦2,000 for nothing.
   *
   * Handed to `void_sale` rather than reimplemented, and BEFORE anything here is reversed. Voiding
   * is not "amending to zero": it puts the stock back, releases the containers, unallocates the
   * payments and marks the sale cancelled so the copy the customer is holding reads as cancelled
   * when they open it. Reimplementing a subset of that is how two different cancellations come to
   * exist, and only one of them tells the customer.
   *
   * `void_sale` keeps its own guards — the same `sales.amend` permission, and its refusal when
   * containers have started coming back — so nothing is loosened by arriving through here.
   *
   * WHY NOT REFUSE AND MAKE THEM PRESS VOID: because the seller has already said what they mean.
   * Emptying a receipt and being told to go and do a different thing instead is the software
   * arguing with somebody who is right.
   */
  if v_new is null
     or jsonb_typeof(v_new) <> 'array'
     or not exists (
       select 1 from jsonb_array_elements(v_new) as t(l)
        where coalesce(
                (t.l ->> 'entered_qty')::numeric,
                (t.l ->> 'qty')::numeric,
                0
              ) <> 0
     )
  then
    perform public.void_sale(p_sale_id, btrim(p_reason));
    return jsonb_build_object(
      'sale_id',     p_sale_id,
      'revision',    v_sale.revision,
      'total',       0,
      'paid',        0,
      'owing',       0,
      'customer_id', v_sale.store_customer_id,
      -- The caller has to know it was cancelled rather than corrected: it sends the seller to a
      -- cancelled receipt, not to a new revision of a live one.
      'voided',      true
    );
  end if;

  /*
   * AND THE CUSTOMER, IF ONE IS BEING ATTACHED, HAS TO BE THIS SHOP'S.
   *
   * Permission in a store answers "may this person act here", never "is this customer theirs" —
   * the hole 0097 and 0098 closed across the trade writers. Asked where no optional argument can
   * skip it.
   */
  if p_customer_id is not null then
    if not exists (
      select 1 from public.store_customers
       where id = p_customer_id and store_id = v_sale.store_id
    ) then
      raise exception 'that customer is not yours' using errcode = '42501';
    end if;
  end if;

  -- ─── Keep what it says now, before anything changes it ────────────────────────────
  v_rev := coalesce(v_sale.revision, 1);
  insert into public.sale_revisions (sale_id, store_id, revision, document, reason)
  values (p_sale_id, v_sale.store_id, v_rev, public.sale_document(p_sale_id), btrim(p_reason));

  -- ─── Reverse everything the sale did ──────────────────────────────────────────────
  --
  -- Exactly as `void_sale` does it: a second movement saying what happened next, never an edit to
  -- the first. The original is a fact about Tuesday and stays one.
  for v_line in select * from public.sale_lines where sale_id = p_sale_id
  loop
    if v_line.base_qty <> 0 then
      insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                          ref_table, ref_id, occurred_at, note)
      values (v_sale.store_id, v_line.product_id, 'adjustment', v_line.base_qty,
              v_line.unit_cost_at_sale, 'sales', p_sale_id, now(),
              'receipt corrected: ' || btrim(p_reason));
    end if;

    -- The containers this line owed are no longer owed in that quantity.
    insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                         direction, qty, reason, ref_table, ref_id, side)
    select ce.store_id, ce.store_customer_id, ce.product_id, ce.product_unit_id,
           'returned', ce.qty, 'receipt corrected: ' || btrim(p_reason), 'sale_lines', ce.ref_id,
           ce.side
      from public.customer_empties ce
     where ce.ref_table = 'sale_lines' and ce.ref_id = v_line.id and ce.direction = 'out';

    perform public.refresh_period(public.ensure_open_period(v_line.product_id));
  end loop;

  delete from public.sale_lines where sale_id = p_sale_id;

  -- ─── And apply what it should have said ───────────────────────────────────────────
  update public.sales
     set store_customer_id = v_customer
   where id = p_sale_id;

  /*
   * AND THE MONEY ALREADY PAID FOLLOWS IT ONTO THE ACCOUNT.
   *
   * A walk-in's payment carries no customer, because there was nobody to carry. Attach a customer
   * to the receipt and leave the payment behind and `customer_balance` bills them for the whole
   * amount while the ₦8,000 they actually handed over sits against nobody — so somebody who owes
   * ₦4,000 is shown owing ₦12,000, and would be chased for it.
   *
   * Only payments ALLOCATED to this receipt, and only when the sale had no customer before: a
   * payment already belonging to somebody is not this correction's business.
   */
  if v_sale.store_customer_id is null and v_customer is not null then
    update public.payments p
       set store_customer_id = v_customer
      from public.payment_allocations a
     where a.payment_id = p.id
       and a.sale_id = p_sale_id
       and p.store_customer_id is null;
  end if;

  for v_line in select * from jsonb_array_elements(v_new) as t(l)
  loop
    v_prod    := (v_line.l ->> 'product_id')::uuid;
    v_unit    := nullif(v_line.l ->> 'sale_unit_id', '')::uuid;
    v_entered := coalesce((v_line.l ->> 'entered_qty')::numeric, (v_line.l ->> 'qty')::numeric);
    v_base    := (v_line.l ->> 'base_qty')::numeric;
    v_price   := coalesce((v_line.l ->> 'unit_price')::numeric, 0);
    v_ltotal  := coalesce((v_line.l ->> 'line_total')::numeric, v_entered * v_price);
    v_cout    := coalesce((v_line.l ->> 'containers_out')::numeric, 0);

    if not exists (
      select 1 from public.products where id = v_prod and store_id = v_sale.store_id
    ) then
      raise exception 'one of these items is not yours' using errcode = '42501';
    end if;

    -- The shape has to belong to the product; a client-authored id is never trusted, and the base
    -- quantity is derived from it when the caller did not send one.
    if v_unit is not null then
      if not exists (
        select 1 from public.product_units where id = v_unit and product_id = v_prod
      ) then
        raise exception 'that shape does not belong to that item' using errcode = '22023';
      end if;
      if v_base is null then
        select v_entered * base_qty into v_base from public.product_units where id = v_unit;
      end if;
    end if;
    v_base := coalesce(v_base, v_entered);

    select coalesce(avg_unit_cost, 0) into v_cost from public.products where id = v_prod;

    insert into public.sale_lines (sale_id, product_id, sale_unit_id, entered_qty, base_qty,
                                   unit_price, line_total, unit_cost_at_sale, containers_out)
    values (p_sale_id, v_prod, v_unit, v_entered, v_base, v_price, v_ltotal, v_cost, v_cout)
    returning id into v_line_id;

    /*
     * NOT BELOW ZERO (0186), and only HERE.
     *
     * Everything the sale did was reversed above, so the stock is already back on the shelf by
     * this point and the check sees what a corrected sale would really leave. Asking any earlier
     * would refuse a correction that is reducing a quantity — the very thing a shop does to fix
     * an over-sale.
     */
    perform public.assert_stock_available(v_prod, v_base);

    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at, note)
    values (v_sale.store_id, v_prod, 'sale', -v_base, v_cost, 'sales', p_sale_id, now(),
            'receipt corrected: ' || btrim(p_reason));

    perform public.refresh_period(public.ensure_open_period(v_prod));

    v_total := v_total + v_ltotal;
  end loop;

  /*
   * ─── THE NAMED CHARGES, AS THE CORRECTED RECEIPT SHOULD READ THEM ──────────
   *
   * Replaced rather than merged: a seller looking at the correction screen is looking at the list
   * they want the receipt to end up with, and merging would make deleting one impossible.
   *
   * `sales.fee_amount` is kept in step because it is what the TOTAL is built from — the itemised
   * list is what the receipt prints and the sum is what the arithmetic uses, and a receipt whose
   * printed charges do not add up to its total is the one nobody can explain.
   */
  if p_charges is not null then
    delete from public.sale_charges where sale_id = p_sale_id;
    v_fee := 0;
    for v_charge in select * from jsonb_array_elements(p_charges) as t(c)
    loop
      v_amount := coalesce((v_charge.c ->> 'amount')::money_amt, 0);
      if v_amount <> 0 then
        insert into public.sale_charges (sale_id, label, amount, sort_order)
        values (p_sale_id,
                coalesce(nullif(btrim(v_charge.c ->> 'label'), ''), 'Extra charge'),
                v_amount, v_sort);
        v_fee := v_fee + v_amount;
        v_sort := v_sort + 1;
      end if;
    end loop;

    update public.sales
       set fee_amount = v_fee,
           -- One label, for the older readers that show a single lumped charge. The itemised list
           -- above is what the receipt prints.
           fee_label  = case when v_sort = 1
                             then (select label from public.sale_charges where sale_id = p_sale_id)
                             when v_sort > 1 then 'Extra charges'
                             else null end
     where id = p_sale_id;

    v_sale.fee_amount := v_fee;
  end if;

  v_total := v_total + coalesce(v_sale.fee_amount, 0);

  update public.sales
     set total        = v_total,
         revision     = v_rev + 1,
         amend_reason = btrim(p_reason),
         updated_at   = now()
   where id = p_sale_id;

  /*
   * ─── AND AN OBLIGATION NEEDS SOMEBODY TO OWE IT ─────────────────────────────────
   *
   * Checked AFTER the new lines are in, because whether one exists is a fact about the corrected
   * receipt and not about the old one. A walk-in sale corrected into something that leaves money
   * owing or containers out has nobody on the other end: the debt cannot be chased and the crates
   * cannot be settled, so they would sit on the "still out" list for ever.
   */
  /*
   * WHAT HAS BEEN PAID AGAINST THIS RECEIPT, through `payment_allocations`.
   *
   * `payments` has no `ref_table`/`ref_id` — a payment is a sum of money that arrived, and which
   * receipts it settles is a separate fact, because one payment can clear three receipts and one
   * receipt can take four payments. A first draft of this function read a `payments.ref_id` that
   * does not exist; plpgsql does not check column names until the body RUNS, so it applied cleanly
   * and would have failed on the first real correction.
   */
  /*
   * ─── MONEY HANDED OVER WHILE THE RECEIPT WAS BEING CORRECTED ───────────────
   *
   * A correction routinely finds more owing — a crate that went out and was never keyed — and the
   * customer pays the difference there and then. Recorded the same way `settle_draft_with_deposit`
   * records one: a payment row, and an ALLOCATION to this receipt.
   *
   * The allocation is the part that matters and the part that was once missed elsewhere. `payments`
   * has no `sale_id`; everything that reports what a receipt was paid reads `payment_allocations`.
   * Without it the money exists, unattached, while the receipt still reads as owing its full total —
   * and the customer gets chased for what they have already handed over.
   */
  if p_payments is not null then
    for v_pay in select * from jsonb_array_elements(p_payments) as t(p)
    loop
      v_amount := coalesce((v_pay.p ->> 'amount')::money_amt, 0);
      if v_amount > 0 then
        insert into public.payments (store_id, store_customer_id, amount, method, reference,
                                     bank_account_id, occurred_at)
        values (v_sale.store_id, v_customer, v_amount,
                coalesce(v_pay.p ->> 'method', 'cash'),
                nullif(v_pay.p ->> 'reference', ''),
                nullif(v_pay.p ->> 'bank_account_id', '')::uuid,
                now())
        returning id into v_payment;

        insert into public.payment_allocations (payment_id, sale_id, amount)
        values (v_payment, p_sale_id, v_amount);
      end if;
    end loop;
  end if;

  /*
   * And a deposit against the containers this correction puts out. Only with somebody to hold it
   * for: a deposit belongs to a customer, and one taken against nobody could never be given back.
   */
  if p_deposit is not null and p_deposit > 0 and v_customer is not null then
    insert into public.deposit_holdings (store_id, store_customer_id, amount, reason,
                                         ref_table, ref_id, note, occurred_at)
    values (v_sale.store_id, v_customer, p_deposit, 'sale_amended',
            'sales', p_sale_id, nullif(btrim(coalesce(p_deposit_reason, '')), ''), now());
  end if;

  select coalesce(sum(a.amount), 0) into v_paid
    from public.payment_allocations a
   where a.sale_id = p_sale_id;

  v_owing := v_total - v_paid;

  select coalesce(sum(containers_out), 0) into v_out
    from public.sale_lines where sale_id = p_sale_id;

  if v_customer is null and (v_owing > 0 or v_out > 0) then
    raise exception
      'This receipt now leaves % owing and % containers out. Add a customer, because there has to be somebody to owe it.',
      v_owing, v_out
      using errcode = '22023';
  end if;

  /*
   * THE CONTAINERS ARE ALREADY WRITTEN, by the trigger, and must not be written again.
   *
   * `tg_sale_line_owes_containers` (0117) fires on INSERT and returns early when the sale has no
   * customer. The customer is attached ABOVE, before the new lines go in — so by the time the
   * trigger sees them there is somebody to owe the crates, and it does the job itself.
   *
   * A first version also inserted them here "because the walk-in never had them", which doubled
   * every obligation on a corrected walk-in: three crates became six. The probe caught it as
   * «8, expected 2 + 3». Attaching the customer before the lines is what makes the extra insert
   * both unnecessary and wrong.
   */

  return jsonb_build_object(
    'sale_id',      p_sale_id,
    'revision',     v_rev + 1,
    'total',        v_total,
    'paid',         v_paid,
    'owing',        v_owing,
    'customer_id',  v_customer,
    -- Always present, so a caller reads one shape rather than testing whether a key exists.
    'voided',       false
  );
end;
$function$;
