-- =====================================================================================
-- 0037 — Value a deposit at the rate it was taken at
--
-- `customer_account` computed each pool's deposit value as `sum(qty_units * ec.deposit)` — the
-- pool's CURRENT rate — rather than `sum(qty_units * d.deposit_per_unit)`, the rate actually
-- agreed when the deposit was taken. `deposit_per_unit` exists on every row precisely so that
-- history does not move, and nothing was reading it.
--
-- Two consequences, both silent:
--
--  1. A shop raising its crate deposit from ₦1,500 to ₦2,000 instantly revalued every deposit it
--     was already holding. Customers who paid the old rate appeared owed the new one.
--
--  2. Empties a customer owes back WITHOUT having paid anything — the ordinary case, where the
--     crates go out on trust — were valued as though money had been held against them. The shop
--     appeared to owe a refund on a deposit that was never taken.
--
-- The same read also conflated two different things under one heading. "Six crates are still out"
-- and "we are holding ₦12,000 of this customer's money" are different obligations that settle in
-- different ways, and they were one number. They are now separate fields.
-- =====================================================================================

create or replace function public.customer_account(p_store_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'customer', jsonb_build_object(
      'id', sc.id,
      'name', sc.display_name,
      'business', sc.business_name,
      'phone', i.phone
    ),
    'balance', public.customer_balance_total(sc.id),
    'money', jsonb_build_object(
      'goods', coalesce((
        select sum(sl.line_total)
        from public.sales s2
        join public.sale_lines sl on sl.sale_id = s2.id
        where s2.store_customer_id = sc.id and s2.status = 'posted'
      ), 0),
      'deposits_charged', coalesce((
        select sum(sl.deposit_charged)
        from public.sales s2
        join public.sale_lines sl on sl.sale_id = s2.id
        where s2.store_customer_id = sc.id and s2.status = 'posted'
      ), 0),
      'paid', coalesce((
        select sum(case when p.direction = 'in' then p.amount else -p.amount end)
        from public.payments p where p.store_customer_id = sc.id
      ), 0)
    ),
    -- Every named charge, kept separate and summed by label, so "transport" and "loading" are
    -- two lines the customer can recognise rather than one number they cannot.
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('label', t.label, 'amount', t.amount) order by t.label)
      from (
        select ch.label as label, sum(ch.amount) as amount
        from public.sales s3
        join public.sale_charges ch on ch.sale_id = s3.id
        where s3.store_customer_id = sc.id and s3.status = 'posted'
        group by ch.label
      ) t
    ), '[]'::jsonb),
    -- Containers still out, per fungible pool.
    --
    -- `held` is money the shop is actually sitting on, valued at the rate each row was taken at.
    -- `qty` is units still out regardless of whether anything was paid for them. A pool can have
    -- units out and nothing held (crates on trust), money held and nothing out (paid instead of
    -- returning), or both.
    'empties', coalesce((
      select jsonb_agg(jsonb_build_object(
        'category_id', e.category_id,
        'category', e.category,
        'kind', e.kind,
        'qty', e.qty,
        'held', e.held,
        -- Kept under its old name so nothing reading this breaks, but it is now the honest
        -- figure: what was taken, not what today's rate would imply.
        'deposit_value', e.held
      ) order by e.category)
      from (
        select ec.id as category_id,
               ec.name as category,
               ec.kind as kind,
               sum(d.qty_units) as qty,
               sum(d.qty_units * d.deposit_per_unit) as held
        from public.deposit_ledger d
        join public.empties_categories ec on ec.id = d.empties_category_id
        where d.store_customer_id = sc.id and d.direction = 'collected'
        group by ec.id, ec.name, ec.kind
        having sum(d.qty_units) > 0
            or sum(d.qty_units * d.deposit_per_unit) <> 0
      ) e
    ), '[]'::jsonb),
    -- Money held, on its own, for the pools where there is any. This is a LIABILITY: it reduces
    -- what the customer effectively owes and has to be given back or explicitly kept.
    'deposits_held', coalesce((
      select jsonb_agg(jsonb_build_object(
        'category_id', h.category_id,
        'category', h.category_name,
        'qty', h.qty_units,
        'amount', h.amount
      ) order by h.category_name)
      from public.customer_deposits_held(sc.id) h
      where h.amount <> 0
    ), '[]'::jsonb)
  )
  from public.store_customers sc
  join public.identities i on i.id = sc.identity_id
  where sc.id = p_store_customer_id
    and public.is_store_member(sc.store_id);
$fn$;

grant execute on function public.customer_account(uuid) to authenticated;
