-- =====================================================================================
-- 0036 — A customer's whole position, and how it got that way
--
-- `customer_account` already answers "where does this customer stand" — money owed, named
-- charges, empties out per pool. Two things were missing, and both are the difference between a
-- number and an account:
--
--  1. DEPOSITS HELD. When a customer leaves money instead of empties, the shop is holding cash it
--     will have to give back. That is a liability, it belongs on the customer's page next to what
--     they owe, and it was invisible — the ledger recorded it and nothing read it.
--
--  2. HISTORY. A balance with no events behind it cannot be argued with, and every one of these
--     numbers eventually gets argued with, across a counter, months later. `customer_history`
--     puts every sale, payment, empty returned, deposit taken and breakage forfeited on one
--     timeline with a timestamp and the person who recorded it.
--
-- Plus the write path for deposits, which had none: money could be charged as a deposit during a
-- sale, and there was no way to take one afterwards, give one back, or keep part of one because
-- the crate came back broken.
-- =====================================================================================

-- ─── Deposits held ──────────────────────────────────────────────────────────────────

/**
 * What the shop is holding for this customer, per pool.
 *
 * `qty` is the number of units the deposit covers, `amount` the money. Both are needed: a refund
 * is per unit returned, so the money alone cannot say what a partial return is worth.
 */
