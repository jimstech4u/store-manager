-- 0097 — A deposit belongs to the shop that took it
--
-- Found by the benchmark's two-shop scenario: it took a deposit in the second shop against the
-- FIRST shop's pool, and was allowed to.
--
-- All four deposit writers check that the caller has `deposits.manage` in the store they named, and
-- then trust the customer id and the category id they were handed. Neither is checked against that
-- store. A member of one shop can write rows into another shop's deposit ledger, against another
-- shop's customer, into another shop's pool — and every READ is protected by `is_store_member`, so
-- the shop being written to cannot see how the rows got there.
--
-- `take_deposit` is the instructive one. It does look the pool up by `(id, store_id)` — but only to
-- find a default rate, inside a coalesce:
--
--     v_per := coalesce(p_per_unit, (select deposit from empties_categories
--                                     where id = p_category_id and store_id = p_store_id));
--
-- Supply `p_per_unit` and the subquery never runs, so the check never happens. A guard that only
-- fires when an optional argument is missing is not a guard. It reads like one, which is why it
-- survived.
--
-- One helper, called first thing in all four, where no argument can skip it.

create or replace function public.assert_deposit_target(
  p_store_id    uuid,
  p_customer_id uuid,
  p_category_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_customer_id is not null and not exists (
    select 1 from public.store_customers sc
     where sc.id = p_customer_id and sc.store_id = p_store_id
  ) then
    raise exception 'that customer is not yours' using errcode = '42501';
  end if;

  if p_category_id is not null and not exists (
    select 1 from public.empties_categories ec
     where ec.id = p_category_id and ec.store_id = p_store_id
  ) then
    raise exception 'that pool is not yours' using errcode = '42501';
  end if;
end;
$fn$;

comment on function public.assert_deposit_target(uuid, uuid, uuid) is
  'Refuses a customer or an empties pool belonging to another shop. Called first thing by every '
  'deposit writer: having permission IN a store says nothing about whether the ids you were handed '
  'belong to it, and all four writers used to trust them.';

revoke all on function public.assert_deposit_target(uuid, uuid, uuid) from public;
grant execute on function public.assert_deposit_target(uuid, uuid, uuid) to authenticated;



CREATE OR REPLACE FUNCTION public.take_deposit(p_store_id uuid, p_customer_id uuid, p_category_id uuid, p_qty qty, p_per_unit money_amt DEFAULT NULL::numeric, p_note text DEFAULT NULL::text, p_occurred_at timestamp with time zone DEFAULT now())
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_per money_amt;
  v_id  uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to take a deposit' using errcode = '42501';
  end if;

  -- WHOSE customer and WHOSE pool. Having permission in a store says nothing about whether the ids
  -- you were handed belong to it.
  perform public.assert_deposit_target(p_store_id, p_customer_id, p_category_id);
  if p_qty is null or p_qty <= 0 then
    raise exception 'how many is the deposit for?' using errcode = '22023';
  end if;

  -- Falls back to the pool's standard deposit, so the counter does not have to remember it, but
  -- an explicit figure always wins — shops do agree one-off amounts.
  v_per := coalesce(p_per_unit, (select deposit from public.empties_categories
                                  where id = p_category_id and store_id = p_store_id));
  if v_per is null then
    raise exception 'that is not a pool this shop uses' using errcode = 'P0002';
  end if;

  insert into public.deposit_ledger
    (store_id, store_customer_id, empties_category_id, direction,
     qty_units, deposit_per_unit, note, occurred_at)
  values (p_store_id, p_customer_id, p_category_id, 'collected',
          p_qty, v_per, nullif(trim(coalesce(p_note, '')), ''), p_occurred_at)
  returning id into v_id;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.refund_deposit(p_store_id uuid, p_customer_id uuid, p_category_id uuid, p_qty qty, p_note text DEFAULT NULL::text, p_occurred_at timestamp with time zone DEFAULT now())
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_held qty;
  v_per  money_amt;
  v_id   uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to give a deposit back' using errcode = '42501';
  end if;

  -- WHOSE customer and WHOSE pool. Having permission in a store says nothing about whether the ids
  -- you were handed belong to it.
  perform public.assert_deposit_target(p_store_id, p_customer_id, p_category_id);
  if p_qty is null or p_qty <= 0 then
    raise exception 'how many is being given back?' using errcode = '22023';
  end if;

  select coalesce(sum(qty_units), 0) into v_held
    from public.deposit_ledger
   where store_customer_id = p_customer_id
     and empties_category_id = p_category_id
     and direction = 'collected';

  if p_qty > v_held then
    raise exception 'only % are on deposit for this customer', v_held using errcode = '22023';
  end if;

  -- Refund at the rate it was taken at, not today's rate. A shop that raises its deposit must not
  -- thereby owe more on money it took last year.
  select deposit_per_unit into v_per
    from public.deposit_ledger
   where store_customer_id = p_customer_id
     and empties_category_id = p_category_id
     and direction = 'collected' and qty_units > 0
   order by occurred_at
   limit 1;

  insert into public.deposit_ledger
    (store_id, store_customer_id, empties_category_id, direction,
     qty_units, deposit_per_unit, note, occurred_at)
  values (p_store_id, p_customer_id, p_category_id, 'collected',
          -p_qty, coalesce(v_per, 0), nullif(trim(coalesce(p_note, '')), ''), p_occurred_at)
  returning id into v_id;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.forfeit_deposit(p_store_id uuid, p_customer_id uuid, p_category_id uuid, p_qty qty, p_amount money_amt, p_note text DEFAULT NULL::text, p_occurred_at timestamp with time zone DEFAULT now())
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_held qty;
  v_per  money_amt;
  v_id   uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to do that' using errcode = '42501';
  end if;

  -- WHOSE customer and WHOSE pool. Having permission in a store says nothing about whether the ids
  -- you were handed belong to it.
  perform public.assert_deposit_target(p_store_id, p_customer_id, p_category_id);
  if p_qty is null or p_qty <= 0 then
    raise exception 'how many were broken or lost?' using errcode = '22023';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'how much is being kept?' using errcode = '22023';
  end if;

  select coalesce(sum(qty_units), 0) into v_held
    from public.deposit_ledger
   where store_customer_id = p_customer_id
     and empties_category_id = p_category_id
     and direction = 'collected';

  if p_qty > v_held then
    raise exception 'only % are on deposit for this customer', v_held using errcode = '22023';
  end if;

  insert into public.deposit_forfeits
    (store_id, store_customer_id, empties_category_id, qty_units, amount, note, occurred_at)
  values (p_store_id, p_customer_id, p_category_id, p_qty, p_amount,
          nullif(trim(coalesce(p_note, '')), ''), p_occurred_at)
  returning id into v_id;

  select deposit_per_unit into v_per
    from public.deposit_ledger
   where store_customer_id = p_customer_id
     and empties_category_id = p_category_id
     and direction = 'collected' and qty_units > 0
   order by occurred_at
   limit 1;

  insert into public.deposit_ledger
    (store_id, store_customer_id, empties_category_id, direction,
     qty_units, deposit_per_unit, ref_table, ref_id, note, occurred_at)
  values (p_store_id, p_customer_id, p_category_id, 'collected',
          -p_qty, coalesce(v_per, 0), 'deposit_forfeits', v_id,
          nullif(trim(coalesce(p_note, '')), ''), p_occurred_at);

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.return_empties(p_store_id uuid, p_customer_id uuid, p_category_id uuid, p_qty qty, p_occurred_at timestamp with time zone DEFAULT now(), p_client_uuid uuid DEFAULT NULL::uuid, p_refund_mode text DEFAULT 'credit'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- WHOSE customer and WHOSE pool. Having permission in a store says nothing about whether the ids
  -- you were handed belong to it.
  perform public.assert_deposit_target(p_store_id, p_customer_id, p_category_id);

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
$function$;


do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('take_deposit', 'refund_deposit', 'forfeit_deposit', 'return_empties',
                          'assert_deposit_target')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a deposit writer has % overloads', n;
    end if;
  end loop;
end;
$check$;
