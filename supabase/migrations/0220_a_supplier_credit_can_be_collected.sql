-- 0220 - A supplier's credit can actually be collected
--
-- "as we have a way to settle the empties, deposit, outstanding customer owe us, also we need a
-- way to settle what we owe, because there is no way to settle that so it is stuck, also with
-- suppliers because account must be completed."
--
-- Right on both counts. The customer side is `record_money_back` (0210). The supplier side had
-- three movements — `paid` (money out), `charge` (something they billed that no delivery carried)
-- and `credit` (a rebate or an overpayment, which they owe back) — and no fourth for COLLECTING
-- that credit. So a supplier who owed the shop money sat owing it permanently, and the account
-- page said as much: "it comes off the next load rather than being handed back". That is one way
-- a rebate is settled. It is not the only one, and when a supplier hands the money over there was
-- nowhere to put it.
--
-- `refunded` is that fourth movement: money arriving from a supplier, which takes the credit back
-- off the account. It counts the way a `charge` does in the balance, because both move the
-- account in the same direction — the difference is that one is a bill and the other is cash, and
-- the ledger keeps them apart by name so a statement still reads.
--
-- Everything else in both functions is the live definition, byte for byte.

alter table public.supplier_payments
  drop constraint if exists supplier_payments_direction_check;

alter table public.supplier_payments
  add constraint supplier_payments_direction_check
  check (direction = any (array['paid'::text, 'charge'::text, 'credit'::text, 'refunded'::text]));

create or replace function public.record_supplier_payment(
  p_store_id uuid,
  p_supplier_id uuid,
  p_amount money_amt,
  p_direction text DEFAULT 'paid'::text,
  p_method text DEFAULT NULL::text,
  p_reason text DEFAULT NULL::text,
  p_purchase_id uuid DEFAULT NULL::uuid,
  p_occurred_at timestamptz DEFAULT now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare v_id uuid;
begin
  if not public.has_permission(p_store_id, 'payments.record') then
    raise exception 'you do not have permission to record this' using errcode = '42501';
  end if;

  -- The supplier must be this shop's. The hole 0097 closed, asked again at a new door.
  if not exists (
    select 1 from public.suppliers where id = p_supplier_id and store_id = p_store_id
  ) then
    raise exception 'that supplier does not belong to this shop' using errcode = '42501';
  end if;

  if p_direction not in ('paid', 'charge', 'credit', 'refunded') then
    raise exception '% is not something that happens on a supplier account', p_direction
      using errcode = '22023';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'that is not an amount' using errcode = '22023';
  end if;

  -- A payment explains itself by its amount and method; anything else needs saying.
  if p_direction <> 'paid' and btrim(coalesce(p_reason, '')) = '' then
    raise exception 'say what it is for' using errcode = '22023';
  end if;

  insert into public.supplier_payments (store_id, supplier_id, direction, amount, method, reason,
                                        purchase_id, occurred_at)
  values (p_store_id, p_supplier_id, p_direction, p_amount,
          nullif(btrim(coalesce(p_method, '')), ''),
          nullif(btrim(coalesce(p_reason, '')), ''),
          p_purchase_id, coalesce(p_occurred_at, now()))
  returning id into v_id;

  return v_id;
end;
$function$;

create or replace function public.supplier_balance(p_supplier_id uuid)
returns money_amt
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select (
    /*
     * WHAT THE INVOICE CAME TO, summed from the lines.
     *
     * `purchases` has no total: it carries the fees and the rebate, and the goods live on
     * `purchase_lines`. The RAW cost is used, not the landed one — landed cost spreads haulage and
     * levies across the goods so a shelf figure is honest, and none of that is money owed to the
     * SUPPLIER. The rebate is theirs to give and comes off.
     */
    coalesce((
      select sum(
               (select coalesce(sum(pl.entered_qty * pl.unit_cost_raw), 0)
                  from public.purchase_lines pl where pl.purchase_id = pu.id)
               - coalesce(pu.rebate_amount, 0)
             )
        from public.purchases pu
       where pu.supplier_id = p_supplier_id
         and coalesce(pu.status, 'posted') <> 'voided'
    ), 0)
    + coalesce((
      /*
       * `refunded` counts the way a charge does (0220).
       *
       * A credit is the supplier saying "we owe you this". Collecting it is money arriving, and
       * it must take the credit back off the account or the shop would be owed it for ever. So
       * the two cancel, and what is left is what the account really is.
       */
      select sum(case when sp.direction in ('charge', 'refunded') then sp.amount
                      when sp.direction = 'credit' then -sp.amount
                      else -sp.amount end)
        from public.supplier_payments sp
       where sp.supplier_id = p_supplier_id
    ), 0)
  )::money_amt
  from public.suppliers s
 where s.id = p_supplier_id
   and public.is_store_member(s.store_id);
$function$;

grant execute on function public.record_supplier_payment(uuid, uuid, money_amt, text, text, text,
                                                         uuid, timestamptz) to authenticated;
grant execute on function public.supplier_balance(uuid) to authenticated;

notify pgrst, 'reload schema';
