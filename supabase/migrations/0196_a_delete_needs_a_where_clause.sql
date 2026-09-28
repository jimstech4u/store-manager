-- 0196 — The bare DELETE that broke every correction
--
-- 0190 taught `amend_sale` to carry a receipt's deposit through the rewrite, using a temporary
-- table to remember what each product was holding. It cleared that table with:
--
--     delete from amend_deposit_held;
--
-- This database runs with safe updates on, which refuses a DELETE with no WHERE clause. The
-- statement sits near the top of the function, so it did not degrade corrections — it stopped
-- them. Every attempt to correct a receipt failed with "DELETE requires a WHERE clause".
--
-- Caught by `scripts/run-scenarios.mjs`, which settles a sale and then corrects it. I had checked
-- 0190 by reading it and by confirming the function compiled; neither of those runs the code. A
-- migration that only ever gets type-checked is a migration nobody has executed.

CREATE OR REPLACE FUNCTION public.amend_sale(p_sale_id uuid, p_reason text, p_lines jsonb DEFAULT NULL::jsonb, p_customer_id uuid DEFAULT NULL::uuid, p_charges jsonb DEFAULT NULL::jsonb, p_payments jsonb DEFAULT NULL::jsonb, p_deposit money_amt DEFAULT NULL::numeric, p_deposit_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_deposit    money_amt;
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

  /*
   * WHAT EACH PRODUCT WAS HOLDING ON DEPOSIT, remembered before the lines are thrown away.
   *
   * This function rewrites `sale_lines` wholesale and never wrote `deposit_charged`, so every
   * correction silently reset it to zero. A shop fixing a quantity on a receipt that carried
   * N400 against the crates lost the N400 from the record — and the customer is still owed it,
   * because the money genuinely changed hands.
   *
   * Kept per PRODUCT rather than per line: the lines are being replaced and their ids are gone,
   * so the product is the only thing that survives the rewrite to match on.
   *
   * This PRESERVES, it does not edit. Changing a deposit is a different act with a different
   * record — it is money held for somebody, so it moves through the customer's ledger, not by
   * being typed over on a correction screen.
   */
  create temporary table if not exists amend_deposit_held (
    product_id uuid primary key,
    amount     numeric not null
  ) on commit drop;
  -- WITH A WHERE CLAUSE. This session runs with safe updates on, so a bare DELETE is refused
  -- outright — and because it sits at the top of `amend_sale`, it refused every correction.
  delete from amend_deposit_held where true;

  insert into amend_deposit_held (product_id, amount)
  select sl.product_id, sum(sl.deposit_charged)
    from public.sale_lines sl
   where sl.sale_id = p_sale_id and coalesce(sl.deposit_charged, 0) > 0
   group by sl.product_id;

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

    /*
     * The deposit this product was carrying, handed to the first corrected line that replaces it
     * and then spent, so two lines of one product do not each claim the whole of it.
     */
    select coalesce(h.amount, 0) into v_deposit
      from amend_deposit_held h where h.product_id = v_prod;
    delete from amend_deposit_held where product_id = v_prod;

    insert into public.sale_lines (sale_id, product_id, sale_unit_id, entered_qty, base_qty,
                                   unit_price, line_total, unit_cost_at_sale, containers_out,
                                   deposit_charged)
    values (p_sale_id, v_prod, v_unit, v_entered, v_base, v_price, v_ltotal, v_cost, v_cout,
            coalesce(v_deposit, 0))
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
