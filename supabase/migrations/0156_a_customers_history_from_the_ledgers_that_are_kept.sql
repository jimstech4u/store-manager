-- 0156 — A customer's history, read from the ledgers the shop actually keeps
--
-- `customer_history` was last rewritten before the pools were retired. It still read
-- `deposit_ledger` and `deposit_forfeits` — the pool-era tables nothing has written since 0108/0109 —
-- and never looked at the ones that replaced them. So "Everything that has happened", on the account
-- and under the statement, left out:
--
--   * a charge or an amount owed to them (`customer_charges`) — which MOVES the balance, so the page
--     headed "What makes up this balance" could not account for it;
--   * an opening debt (`opening_balances`, kind 'debtor') — also in the balance, also missing;
--   * every deposit taken, given back or kept since 0109 (`customer_deposits`);
--   * containers brought back or written off (`customer_empties`).
--
-- It showed 990 pool rows instead, in pools' words. And the actor was the login email, where every
-- other timeline shows the name the shop gave its staff (0132).
--
-- THE SAME COLUMNS, so the two screens and the local patch that read it keep working; `category_id`
-- stays as an always-null column rather than changing the return type under them.
--
-- WHAT IS LEFT OUT ON PURPOSE: containers that went out ON A SALE. The sale is its own row, and its
-- receipt lists what went with it; a second row per crate would bury the account under its own sales.
-- A void's reversal is left out for the same reason — the voided sale is no longer here either.

create or replace function public.customer_history(p_store_customer_id uuid, p_limit integer default 100)
returns table (
  occurred_at timestamptz,
  kind text,
  label text,
  detail text,
  amount money_amt,
  qty_units qty,
  category_id uuid,
  ref_table text,
  ref_id uuid,
  actor text
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with allowed as (
    select sc.id, sc.store_id
      from public.store_customers sc
     where sc.id = p_store_customer_id
       and public.is_store_member(sc.store_id)
  ),
  events as (
    -- Goods sold
    select s.occurred_at, 'sale'::text as kind, 'Sale'::text as label,
           coalesce(s.note, '')::text as detail, s.total as amount, null::qty as qty_units,
           'sales'::text as ref_table, s.id as ref_id, s.created_by as actor_id
      from public.sales s join allowed a on a.id = s.store_customer_id
     where s.status = 'posted'

    union all

    -- Money in and out
    select p.occurred_at,
           case when p.direction = 'in' then 'payment' else 'refund' end,
           case when p.direction = 'in' then 'Payment received' else 'Money refunded' end,
           coalesce(p.method || coalesce(' · ' || p.reference, ''), '')::text,
           case when p.direction = 'in' then p.amount else -p.amount end,
           null::qty, 'payments'::text, p.id, p.created_by
      from public.payments p join allowed a on a.id = p.store_customer_id

    union all

    -- A charge adds to what they owe; an excess is the shop owing them.
    select c.occurred_at,
           case when c.direction = 'charge' then 'charge' else 'excess' end,
           case when c.direction = 'charge' then 'Charge added' else 'Owed to them' end,
           coalesce(c.reason, '')::text,
           case when c.direction = 'charge' then c.amount else -c.amount end,
           null::qty, 'customer_charges'::text, c.id, c.created_by
      from public.customer_charges c join allowed a on a.id = c.store_customer_id

    union all

    -- What they owed before the shop started using the app.
    select coalesce(ob.as_of_date::timestamptz, ob.created_at),
           'opening'::text, 'Opening balance'::text,
           coalesce(ob.note, '')::text,
           ob.amount, null::qty, 'opening_balances'::text, ob.id, ob.entered_by
      from public.opening_balances ob join allowed a on a.id = ob.store_customer_id
     where ob.kind = 'debtor'

    union all

    -- Money held for them: taken, given back, kept.
    select d.occurred_at,
           case d.direction
             when 'taken' then 'deposit_taken'
             when 'given' then 'deposit_returned'
             else 'deposit_kept'
           end,
           case d.direction
             when 'taken' then 'Deposit taken'
             when 'given' then 'Deposit given back'
             else 'Deposit kept'
           end,
           coalesce(d.reason, '')::text,
           d.amount, null::qty, 'customer_deposits'::text, d.id, d.created_by
      from public.customer_deposits d join allowed a on a.id = d.store_customer_id

    union all

    -- Containers moving that are NOT the goods on a sale: brought back, written off, and any that
    -- went out some other way (an opening figure, a hand entry).
    select e.occurred_at,
           case e.direction
             when 'returned' then 'empties_returned'
             when 'damaged' then 'empties_written_off'
             else 'empties_out'
           end,
           case e.direction
             when 'returned' then 'Containers brought back'
             when 'damaged' then 'Containers written off'
             else 'Containers taken'
           end,
           concat_ws(' · ',
             coalesce(p.name, gc.name),
             coalesce(su.plural, gsu.plural),
             nullif(e.reason, ''))::text,
           null::money_amt, e.qty, 'customer_empties'::text, e.id, e.created_by
      from public.customer_empties e
      join allowed a on a.id = e.store_customer_id
      left join public.products p on p.id = e.product_id
      left join public.product_units pu on pu.id = e.product_unit_id
      left join public.store_units su on su.id = pu.store_unit_id
      left join public.product_categories gc on gc.id = e.category_id
      left join public.store_units gsu on gsu.id = e.store_unit_id
      left join public.deposit_ledger dl on e.ref_table = 'deposit_ledger' and dl.id = e.ref_id
     where coalesce(e.side, 'they_hold') = 'they_hold'
       and coalesce(e.ref_table, '') <> 'sale_void'
       and not (
         e.direction = 'out'
         and (e.ref_table = 'sale_lines' or (e.ref_table = 'deposit_ledger' and dl.ref_table = 'sales'))
       )
  )
  select e.occurred_at, e.kind, e.label, e.detail, e.amount, e.qty_units,
         null::uuid,
         e.ref_table, e.ref_id,
         -- The name the shop gave them, as on every other timeline (0132).
         coalesce(
           nullif(trim(coalesce(sm.first_name, '') || ' ' || coalesce(sm.last_name, '')), ''),
           sm.login_email,
           u.email::text,
           'the shop'
         )
    from events e
    cross join allowed a
    left join public.store_members sm on sm.user_id = e.actor_id and sm.store_id = a.store_id
    left join auth.users u on u.id = e.actor_id
   order by e.occurred_at desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
$function$;
