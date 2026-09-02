-- ════════════════════════════════════════════════════════════════════════════════════════════
-- A walk-in's cash was collected and the books said it was not
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- `settle_sale` records a payment for a customer through `record_payment`, which allocates it
-- against what they owe. For a WALK-IN it took a shortcut: insert the payment row and stop. The
-- comment beside it said the money was "recorded against the sale directly", and it was not —
-- `payments` has no `sale_id`, so nothing linked the two.
--
-- Everything downstream reads what a sale was paid from `payment_allocations`. So every cash sale
-- to somebody not on file came back as PAID 0, OUTSTANDING THE FULL AMOUNT: on the receipt, in the
-- sales list, in the day's takings. Measured before this migration on the live shop — eighteen
-- walk-in sales, eighteen with no payment linked, ₦109,450 collected and shown as owing.
--
-- The fix is one insert: allocate the walk-in's payment to the sale it was for. Everything else
-- here is byte-for-byte the definition from 0040 — copied verbatim and edited in one place,
-- because 0058 rewrote a function of this shape "more tidily", changed the parameter order,
-- created a second overload, and the till stopped saving until 0060 restored it by copying
-- exactly.
--
-- REPAIRING THE EIGHTEEN IS A SEPARATE STEP, deliberately. This migration changes behaviour from
-- now on; rewriting historical money records is a decision for the shop, and
-- `scripts/link-walkin-payments.mjs` does it on request, dry-run by default.

CREATE OR REPLACE FUNCTION public.settle_sale(p_store_id uuid, p_lines jsonb, p_payments jsonb DEFAULT '[]'::jsonb, p_customer_id uuid DEFAULT NULL::uuid, p_fee_amount money_amt DEFAULT 0, p_fee_label text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_occurred_at timestamp with time zone DEFAULT now(), p_client_uuid uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
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

  select * into v_settings from public.store_settings where store_id = p_store_id;
  if found and v_settings.show_transfer_details then
    v_transfer := concat_ws(E'\n',
      nullif(v_settings.transfer_bank_name, ''),
      nullif(v_settings.transfer_account_no, ''),
      nullif(v_settings.transfer_account_name, ''));
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

      insert into public.payment_allocations (payment_id, sale_id, amount)
      values (v_payment_id, v_sale_id, v_amount);
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
$function$
;
