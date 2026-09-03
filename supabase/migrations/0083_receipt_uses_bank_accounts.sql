-- 0083 — A receipt prints an account the shop actually banks into
--
-- «the receipt uses a stale account details that is in setting-page, but the design was to use the
--  list of banks we add»
--
-- Two places held bank details and only one of them was real. `store_bank_accounts` is the shop's list —
-- added, edited, marked default, and already what the payment screen picks from when somebody pays
-- by transfer. `store_settings.transfer_bank_name / _account_no / _account_name` were three text
-- boxes typed once on the settings screen, checked against nothing, and printed on every receipt.
--
-- A shop that closed an account, or opened a better one, had receipts still asking customers to pay
-- into the old one — and no reason to think anything was wrong, because the boxes still had text in
-- them.
--
-- One list now. The settings screen chooses WHICH account prints; it does not hold a second copy of
-- the numbers.

alter table public.store_settings
  add column if not exists receipt_bank_account_id uuid
    references public.store_bank_accounts (id) on delete set null;

comment on column public.store_settings.receipt_bank_account_id is
  'Which of the shop''s accounts prints on receipts. Null means the one marked default — a shop '
  'with one account should not have to choose it twice. ON DELETE SET NULL rather than restrict: '
  'closing an account is an ordinary thing to do, and it should fall back rather than refuse.';

-- ─── Carry across whatever the boxes said ───────────────────────────────────────────
--
-- Matched on the account NUMBER, which is the field a person would use to tell two accounts apart.
-- A shop whose typed details match an account it holds keeps printing the same thing; one whose
-- details match nothing gets the default account, which is the closest true answer available.

update public.store_settings ss
   set receipt_bank_account_id = ba.id
  from public.store_bank_accounts ba
 where ba.store_id = ss.store_id
   and ss.receipt_bank_account_id is null
   and nullif(btrim(ss.transfer_account_no), '') is not null
   and regexp_replace(ba.account_number, '\\D', '', 'g')
     = regexp_replace(ss.transfer_account_no, '\\D', '', 'g');

-- The three columns are LEFT IN PLACE, not dropped. Sales already settled carry their own snapshot
-- and do not read them, but a column dropped is a column no longer recoverable if some report or
-- export is found to have been reading it. Dead, and marked so.
comment on column public.store_settings.transfer_bank_name is
  'DEAD as of 0083 — the receipt reads store_bank_accounts through receipt_bank_account_id. Left for '
  'recovery, not read by anything.';

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
$function$;
