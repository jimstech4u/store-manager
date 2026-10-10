-- 0258 - A correction takes its deposit the way a sale does
--
-- Live, 10 Oct 2026: correcting a receipt (₦196,000 → ₦217,000, ₦21,000 taken) failed with
-- "new row for relation deposit_holdings violates check constraint deposit_holdings_reason_check".
-- `amend_sale` recorded a deposit added in a correction into `deposit_holdings` as 'sale_amended' — a
-- reason that table's check has never allowed (taken, refunded, applied_to_shortfall, sale_voided),
-- and a table nothing else uses any more (it is empty). So every correction carrying a new deposit
-- failed, whatever else it did.
--
-- Now it is taken exactly as a sale takes one (`settle_draft_with_deposit`, 0244): the customer's
-- deposit (`take_customer_deposit`) and the one charge that moves that money out of the account, at
-- the correction's moment. And `sale_deposit_put_down` counts deposits at the receipt's corrections
-- as well as at the sale, as `sale_deposit_unpaid` already counts its payments — so the receipt says
-- "Deposit, held for you".
--
-- Both functions copied from the live definitions with only those lines changed.

CREATE OR REPLACE FUNCTION public.amend_sale(p_sale_id uuid, p_reason text, p_lines jsonb DEFAULT NULL::jsonb, p_customer_id uuid DEFAULT NULL::uuid, p_charges jsonb DEFAULT NULL::jsonb, p_payments jsonb DEFAULT NULL::jsonb, p_deposit money_amt DEFAULT (NULL::numeric)::money_amt, p_deposit_reason text DEFAULT NULL::text)
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
  values (p_sale_id, v_sale.store_id, v_rev, public.sale_document(p_sale_id)
                 -- THE RECEIPT AS THE CUSTOMER HELD IT (0257): every line of the paper, Still with you,
                 -- the balance, the deposit and the change, read as at that version.
                 || jsonb_build_object('paper', public.sale_detail(p_sale_id)),
          btrim(p_reason));

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
                                         direction, qty, reason, ref_table, ref_id, side,
                                         occurred_at)
    select ce.store_id, ce.store_customer_id, ce.product_id, ce.product_unit_id,
           'returned', ce.qty, 'receipt corrected: ' || btrim(p_reason), 'sale_lines', ce.ref_id,
           ce.side,
           /*
            * DATED TO THE ROW IT REVERSES, not to the moment of correcting.
            *
            * `sale_detail` prints what a customer still holds AS AT THE SALE, so a receipt
            * reprinted next month says what it said the day it was handed over. Stamped with
            * `now()`, this reversal fell OUTSIDE that window while the line re-inserted below is
            * stamped with the sale's own time and falls inside it — so an as-at view counted the
            * containers twice and missed the cancelling entry.
            *
            * Destiny's receipt: half a crate of 7up sold, half a crate owed on her account, and
            * "Still with you — Seven-Up (SBC) crate 1" on the paper.
            *
            * This is not back-dating a fact. The fact is "that row should not have said what it
            * said", and it is about that moment; the reason and the revision record when it was
            * noticed.
            */
           ce.occurred_at
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

  /*
   * MOVED TO ANOTHER CUSTOMER, AND ITS COUNTER MONEY GOES WITH IT (0240).
   *
   * The receipt was on the wrong person. Whatever was handed over for THIS receipt — at the sale,
   * or during one of its corrections — and paid nothing else, was paid by whoever was really
   * there. Left behind, the right customer is billed in full while the wrong one shows credit.
   * A payment that also paid other receipts belongs to its customer and stays.
   */
  if v_sale.store_customer_id is not null and v_customer is distinct from v_sale.store_customer_id then
    update public.payments p
       set store_customer_id = v_customer
     where p.store_customer_id = v_sale.store_customer_id
       and p.reverses_payment_id is null
       and exists (select 1 from public.payment_allocations a
                    where a.payment_id = p.id and a.sale_id = p_sale_id)
       and not exists (select 1 from public.payment_allocations a
                        where a.payment_id = p.id and a.sale_id <> p_sale_id)
       and (p.occurred_at = v_sale.occurred_at
            or p.occurred_at in (select r.amended_at from public.sale_revisions r
                                  where r.sale_id = p_sale_id));
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
  /*
   * NEVER PAID PAST ITS TOTAL (0240). Corrected below what was already paid, the receipt keeps only
   * its total — the newest money comes off first — and the rest is the customer's credit (or, on a
   * walk-in, change to hand back). The balance counts payments, not allocations, so no account moves.
   */
  declare
    v_over  numeric;
    v_alloc record;
  begin
    v_over := coalesce((select sum(amount) from public.payment_allocations
                         where sale_id = p_sale_id), 0) - v_total;
    for v_alloc in select * from public.payment_allocations
                    where sale_id = p_sale_id
                    order by created_at desc, id desc
    loop
      exit when v_over <= 0;
      if v_alloc.amount <= v_over then
        delete from public.payment_allocations where id = v_alloc.id;
        v_over := v_over - v_alloc.amount;
      else
        update public.payment_allocations set amount = amount - v_over where id = v_alloc.id;
        v_over := 0;
      end if;
    end loop;
  end;

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

        -- This receipt first, never past its total; any surplus pays older debts, then is credit.
        perform public.allocate_payment(v_payment, p_sale_id);
      end if;
    end loop;
  end if;

  /*
   * And a deposit against the containers this correction puts out. Only with somebody to hold it
   * for: a deposit belongs to a customer, and one taken against nobody could never be given back.
   */
  if p_deposit is not null and p_deposit > 0 and v_customer is not null then
    /*
     * TAKEN AS A SALE TAKES ONE (0258): the customer's deposit, and the one line that moves it out of
     * the account, at the correction's moment. This wrote `deposit_holdings` with a reason its own
     * check has never allowed ('sale_amended'), so every correction that added a deposit failed.
     */
    perform public.take_customer_deposit(v_sale.store_id, v_customer, p_deposit,
                                         nullif(btrim(coalesce(p_deposit_reason, '')), ''), now());
    insert into public.customer_charges (store_id, store_customer_id, direction, amount, reason, occurred_at)
    values (v_sale.store_id, v_customer, 'charge', p_deposit,
            'Put down as a deposit' || coalesce(' (' || nullif(btrim(coalesce(p_deposit_reason, '')), '') || ')', ''),
            now());
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

CREATE OR REPLACE FUNCTION public.sale_deposit_put_down(p_sale_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select greatest(
    coalesce(sum(case when cd.direction = 'taken' then cd.amount
                      when cd.direction = 'given' and cd.reason like 'Cancelled in a correction%' then -cd.amount
                      else 0 end), 0), 0)
    from public.customer_deposits cd
    join public.sales s on s.id = p_sale_id
   where cd.store_customer_id = s.store_customer_id
     -- At the sale, or at one of its corrections (0258) — the rule its payments already follow.
     and (cd.occurred_at = s.occurred_at
          or cd.occurred_at in (select r.amended_at from public.sale_revisions r where r.sale_id = s.id));
$function$;

notify pgrst, 'reload schema';
