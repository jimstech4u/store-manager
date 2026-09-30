-- 0240 - A receipt is the account as at the version being shown, and money handed over for a
--        receipt pays that receipt first
--
-- "The receipt closed with no payment, then I corrected it and added a lesser payment because the
-- customer did not pay all — and got back that they owe it all again." Oroja brother, 30 Sep: a
-- N13,200 receipt, corrected with N13,100 paid, printed "Owed before N13,100 · Total owed N13,200".
-- The account was right (N100); the paper was not.
--
-- THE CAUSE. The receipt read the account "as at the sale" (0149, so a reprint next month says what
-- it said when handed over) — at the sale's ORIGINAL time. A correction's payment is dated when the
-- correction is made, after that, so the account left it out while the Paid line counted it: the
-- receipt worked back to an "owed before" that never existed. The same happens to any receipt that a
-- later payment reached — Busayo Store, Dcc and Destiny printed the same kind of wrong "owed before"
-- on a reprint.
--
-- 1. THE RECEIPT'S MOMENT. `receipt_moment(sale)`: when the version being shown was issued — the
--    sale's time, or the time of its latest correction. Paid, Owed before, Total owed and the
--    empties still with them are ALL read at that moment, in the till's copy and the customer's link
--    alike, so they cannot disagree and a reprint still says what was handed over.
-- 2. A VOIDED PAYMENT NEVER HAPPENED, as far as a receipt is concerned: `void_payment` takes its
--    allocations off, so the account-as-at leaves out the payment and its reversal too (at any time
--    after the void the two net to nothing, so every balance today is unchanged).
-- 3. MONEY HANDED OVER FOR A RECEIPT PAYS THAT RECEIPT FIRST. At the till a named customer's money
--    went oldest-debt-first, so a customer still owing on an old receipt who paid cash for today's
--    goods was handed a receipt saying "Paid N0". Now: this receipt first, then older debts, and any
--    remainder is credit. One allocator, `allocate_payment`, used by the till, corrections and
--    account payments.
-- 4. A CORRECTION NEVER LEAVES A RECEIPT PAID PAST ITS TOTAL. Lowered below what was paid, the
--    receipt keeps only its total; the rest stays with the customer as credit (the balance already
--    counts payments, not allocations, so no account moves).
-- 5. A RECEIPT MOVED TO ANOTHER CUSTOMER TAKES ITS COUNTER MONEY WITH IT. Money handed over for this
--    receipt alone — at the sale or during one of its corrections — follows it, or the new customer
--    is billed in full while the old one shows credit.

-- ─── 1. When the version being shown was issued ────────────────────────────────────────────
create or replace function public.receipt_moment(p_sale_id uuid)
returns timestamptz
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select greatest(s.occurred_at,
                  coalesce((select max(r.amended_at) from public.sale_revisions r
                             where r.sale_id = s.id), s.occurred_at))
    from public.sales s
   where s.id = p_sale_id;
$function$;

revoke all on function public.receipt_moment(uuid) from public, anon, authenticated;

-- ─── 2. What a customer owed at a moment — a voided payment and its reversal left out ──────
create or replace function public.customer_owed_as_at(p_customer uuid, p_at timestamptz)
returns numeric
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select (
    coalesce((select sum(s.total) from public.sales s
               where s.store_customer_id = p_customer and s.status = 'posted'
                 and s.occurred_at <= p_at), 0)
    - coalesce((select sum(case when p.direction = 'in' then p.amount else -p.amount end)
                  from public.payments p
                 where p.store_customer_id = p_customer and p.occurred_at <= p_at
                   -- Voided: the payment and its reversal are one mistake, not two events.
                   and p.reverses_payment_id is null
                   and not exists (select 1 from public.payments r
                                    where r.reverses_payment_id = p.id)), 0)
    + coalesce((select sum(case when c.direction = 'charge' then c.amount else -c.amount end)
                  from public.customer_charges c
                 where c.store_customer_id = p_customer and c.occurred_at <= p_at), 0)
    + coalesce((select sum(ob.amount) from public.opening_balances ob
                 where ob.store_customer_id = p_customer and ob.kind = 'debtor'
                   and ob.as_of_date <= p_at::date), 0)
  )::numeric;
$function$;