create or replace function public.customer_deposits_held(p_store_customer_id uuid)
returns table (
  category_id   uuid,
  category_name text,
  qty_units     qty,
  amount        money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select d.empties_category_id,
         ec.name,
         sum(d.qty_units)::qty,
         sum(d.qty_units * d.deposit_per_unit)::money_amt
    from public.deposit_ledger d
    join public.empties_categories ec on ec.id = d.empties_category_id
    join public.store_customers sc on sc.id = d.store_customer_id
   where d.store_customer_id = p_store_customer_id
     and d.direction = 'collected'
     and public.is_store_member(sc.store_id)
   group by d.empties_category_id, ec.name
  -- Netting to zero means it was taken and fully given back. That is closed, not outstanding.
  having sum(d.qty_units) <> 0 or sum(d.qty_units * d.deposit_per_unit) <> 0
   order by ec.name;
$fn$;

-- ─── One timeline ───────────────────────────────────────────────────────────────────

/**
 * Every event on this customer's account, newest first.
 *
 * A union rather than one events table, because the events genuinely live in different ledgers
 * and each of those is append-only and authoritative for its own kind. Copying them into a
 * shared log would create a second version of the truth that can drift from the first.
 *
 * `kind` says which obligation moved, so the UI can group the timeline under the same headings
 * the balances use — money, this pool of empties, that deposit — rather than presenting one
 * undifferentiated list of "activity".
 */
create or replace function public.customer_history(
  p_store_customer_id uuid,
  p_limit int default 100
)
returns table (
  occurred_at timestamptz,
  kind        text,
  label       text,
  detail      text,
  amount      money_amt,
  qty_units   qty,
  category_id uuid,
  ref_table   text,
  ref_id      uuid,
  actor       text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with allowed as (
    select sc.id, sc.store_id
      from public.store_customers sc
     where sc.id = p_store_customer_id
       and public.is_store_member(sc.store_id)
  ),
  events as (
    -- Goods sold
    select s.occurred_at,
           'sale'::text as kind,
           'Sale'::text as label,
           coalesce(s.note, '')::text as detail,
           s.total as amount,
           null::qty as qty_units,
           null::uuid as category_id,
           'sales'::text as ref_table,
           s.id as ref_id,
           s.created_by as actor_id
      from public.sales s join allowed a on a.id = s.store_customer_id
     where s.status = 'posted'

    union all

    -- Money in and out
    select p.occurred_at,
           case when p.direction = 'in' then 'payment' else 'refund' end,
           case when p.direction = 'in' then 'Payment received' else 'Money refunded' end,
           coalesce(p.method || coalesce(' · ' || p.reference, ''), '')::text,
           case when p.direction = 'in' then p.amount else -p.amount end,
           null::qty, null::uuid, 'payments'::text, p.id, p.created_by
      from public.payments p join allowed a on a.id = p.store_customer_id

    union all

    -- Empties and deposits. A positive qty created the obligation, a negative one settled it.
    select d.occurred_at,
           case when d.qty_units > 0 then 'deposit_taken' else 'deposit_returned' end,
           case when d.qty_units > 0 then 'Deposit taken' else 'Deposit given back' end,
           ec.name::text,
           (d.qty_units * d.deposit_per_unit)::money_amt,
           d.qty_units,
           d.empties_category_id,
           coalesce(d.ref_table, 'deposit_ledger')::text,
           coalesce(d.ref_id, d.id),
           d.created_by
      from public.deposit_ledger d
      join public.empties_categories ec on ec.id = d.empties_category_id
      join allowed a on a.id = d.store_customer_id
     where d.direction = 'collected'

    union all

    -- Breakages and never-returned empties: money the shop keeps, recorded as its own event
    -- because it is income and because it is the line a customer disputes.
    select f.occurred_at,
           'forfeit'::text,
           'Kept for breakage or loss'::text,
           coalesce(f.note, ec.name)::text,
           f.amount,
           f.qty_units,
           f.empties_category_id,
           'deposit_forfeits'::text,
           f.id,
           f.created_by
      from public.deposit_forfeits f
      join public.empties_categories ec on ec.id = f.empties_category_id
      join allowed a on a.id = f.store_customer_id
  )
  select e.occurred_at, e.kind, e.label, e.detail, e.amount, e.qty_units,
         e.category_id, e.ref_table, e.ref_id,
         coalesce(u.email::text, 'the shop')
    from events e
    left join auth.users u on u.id = e.actor_id
   order by e.occurred_at desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
$fn$;

-- ─── Writing deposits ───────────────────────────────────────────────────────────────

/**
 * Take money instead of empties.
 *
 * The everyday case this exists for: a customer leaves with three crates and does not want to
 * come back with them, so they pay the deposit and the crates are theirs until they do. The shop
 * is then holding cash against a specific pool, not just "some money".
 */
create or replace function public.take_deposit(
  p_store_id    uuid,
  p_customer_id uuid,
  p_category_id uuid,
  p_qty         qty,
  p_per_unit    money_amt default null,
  p_note        text default null,
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_per money_amt;
  v_id  uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to take a deposit' using errcode = '42501';
  end if;
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
$fn$;

/** Give a deposit back, in whole or in part. Appends a negative row; nothing is edited. */
create or replace function public.refund_deposit(
  p_store_id    uuid,
  p_customer_id uuid,
  p_category_id uuid,
  p_qty         qty,
  p_note        text default null,
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_held qty;
  v_per  money_amt;
  v_id   uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to give a deposit back' using errcode = '42501';
  end if;
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
$fn$;

/**
 * Keep part of a deposit: the crate came back broken, or never came back at all.
 *
 * Two rows, deliberately. The forfeit records the money kept and WHY, and a matching negative
 * deposit row closes out the units so they stop showing as still on deposit. Recording only the
 * forfeit would leave the customer looking like they still had crates out; recording only the
 * deposit row would make the money vanish with nothing to point at during a dispute.
 */
create or replace function public.forfeit_deposit(
  p_store_id    uuid,
  p_customer_id uuid,
  p_category_id uuid,
  p_qty         qty,
  p_amount      money_amt,
  p_note        text default null,
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_held qty;
  v_per  money_amt;
  v_id   uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to do that' using errcode = '42501';
  end if;
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
$fn$;

-- ─── Grants ─────────────────────────────────────────────────────────────────────────

revoke all on function public.customer_deposits_held(uuid)                                  from public;
revoke all on function public.customer_history(uuid, int)                                   from public;
revoke all on function public.take_deposit(uuid, uuid, uuid, qty, money_amt, text, timestamptz)   from public;
revoke all on function public.refund_deposit(uuid, uuid, uuid, qty, text, timestamptz)           from public;
revoke all on function public.forfeit_deposit(uuid, uuid, uuid, qty, money_amt, text, timestamptz) from public;

grant execute on function public.customer_deposits_held(uuid)                               to authenticated;
grant execute on function public.customer_history(uuid, int)                                to authenticated;
grant execute on function public.take_deposit(uuid, uuid, uuid, qty, money_amt, text, timestamptz)    to authenticated;
grant execute on function public.refund_deposit(uuid, uuid, uuid, qty, text, timestamptz)             to authenticated;
grant execute on function public.forfeit_deposit(uuid, uuid, uuid, qty, money_amt, text, timestamptz) to authenticated;
