-- 0188 — A walk-in's overpayment is change, not a payment for something
--
-- `settle_sale` allocated the WHOLE payment to the sale for a walk-in customer. Somebody handing
-- over N8,000 for a N7,600 bill had all N8,000 recorded against it, so the sale read as overpaid
-- by exactly the N400 the seller had just counted back into their hand.
--
-- The same defect 0185 fixed in `record_payment`, in the other path into a sale — found the same
-- way, by `scripts/reconcile-audit.py` re-deriving every sale's allocations and noticing one that
-- had been settled minutes earlier.
--
-- Only the ALLOCATION is capped. The payment row keeps the amount the till said was tendered;
-- editing that would be this function deciding the seller miscounted. What the cap buys is that
-- "Left on this sale" is right, and a surplus stays visibly unattached instead of claiming to
-- have paid for something.
--
-- Worth a separate look, and NOT changed here: whether the till should send what was TENDERED or
-- what was TAKEN. An N8,000 payment row against an N7,600 sale overstates the day's takings by
-- the change, and that is a question about the counter, not about this function.

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
      perform public.record_payment(
        p_store_id, p_customer_id, v_amount,
        coalesce(v_pay ->> 'method', 'cash'),
        nullif(v_pay ->> 'reference', ''),
        p_occurred_at,
        null
      );
    end if;
  end loop;

  return v_sale_id;
end;
$function$;

-- ─── And the one sale that was settled that way ─────────────────────────────────────

update public.payment_allocations pa
   set amount = s.total
  from public.sales s
 where s.id = pa.sale_id
   and s.status = 'posted'
   and pa.amount > s.total
   and 1 = (select count(*) from public.payment_allocations x where x.sale_id = s.id);
