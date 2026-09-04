-- 0091 — What the shop is owed, rather than what it has scrolled past
--
-- The Money screen led with a figure of ₦7,492,810 under the words "Owed by those loaded so far".
-- The label is honest and the number is not usable: it is the sum of whatever pages of the customer
-- list the reader happens to have scrolled through, so it grows as they scroll and lands on a
-- different answer every time. It is also the first thing on the screen and the largest thing on
-- it — which is to say it is the figure somebody writes down.
--
-- The page could not do better on its own. `list_customers` is paged, by design, because a shop
-- with four hundred customers should not wait for all of them to see the first ten. A total over a
-- paged list has to be computed where the rows are.
--
-- Same definition of a balance as the list, through the same `customer_balance_total`, so the total
-- and the rows can never disagree. Only what is OWED counts: a customer in credit reduces nothing,
-- because the shop cannot spend one customer's deposit to cover another's debt, and a total that
-- nets them off would say the shop is owed less than it is.

create or replace function public.store_money_owed(p_store_id uuid)
returns table (
  owed        money_amt,
  owed_by     int,
  in_credit   money_amt,
  credit_to   int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with balances as (
    select public.customer_balance_total(sc.id) as balance
      from public.store_customers sc
     where sc.store_id = p_store_id
       and sc.status = 'active'
       and public.is_store_member(p_store_id)
  )
  select
    coalesce(sum(balance) filter (where balance > 0), 0)::money_amt,
    count(*) filter (where balance > 0)::int,
    /*
     * And what the shop owes back, kept as its own figure rather than netted off.
     *
     * A customer in credit is money the shop is holding, not a reduction in what it is owed — it
     * cannot spend one customer's credit to cover another's debt. Netting them would understate
     * the debt and hide the deposit in the same stroke.
     */
    coalesce(-sum(balance) filter (where balance < 0), 0)::money_amt,
    count(*) filter (where balance < 0)::int
  from balances;
$$;

comment on function public.store_money_owed(uuid) is
  'The whole shop''s receivables, for a screen whose list is paged. Uses customer_balance_total, the '
  'same function list_customers uses per row, so the total and the rows cannot disagree.';

revoke all on function public.store_money_owed(uuid) from public;
grant execute on function public.store_money_owed(uuid) to authenticated;

do $check$
declare n int;
begin
  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'store_money_owed';
  if n <> 1 then
    raise exception 'store_money_owed has % overloads', n;
  end if;
end;
$check$;
