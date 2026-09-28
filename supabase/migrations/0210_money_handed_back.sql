-- 0210 - Money handed back to a customer is money handed back
--
-- "The 250 it shows i owe that is wrong because that was change and it should just be on receipt
-- but not a money i owe them, and we need a way to reconcile money i owe them as well after i
-- have given back."
--
-- Samod's bill was N9,750 and he handed over N10,000. The till worked out N250 change and the
-- seller gave it to him. What the books hold is a N10,000 payment against a N9,750 sale, so
-- `customer_balance` — billed less paid — reads minus N250 and the shop is told it owes him
-- money it handed across the counter.
--
-- NOTHING HERE WAS CARELESS. `settle_sale` caps the ALLOCATION at what the sale still owes (0188)
-- and deliberately leaves the payment at its true tendered figure, with the note: "the till said
-- N8,000 was tendered and that is not this function's to edit". That is right for a customer who
-- genuinely pays over to sit in credit. It is wrong for the far commoner case where the surplus
-- was counted back out of the drawer a second later — and the software had no way to say which,
-- because there was no way to record money LEAVING for a customer at all.
--
-- `payments.direction` has had 'out' since the table was written, and `customer_balance` already
-- nets it: `case when direction = 'in' then amount else -amount end`. Nothing ever wrote one.
--
-- So: one function, for both halves of the shop's question. The till uses it for change, so a
-- surplus never becomes a debt in the first place; the account screen uses it to settle a credit
-- that is already there. Both are the same event — the shop's money going to a customer.

create or replace function public.record_money_back(
  p_store_id uuid,
  p_customer_id uuid,
  p_amount money_amt,
  p_method text DEFAULT 'cash',
  p_reason text DEFAULT NULL,
  p_occurred_at timestamptz DEFAULT now(),
  p_client_uuid uuid DEFAULT NULL,
  p_bank_account_id uuid DEFAULT NULL
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.has_permission(p_store_id, 'payments.record') then
    raise exception 'You do not have permission to record a payment'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.store_customers
     where id = p_customer_id and store_id = p_store_id
  ) then
    raise exception 'That customer does not belong to this shop' using errcode = '42501';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Say how much' using errcode = '22023';
  end if;

  if p_method not in ('cash', 'transfer', 'pos', 'other') then
    raise exception '% is not a way to pay', p_method using errcode = '22023';
  end if;

  /*
   * NOT ALLOCATED TO ANY RECEIPT.
   *
   * `payment_allocations` says which receipt a payment SETTLES, and money going the other way
   * settles nothing — it is the shop clearing what it holds for somebody. `customer_balance` nets
   * it by direction, which is where it belongs and is why nothing else has to learn about it.
   */
  insert into public.payments (store_id, store_customer_id, amount, method, reference,
                               occurred_at, client_uuid, bank_account_id, direction)
  values (p_store_id, p_customer_id, p_amount, p_method,
          nullif(btrim(coalesce(p_reason, '')), ''),
          coalesce(p_occurred_at, now()), p_client_uuid, p_bank_account_id, 'out')
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.record_money_back(uuid, uuid, money_amt, text, text,
                                                   timestamptz, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
