-- 0249 - A correction is written in one: what comes off, what is added, and why
--
-- "Correct payment is just like Take payment — no block, because the reason is already done after
-- the correct payment. It loads back those same lines so they can cancel them, and even add." A
-- payment taken off, or the deposit cancelled, on Correct payment is no longer written there with a
-- reason of its own; it waits on the correction and is written WITH it, under its one reason:
--
--   correct_sale(... amend_sale's arguments ..., p_take_back uuid[], p_cancel_deposit boolean)
--
-- takes back each named payment (`void_payment`), cancels the deposit put down with the sale
-- (`cancel_sale_deposit`), then corrects the receipt (`amend_sale`) — in one transaction, so a
-- correction that fails leaves every one of them as it was.

create or replace function public.correct_sale(
  p_sale_id uuid,
  p_reason text,
  p_lines jsonb default null,
  p_customer_id uuid default null,
  p_charges jsonb default null,
  p_payments jsonb default null,
  p_deposit money_amt default null,
  p_deposit_reason text default null,
  p_take_back uuid[] default null,
  p_cancel_deposit boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_sale public.sales;
  v_id   uuid;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    raise exception 'that sale does not exist' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_sale.store_id, 'sales.amend') then
    raise exception 'you do not have permission to correct a sale' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'say why this receipt is being corrected' using errcode = '22023';
  end if;

  -- Only money that paid THIS receipt can be taken back through its correction.
  foreach v_id in array coalesce(p_take_back, '{}'::uuid[])
  loop
    if not exists (select 1 from public.payment_allocations a
                    where a.payment_id = v_id and a.sale_id = p_sale_id) then
      raise exception 'that payment is not on this receipt' using errcode = '22023';
    end if;
    perform public.void_payment(v_id, 'Taken back in a correction: ' || btrim(p_reason));
  end loop;

  if coalesce(p_cancel_deposit, false) then
    perform public.cancel_sale_deposit(p_sale_id, btrim(p_reason));
  end if;

  return public.amend_sale(p_sale_id, p_reason, p_lines, p_customer_id, p_charges, p_payments,
                           p_deposit, p_deposit_reason);
end;
$function$;

revoke all on function public.correct_sale(uuid, text, jsonb, uuid, jsonb, jsonb, money_amt, text, uuid[], boolean) from public, anon;
grant execute on function public.correct_sale(uuid, text, jsonb, uuid, jsonb, jsonb, money_amt, text, uuid[], boolean) to authenticated;

notify pgrst, 'reload schema';