-- ─── 3. One allocator: the receipt it was handed over for first, then oldest debt first ─────
create or replace function public.allocate_payment(p_payment_id uuid, p_first_sale uuid default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_pay       record;
  v_remaining numeric;
  v_sale      record;
  v_applied   numeric;
begin
  select * into v_pay from public.payments where id = p_payment_id;
  if not found or v_pay.direction <> 'in' then
    return;
  end if;

  v_remaining := v_pay.amount - coalesce((select sum(amount) from public.payment_allocations
                                           where payment_id = p_payment_id), 0);

  for v_sale in
    select s.id,
           s.total - coalesce((select sum(pa.amount) from public.payment_allocations pa
                                where pa.sale_id = s.id), 0) as outstanding
      from public.sales s
     where s.status = 'posted'
       and (s.id = p_first_sale
            or (v_pay.store_customer_id is not null and s.store_customer_id = v_pay.store_customer_id))
     -- The receipt it was handed over for, then the oldest.
     order by (s.id = p_first_sale) desc nulls last, s.occurred_at asc
  loop
    exit when v_remaining <= 0;
    continue when v_sale.outstanding <= 0;
    v_applied := least(v_remaining, v_sale.outstanding);
    insert into public.payment_allocations (payment_id, sale_id, amount)
    values (p_payment_id, v_sale.id, v_applied);
    v_remaining := v_remaining - v_applied;
  end loop;
  -- Anything left over stays unallocated: credit for a customer, change for a walk-in.
end;
$function$;

revoke all on function public.allocate_payment(uuid, uuid) from public, anon, authenticated;

-- ─── record_payment: through the one allocator ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_payment(p_store_id uuid, p_customer_id uuid, p_amount money_amt, p_method text DEFAULT 'cash'::text, p_reference text DEFAULT NULL::text, p_occurred_at timestamp with time zone DEFAULT now(), p_client_uuid uuid DEFAULT NULL::uuid, p_bank_account_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_payment_id uuid;
begin
  if not public.has_permission(p_store_id, 'payments.record') then
    raise exception 'you do not have permission to record a payment' using errcode = '42501';
  end if;

  insert into public.payments (store_id, store_customer_id, amount, method, reference,
                               occurred_at, client_uuid, bank_account_id)
  values (p_store_id, p_customer_id, p_amount, p_method, p_reference, p_occurred_at,
          p_client_uuid, p_bank_account_id)
  returning id into v_payment_id;

  -- Oldest debt first, only what is still owed on each; anything left is credit (0240).
  perform public.allocate_payment(v_payment_id);

  return v_payment_id;
end;
$function$;

-- ─── settle_sale: the till's money pays this receipt first ────────────────────────────
CREATE OR REPLACE FUNCTION public.settle_sale(p_store_id uuid, p_lines jsonb, p_payments jsonb DEFAULT '[]'::jsonb, p_customer_id uuid DEFAULT NULL::uuid, p_fee_amount money_amt DEFAULT 0, p_fee_label text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_occurred_at timestamp with time zone DEFAULT now(), p_client_uuid uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_alloc      money_amt;
  -- The walk-in payment just written, so it can be allocated to this sale.
  v_payment_id uuid;
  v_sale_id   uuid;
  v_pay       jsonb;
  v_amount    money_amt;
  v_settings  record;
  v_transfer  text;
  v_total     money_amt;
begin
  if p_client_uuid is not null then
    select id into v_sale_id from public.sales where client_uuid = p_client_uuid;
    if v_sale_id is not null then
      return v_sale_id;                     -- a retry, not a second sale
    end if;
  end if;

  -- record_sale checks the permission, moves stock and builds empties obligations.
  v_sale_id := public.record_sale(p_store_id, p_lines, p_customer_id, p_occurred_at, p_client_uuid);

  /*
   * THE ONE CHANGED BLOCK. Everything else in this function is 0074's, byte for byte.
   *
   * The bank line used to be composed from three free-text boxes on the settings screen — typed
   * once, never checked against anything, and impossible to keep in step with the accounts the
   * shop actually banks into. A shop that closed an account had a receipt still asking customers
   * to pay into it.
   *
   * It now comes from `bank_accounts` — the same list the payment screen already picks from when
   * somebody pays by transfer — so there is one set of account numbers in the shop and the receipt
   * is printed from it. `receipt_bank_account_id` says which; failing that, the account the shop
   * marked default, because a shop with one account should not have to choose it twice.
   *
   * Still SNAPSHOT onto the sale. An old receipt keeps the account it was printed with, whatever
   * the shop banks into today — that is what makes a receipt a record rather than a view.
   */
  select * into v_settings from public.store_settings where store_id = p_store_id;
  if found and v_settings.show_transfer_details then
    select concat_ws(E'\n', ba.bank_name, ba.account_number, ba.account_name)
      into v_transfer
      from public.store_bank_accounts ba
     where ba.store_id = p_store_id
       and ba.status = 'active'
       and ba.id = coalesce(v_settings.receipt_bank_account_id, ba.id)
     order by (ba.id = v_settings.receipt_bank_account_id) desc nulls last,
              ba.is_default desc,
              ba.created_at
     limit 1;
  end if;

  update public.sales
     set fee_amount       = coalesce(p_fee_amount, 0),
         fee_label        = nullif(trim(p_fee_label), ''),
         note             = nullif(trim(p_note), ''),
         transfer_details = v_transfer,
         total            = total + coalesce(p_fee_amount, 0)
   where id = v_sale_id
  returning total into v_total;

  -- The order-level fee also becomes a NAMED CHARGE.
  --
  -- It was landing in `fee_amount` and in the total, and nowhere else — so a transport charge
  -- raised the bill by ₦2,000 and then could not be itemised on the receipt or answered for on
  -- the customer's account, which reads charges from `sale_charges`. "What was this ₦2,000 for?"
  -- is the question that gets asked weeks later, and the answer has to be somewhere.
  if coalesce(p_fee_amount, 0) > 0 then
    insert into public.sale_charges (sale_id, label, amount, sort_order)
    values (v_sale_id, coalesce(nullif(trim(p_fee_label), ''), 'Extra charge'),
            p_fee_amount,
            coalesce((select max(sort_order) + 1 from public.sale_charges
                       where sale_id = v_sale_id), 0));
  end if;

  -- Several payment methods on one sale: each becomes its own payment row, so the cash drawer
  -- and the bank can be reconciled separately later. record_payment allocates oldest-first.
  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    v_amount := (v_pay ->> 'amount')::money_amt;
    continue when coalesce(v_amount, 0) <= 0;

    if p_customer_id is null then
      /*
       * A walk-in paying cash has no ledger to settle against, so the payment is allocated
       * straight to this sale.
       *
       * The insert alone was here, with a comment claiming the payment was recorded against the
       * sale — it was not. `payments` has no `sale_id`, and everything that reports what a sale
       * was paid reads `payment_allocations`. Without the allocation the money existed, unattached,
       * while the sale read as owing its full total.
       */
      insert into public.payments (store_id, store_customer_id, amount, method, reference, occurred_at)
      values (p_store_id, null, v_amount, coalesce(v_pay ->> 'method', 'cash'),
              nullif(v_pay ->> 'reference', ''), p_occurred_at)
      returning id into v_payment_id;

      /*
       * CAPPED AT WHAT THE SALE STILL OWES (0188).
       *
       * This allocated the whole payment. A walk-in handing over N8,000 for a N7,600 bill had
       * N8,000 recorded against a N7,600 sale, so the sale read as overpaid by the N400 the
       * seller had just handed back as change — the same defect 0185 fixed in `record_payment`,
       * sitting in the other path into a sale.
       *
       * The PAYMENT keeps its true amount: the till said N8,000 was tendered and that is not this
       * function's to edit. Only the allocation is capped, so the surplus stays visibly
       * unattached rather than pretending to pay for something.
       */
      v_alloc := least(
        v_amount,
        greatest((select s.total from public.sales s where s.id = v_sale_id)
                 - coalesce((select sum(pa.amount) from public.payment_allocations pa
                              where pa.sale_id = v_sale_id), 0), 0));

      if v_alloc > 0 then
        insert into public.payment_allocations (payment_id, sale_id, amount)
        values (v_payment_id, v_sale_id, v_alloc);
      end if;
    else
      /*
       * THIS RECEIPT FIRST (0240). `record_payment` settled the customer's OLDEST debt first, so a
       * customer still owing on an old receipt who paid cash for today's goods was handed a
       * receipt saying "Paid N0". The money pays what it was handed over for; only the surplus
       * goes to older debts, and anything past that is credit.
       */
      if not public.has_permission(p_store_id, 'payments.record') then
        raise exception 'you do not have permission to record a payment' using errcode = '42501';
      end if;
      insert into public.payments (store_id, store_customer_id, amount, method, reference, occurred_at)
      values (p_store_id, p_customer_id, v_amount, coalesce(v_pay ->> 'method', 'cash'),
              nullif(v_pay ->> 'reference', ''), p_occurred_at)
      returning id into v_payment_id;
      perform public.allocate_payment(v_payment_id, v_sale_id);
    end if;
  end loop;

  return v_sale_id;
end;
$function$;

-- ─── amend_sale: moved money, never overpaid, this receipt first ──────────────────────
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

-- ─── sale_detail: read at the version's moment ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sale_detail(p_sale_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$

  select jsonb_build_object(
    'sale', to_jsonb(s) - 'store_id',
    'customer', case when sc.id is null then null else jsonb_build_object(
        'id', sc.id, 'name', sc.display_name, 'business', sc.business_name, 'phone', i.phone,
        'balance', public.customer_balance_total(sc.id)
      ) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sl.id,
        'product_id', sl.product_id,
        'product_name', p.name,
        'base_unit', p.base_unit,
        'entered_qty', sl.entered_qty,
        'pack_name', pk.name,
        /*
         * THE SHAPE IT WAS SOLD IN — the word the seller chose at the counter.
         *
         * `pack_name` is the retired one-pack-per-product model and is null for everything the
         * shop sells today, so the receipt fell through to `base_unit` and printed "1 pieces"
         * over a line that was one CRATE. The customer's copy said pieces, the paper said pieces,
         * and the shape was in the row all along under `sale_unit_id`.
         */
        'unit_name', su.name,
        'unit_plural', su.plural,
        'base_qty', sl.base_qty,
        'unit_price', sl.unit_price,
        'line_total', sl.line_total,
        'unit_cost_at_sale', sl.unit_cost_at_sale,
        'containers_out', sl.containers_out,
        'deposit', sl.deposit_charged
      ) order by sl.created_at)
      from public.sale_lines sl
      join public.products p on p.id = sl.product_id
      left join public.product_packs pk on pk.id = sl.entered_pack_id
      left join public.product_units pu on pu.id = sl.sale_unit_id
      left join public.store_units su on su.id = pu.store_unit_id
      where sl.sale_id = s.id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pay.id, 'amount', pa.amount, 'method', pay.method,
        'reference', pay.reference, 'occurred_at', pay.occurred_at
      ) order by pay.occurred_at)
      from public.payment_allocations pa
      join public.payments pay on pay.id = pa.payment_id
      where pa.sale_id = s.id
        -- Paid as at this version (0240): money that came later is on the account, not this paper.
        and pay.occurred_at <= public.receipt_moment(s.id)
    ), '[]'::jsonb),
    /*
     * WHAT IT USED TO SAY, so the printed copy can own up to it.
     *
     * A customer may be holding the previous version. Revision 1 carries nothing extra, so the
     * common case is unchanged; from revision 2 the receipt says what it replaces and when, and a
     * shop that corrected a bill in the customer's favour wants that visible.
     */
    /*
     * STILL WITH YOU — what THIS receipt sent out, in the shape it went out in.
     *
     * «the reader "still with you" uses what was bought by the customer — if it is 0.5 goldberg,
     *  3 gulder, 10 big turbo, it uses that data»
     *
     * Read from the container rows the sale itself wrote (`ref_table = 'sale_lines'`), netted
     * against anything written back against the same lines — which is exactly what a correction
     * does — so an amended receipt prints what it says NOW. One row per product shape, with its
     * maker, so the screen can apply the counter's rule: whole ones add across a maker, parts stay
     * with their beer. That rule lives in `rollUpOwed`, once, rather than in SQL twice.
     *
     * This used to read `deposit_ledger` pools on the shared link and nothing at all on the till's
     * copy, so a new sale printed no containers on either.
     */
    /*
     * STILL WITH THEM, AS AT THIS SALE (0149) — everything they held before it, plus what it sent
     * out. The block below, renamed `empties_this_sale`, is what this sale alone sent out.
     */
    'empties', case when sc.id is null then '[]'::jsonb
                    else public.customer_containers_as_at(sc.id, public.receipt_moment(s.id)) end,
    -- What they owed once this sale was recorded, as at the sale, so a reprint next month still says
    -- what this receipt said the day it was handed over.
    'account', case when sc.id is null then null
                    else jsonb_build_object(
                           'owed_after', public.customer_owed_as_at(sc.id, public.receipt_moment(s.id))) end,
    'empties_this_sale', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', t.product_id,
               'product_name', t.product_name,
               'product_unit_id', t.product_unit_id,
               'unit_name', t.unit_name,
               'unit_plural', t.unit_plural,
               'base_qty', t.base_qty,
               'group_id', t.group_id,
               'group_name', t.group_name,
               'owed', t.owed
             ) order by t.group_name nulls last, t.product_name)
        from (
          select ce.product_id,
                 pr.name  as product_name,
                 ce.product_unit_id,
                 su.name  as unit_name,
                 su.plural as unit_plural,
                 pu.base_qty,
                 g.group_id,
                 g.group_name,
                 sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) as owed
            /*
             * THIS SALE'S CONTAINER ROWS, from either place they can be.
             *
             * Written by the sale itself (`sale_lines`, since 0117), or carried over from the old deposit
             * ledger (0110), where the deposit row points at the sale. 62 older receipts have theirs only
             * in the second place and printed nothing although the ledger was right.
             */
            from (
              select c.* from public.customer_empties c
                join public.sale_lines sl on c.ref_table = 'sale_lines' and sl.id = c.ref_id
               where sl.sale_id = s.id
              union all
              select c.* from public.customer_empties c
                join public.deposit_ledger dl on c.ref_table = 'deposit_ledger' and dl.id = c.ref_id
               where dl.ref_table = 'sales' and dl.ref_id = s.id
            ) ce
            join public.products pr on pr.id = ce.product_id
            join public.product_units pu on pu.id = ce.product_unit_id
            join public.store_units su on su.id = pu.store_unit_id
            left join lateral (
              select c.id as group_id, c.name as group_name
                from public.product_category_links l
                join public.product_categories c on c.id = l.category_id
               where l.product_id = pr.id and coalesce(c.status, 'active') = 'active'
               order by c.name
               limit 1
            ) g on true
           where true
             and coalesce(ce.side, 'they_hold') = 'they_hold'
             /*
              * AND NOT TAKEN BACK BY A VOID. `unowe_voided_sale` (0117) writes its reversal under
              * `ref_table = 'sale_void'` pointing at the OUT row, not at the line — so without this a
              * cancelled receipt would still list the crates as with the customer.
              */
             and not exists (
               select 1 from public.customer_empties v
                where v.ref_table = 'sale_void' and v.ref_id = ce.id
             )
           group by ce.product_id, pr.name, ce.product_unit_id, su.name, su.plural,
                    pu.base_qty, g.group_id, g.group_name
          having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0
        ) t
    ), '[]'::jsonb),
    /*
     * THE NAMED CHARGES. Itemised, exactly as `read_shared_receipt` already sends them.
     *
     * This has never returned them, and the till's receipt reads `detail.charges` — so it was
     * reading `undefined`, printing nothing, and falling back to the single lumped `fee_amount`
     * which itemised shops no longer write. The customer's own web copy showed the transport and
     * the shop's printed one did not: two documents for one sale, disagreeing.
     */
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount, 'note', c.note)
                       order by c.sort_order)
        from public.sale_charges c where c.sale_id = s.id
    ), '[]'::jsonb),
    /*
     * AND WHAT WAS TAKEN ON DEPOSIT, which never appeared on the paper at all.
     *
     * A sale of N4,500 of goods with N500 held against the crates printed a total of N5,000 with
     * nothing to explain the difference — so the receipt disagreed with its own arithmetic, and
     * the one figure a customer comes back to argue about (what they get back when the crates
     * return) was the figure that was missing.
     */
    'deposit_total', coalesce((
      select sum(sl.deposit_charged) from public.sale_lines sl where sl.sale_id = s.id
    ), 0),
    'corrected', (
      select jsonb_build_object(
               'replaced_at', r.amended_at,
               'reason',      r.reason,
               'was_total',   r.document -> 'total'
             )
        from public.sale_revisions r
       where r.sale_id = s.id
       order by r.revision desc
       limit 1
    ),
    'draft', case when d.id is null then null else jsonb_build_object(
        'code', d.code, 'created_by', d.created_by, 'settled_by', d.settled_by,
        'settled_at', d.settled_at
      ) end
  )
  from public.sales s
  left join public.store_customers sc on sc.id = s.store_customer_id
  left join public.identities i on i.id = sc.identity_id
  left join public.draft_orders d on d.settled_sale_id = s.id
  where s.id = p_sale_id
    and public.is_store_member(s.store_id);
