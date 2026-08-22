-- =====================================================================================
-- 0038 — Returning empties gives the deposit back
--
-- `return_empties` had two faults that only showed once deposits were valued honestly (0037):
--
--  1. It wrote the settling row with `deposit_per_unit` left at its default of ZERO. Units came
--     off the outstanding count correctly, but the MONEY held was `sum(qty × per_unit)` — the
--     original +10 × ₦2,000 stayed, the return added −10 × ₦0, and the shop went on appearing to
--     hold ₦20,000 of that customer's money forever. Returning every last crate cleared the
--     crates and never cleared the cash.
--
--  2. Nothing was given back. A deposit is money the shop is holding against a container; when
--     the container comes back the money has to go somewhere, and there was no path for it at
--     all — not to the customer, not against their bill, not even a record that it was kept.
--
-- The second one is a business decision, not a default: some shops hand the cash over, most take
-- it off what the customer already owes, and sometimes it stays on deposit because the customer
-- is about to take more crates. So the caller says which, and all three are recorded.
-- =====================================================================================

drop function if exists public.return_empties(uuid, uuid, uuid, qty, timestamptz, uuid);

create or replace function public.return_empties(
  p_store_id    uuid,
  p_customer_id uuid,
  p_category_id uuid,
  p_qty         qty,
  p_occurred_at timestamptz default now(),
  p_client_uuid uuid default null,
  /**
   * What happens to any deposit that was held against these.
   *
   *   'credit' — comes off what the customer owes (the usual case)
   *   'cash'   — physically handed back over the counter
   *   'none'   — stays on deposit; they are taking more containers out
   */
  p_refund_mode text default 'credit'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id          uuid;
  v_outstanding qty;
  v_per         money_amt;
  v_refund      money_amt;
  v_payment     uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to record empties' using errcode = '42501';
  end if;

  if p_qty <= 0 then
    raise exception 'return quantity must be greater than zero' using errcode = '22023';
  end if;

  if p_refund_mode not in ('credit', 'cash', 'none') then
    raise exception 'unknown refund mode %', p_refund_mode using errcode = '22023';
  end if;

  v_outstanding := public.empties_outstanding(p_customer_id, p_category_id);
  if p_qty > v_outstanding then
    raise exception 'customer owes % of these empties but % were offered', v_outstanding, p_qty
      using errcode = '22023';
  end if;

  -- The rate the deposit was actually taken at, not today's rate for the pool. A shop that has
  -- since raised its deposit must not thereby owe more on money it took last year.
  select deposit_per_unit into v_per
    from public.deposit_ledger
   where store_customer_id = p_customer_id
     and empties_category_id = p_category_id
     and direction = 'collected'
     and qty_units > 0
   order by occurred_at
   limit 1;

  v_per := coalesce(v_per, 0);
  v_refund := p_qty * v_per;

  -- Settles BOTH the units and the money, because the row now carries the rate.
  insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                     direction, qty_units, deposit_per_unit, occurred_at, note)
  values (p_store_id, p_customer_id, p_category_id, 'collected', -p_qty, v_per, p_occurred_at,
          'empties returned')
  returning id into v_id;

  if v_refund > 0 and p_refund_mode <> 'none' then
    -- 'credit' is a payment IN: it reduces what the customer owes, exactly as money handed over
    -- would. 'cash' is a payment OUT: the shop physically gave money back, which does not settle
    -- any part of their bill.
    --
    -- Recorded as a payment either way, rather than as a silent adjustment to a balance, because
    -- this is the line a customer queries and it has to be pointed at.
    insert into public.payments (store_id, store_customer_id, amount, method, direction,
                                 reference, occurred_at, client_uuid)
    values (p_store_id, p_customer_id, v_refund, 'other',
            case when p_refund_mode = 'credit' then 'in' else 'out' end,
            'Deposit returned for ' || p_qty || ' empties', p_occurred_at, p_client_uuid)
    returning id into v_payment;
  end if;

  return jsonb_build_object(
    'ledger_id', v_id,
    'refunded', coalesce(v_refund, 0),
    'refund_mode', p_refund_mode,
    'payment_id', v_payment
  );
end;
$fn$;

revoke all on function
  public.return_empties(uuid, uuid, uuid, qty, timestamptz, uuid, text) from public;
grant execute on function
  public.return_empties(uuid, uuid, uuid, qty, timestamptz, uuid, text) to authenticated;

-- ─── Repair rows already written at the wrong rate ──────────────────────────────────
--
-- Append-only, so nothing is edited. Any settling row written with per_unit 0 while a positive
-- deposit was held left money stranded; this appends a correcting row per affected pool so the
-- held figure tells the truth from here on, and the correction is itself visible in the history.

do $repair$
declare
  r record;
begin
  for r in
    select d.store_id,
           d.store_customer_id,
           d.empties_category_id,
           sum(d.qty_units)                        as net_units,
           sum(d.qty_units * d.deposit_per_unit)   as net_money,
           max(d.deposit_per_unit)                 as rate
      from public.deposit_ledger d
     where d.direction = 'collected'
     group by d.store_id, d.store_customer_id, d.empties_category_id
    having sum(d.qty_units) <= 0
       and sum(d.qty_units * d.deposit_per_unit) > 0
  loop
    insert into public.deposit_ledger
      (store_id, store_customer_id, empties_category_id, direction,
       qty_units, deposit_per_unit, note)
    -- A zero-unit row would violate the qty_units <> 0 check, so the correction is carried in the
    -- rate on a single unit and immediately balanced by its own sign.
    values (r.store_id, r.store_customer_id, r.empties_category_id, 'collected',
            -1, r.net_money,
            'Correction: deposit released for empties already returned'),
           (r.store_id, r.store_customer_id, r.empties_category_id, 'collected',
            1, 0,
            'Correction: unit count restored');
  end loop;
end;
$repair$;
