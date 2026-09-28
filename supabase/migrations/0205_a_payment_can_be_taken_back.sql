-- 0205 - A payment recorded the wrong way can be taken back
--
-- From the counter, and it cost them real money on a live book:
--
--   "i corrected a receipt that paid cash 1600 but it was transfer so no way to remove the cash
--    and put the 1600 transfer so it made it a payment of 3200"
--
-- Receipt a19ac533 is N1,600. Against it sit N1,600 cash at 16:27 and N1,600 transfer at 16:33,
-- both allocated. The customer's account says billed N1,600, paid N3,200 - so the shop appears to
-- owe Destiny N1,600 it never took.
--
-- NOTHING WAS BROKEN. `amend_sale`'s payment block does exactly what its own comment says it does:
--
--     MONEY HANDED OVER WHILE THE RECEIPT WAS BEING CORRECTED
--     A correction routinely finds more owing ... and the customer pays the difference there and
--     then.
--
-- That is a real case and it is right to add. The gap is that it is the ONLY thing the software
-- could do with a payment during a correction. There was no way to say "that cash never came" -
-- no void, no reversal, nothing - so a seller correcting the METHOD had one move available, and it
-- was the wrong one. The shop did the only thing the screen allowed.
--
-- ── HOW IT IS TAKEN BACK ────────────────────────────────────────────────────────
--
-- Not deleted. A payment is a statement about money, and the statement was made; what is added is
-- the later statement that it was wrong. So a reversing row goes in with the opposite direction and
-- the same amount, method and bank account, carrying the reason.
--
-- THIS MAKES THE CASH BOOK RIGHT, WHICH A "VOIDED" FLAG WOULD NOT. `customer_balance` already sums
-- `case when direction = 'in' then amount else -amount end`, and every takings report reads the
-- same rows. N1,600 cash in and N1,600 cash out is a till that took nothing in cash - which is what
-- happened - while the transfer stands on its own. A flag would have required every reader in the
-- app to learn about it, and the one that forgot would be the one somebody trusted.
--
-- AND IT STOPS SETTLING THE RECEIPT. `payment_allocations.amount` must be positive, so a reversal
-- cannot be netted off there; the allocation of the payment being taken back is removed instead.
-- An allocation is not a record of money - it is the link saying which receipt this money settles -
-- and after a reversal it settles nothing. The two payment rows stay, and say what happened.

-- ── Which payment a reversal undoes ─────────────────────────────────────────────
--
-- So a statement can print them as a pair rather than as two unexplained opposite entries, and so
-- the same payment cannot be taken back twice - which would turn one mistake into a refund.
alter table public.payments
  add column if not exists reverses_payment_id uuid references public.payments(id);

create index if not exists payments_reverses_idx
  on public.payments (reverses_payment_id) where reverses_payment_id is not null;

create or replace function public.void_payment(p_payment_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pay record;
  v_id  uuid;
begin
  select * into v_pay from public.payments where id = p_payment_id;
  if not found then
    raise exception 'That payment is not there' using errcode = '23503';
  end if;

  if not public.has_permission(v_pay.store_id, 'payments.record') then
    raise exception 'You do not have permission to take back a payment'
      using errcode = '42501';
  end if;

  -- A reason, because this is the only record of WHY the books changed, and "corrected" with no
  -- sentence beside it is what makes a statement unreadable six weeks later.
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why this payment is being taken back' using errcode = '22023';
  end if;

  if v_pay.reverses_payment_id is not null then
    raise exception 'That entry is itself a correction, so there is nothing to take back'
      using errcode = '22023';
  end if;

  if exists (select 1 from public.payments r where r.reverses_payment_id = p_payment_id) then
    raise exception 'That payment has already been taken back' using errcode = '22023';
  end if;

  insert into public.payments (store_id, store_customer_id, amount, method, reference,
                               bank_account_id, occurred_at, direction, amend_reason,
                               reverses_payment_id)
  values (v_pay.store_id, v_pay.store_customer_id, v_pay.amount, v_pay.method, v_pay.reference,
          v_pay.bank_account_id, now(),
          -- The opposite of whatever it was. Money that came in goes back out of the book.
          case when v_pay.direction = 'in' then 'out' else 'in' end,
          btrim(p_reason), p_payment_id)
  returning id into v_id;

  -- And it settles nothing now. See the note at the head of this migration.
  delete from public.payment_allocations where payment_id = p_payment_id;

  return v_id;
end;
$$;

grant execute on function public.void_payment(uuid, text) to authenticated;

notify pgrst, 'reload schema';