$function$;

-- ─── read_shared_receipt: read at the version's moment ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.read_shared_receipt(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_link record;
  v_out  jsonb;
begin
  select * into v_link
    from public.share_links
   where token = p_token
     and kind = 'receipt'
     and revoked_at is null
     and (expires_at is null or expires_at > now());

  -- Unknown, revoked and expired all answer the same, so the page cannot be used to find out
  -- whether a token ever existed.
  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'shop', jsonb_build_object(
      'name', st.name,
      'header', ss.receipt_header,
      'footer', ss.receipt_footer,
      'printer_width_mm', coalesce(ss.printer_width_mm, 80)
    ),
    'sale', jsonb_build_object(
      'id', s.id,
      'occurred_at', s.occurred_at,
      'total', s.total,
      'fee_amount', s.fee_amount,
      'fee_label', s.fee_label,
      'note', s.note,
      'transfer_details', s.transfer_details,
      /*
       * WHETHER THIS IS STILL A BILL.
       *
       * 'posted' is a live receipt. 'voided' is one the shop has cancelled — and the customer is
       * still holding it, so their copy has to say so rather than quietly going on asking for money
       * against a sale that no longer exists.
       */
      'status', s.status,
      'cancelled_reason', case when s.status = 'voided' then s.amend_reason end,
      /*
       * AND WHETHER THIS REPLACES A COPY THEY MAY STILL BE HOLDING.
       *
       * The customer is the ONE person guaranteed to have the old version — the shop sent it to
       * them. A corrected bill that looks identical to the one in their hand is how a shop ends up
       * arguing about a figure neither of them can source.
       */
      'revision', coalesce(s.revision, 1),
      'corrected', (
        select jsonb_build_object('replaced_at', r.amended_at, 'was_total', r.document -> 'total')
          from public.sale_revisions r
         where r.sale_id = s.id
         order by r.revision desc
         limit 1
      )
    ),
    'customer', case when sc.id is null then null
                     else jsonb_build_object('name', sc.display_name) end,

    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sl.id,
        'product_name', p.name,
        'base_unit', p.base_unit,
        'entered_qty', sl.entered_qty,
        'unit_name', coalesce(
          case when sl.entered_qty = 1 then su.name else su.plural end,
          pk.name),
        'unit_price', sl.unit_price,
        'line_total', sl.line_total,
        'containers_out', sl.containers_out,
        'deposit', sl.deposit_charged
      ) order by sl.created_at)
      from public.sale_lines sl
      join public.products p on p.id = sl.product_id
      left join public.product_packs pk on pk.id = sl.entered_pack_id
      left join public.product_units pu on pu.id = sl.sale_unit_id
      left join public.store_units su on su.id = pu.store_unit_id
      where sl.sale_id = s.id
    ), '[]'::jsonb),

    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount, 'note', c.note)
                       order by c.sort_order)
        from public.sale_charges c where c.sale_id = s.id
    ), '[]'::jsonb),

    'deposit_total', coalesce((
      select sum(sl.deposit_charged) from public.sale_lines sl where sl.sale_id = s.id
    ), 0),

    /*
     * STILL WITH YOU — what THIS receipt sent out, in the shape it went out in.
     *
     * «the reader "still with you" uses what was bought by the customer — if it is 0.5 goldberg,
     *  3 gulder, 10 big turbo, it uses that data»
     *
     * Read from the container rows the sale itself wrote (`ref_table = 'sale_lines'`), netted
     * against anything written back against the same lines — which is exactly what a correction
     * does — so an amended receipt prints what it says NOW. One row per product shape, with its
     * maker, so the screen can apply the counter's rule: whole ones add across a maker, parts stay
     * with their beer. That rule lives in `rollUpOwed`, once, rather than in SQL twice.
     *
     * This used to read `deposit_ledger` pools on the shared link and nothing at all on the till's
     * copy, so a new sale printed no containers on either.
     */
    -- As at this sale: what they held before plus what it sent out (0149).
    'empties', case when sc.id is null then '[]'::jsonb
                    else public.customer_containers_as_at(sc.id, public.receipt_moment(s.id)) end,
    'account', case when sc.id is null then null
                    else jsonb_build_object(
                           'owed_after', public.customer_owed_as_at(sc.id, public.receipt_moment(s.id))) end,
    'empties_this_sale', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', t.product_id,
               'product_name', t.product_name,
               'product_unit_id', t.product_unit_id,
               'unit_name', t.unit_name,
               'unit_plural', t.unit_plural,
               'base_qty', t.base_qty,
               'group_id', t.group_id,
               'group_name', t.group_name,
               'owed', t.owed
             ) order by t.group_name nulls last, t.product_name)
        from (
          select ce.product_id,
                 pr.name  as product_name,
                 ce.product_unit_id,
                 su.name  as unit_name,
                 su.plural as unit_plural,
                 pu.base_qty,
                 g.group_id,
                 g.group_name,
                 sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) as owed
            /*
             * THIS SALE'S CONTAINER ROWS, from either place they can be.
             *
             * Written by the sale itself (`sale_lines`, since 0117), or carried over from the old deposit
             * ledger (0110), where the deposit row points at the sale. 62 older receipts have theirs only
             * in the second place and printed nothing although the ledger was right.
             */
            from (
              select c.* from public.customer_empties c
                join public.sale_lines sl on c.ref_table = 'sale_lines' and sl.id = c.ref_id
               where sl.sale_id = s.id
              union all
              select c.* from public.customer_empties c
                join public.deposit_ledger dl on c.ref_table = 'deposit_ledger' and dl.id = c.ref_id
               where dl.ref_table = 'sales' and dl.ref_id = s.id
            ) ce
            join public.products pr on pr.id = ce.product_id
            join public.product_units pu on pu.id = ce.product_unit_id
            join public.store_units su on su.id = pu.store_unit_id
            left join lateral (
              select c.id as group_id, c.name as group_name
                from public.product_category_links l
                join public.product_categories c on c.id = l.category_id
               where l.product_id = pr.id and coalesce(c.status, 'active') = 'active'
               order by c.name
               limit 1
            ) g on true
           where true
             and coalesce(ce.side, 'they_hold') = 'they_hold'
             /*
              * AND NOT TAKEN BACK BY A VOID. `unowe_voided_sale` (0117) writes its reversal under
              * `ref_table = 'sale_void'` pointing at the OUT row, not at the line — so without this a
              * cancelled receipt would still list the crates as with the customer.
              */
             and not exists (
               select 1 from public.customer_empties v
                where v.ref_table = 'sale_void' and v.ref_id = ce.id
             )
           group by ce.product_id, pr.name, ce.product_unit_id, su.name, su.plural,
                    pu.base_qty, g.group_id, g.group_name
          having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0
        ) t
    ), '[]'::jsonb),

    'payments', coalesce((
      select jsonb_agg(x)
        from (
          select jsonb_build_object('method', pay.method, 'amount', sum(pa.amount)) as x
            from public.payment_allocations pa
            join public.payments pay on pay.id = pa.payment_id
           where pa.sale_id = s.id
             -- Paid as at this version (0240), as the account below is.
             and pay.occurred_at <= public.receipt_moment(s.id)
           group by pay.method
           order by pay.method
        ) grouped
    ), '[]'::jsonb),

    'paid_total', coalesce((
      select sum(pa.amount) from public.payment_allocations pa
        join public.payments pay on pay.id = pa.payment_id
       where pa.sale_id = s.id and pay.occurred_at <= public.receipt_moment(s.id)
    ), 0)
  )
  into v_out
  from public.sales s
  join public.stores st on st.id = s.store_id
  left join public.store_settings ss on ss.store_id = s.store_id
  left join public.store_customers sc on sc.id = s.store_customer_id
  where s.id = v_link.ref_id;

  update public.share_links
     set view_count = view_count + 1, last_seen_at = now()
   where id = v_link.id;

  return v_out;
end;
$function$;

notify pgrst, 'reload schema';
