-- 0185 — A payment pays what is LEFT on a sale, not the sale over again
--
-- `record_payment` spreads a payment across the customer's sales, oldest first. It decided how
-- much each sale takes with:
--
--     v_applied := least(v_remaining, v_sale.total);
--
-- — the sale's WHOLE total, with no regard for what had already been paid against it. And the loop
-- it sits in walks every posted sale the customer has, settled ones included. So a customer who
-- had paid off an N86,600 sale in two N40,000 instalments, and later handed over a large sum, had
-- that sale allocated its full N86,600 a third time: N166,600 against an N86,600 bill.
--
-- WHAT THIS DOES AND DOES NOT BREAK. No money is invented — each payment is still only ever
-- allocated up to its own amount, and `customer_balance` sums PAYMENTS rather than allocations, so
-- the customer's overall balance was right throughout. What is wrong is the distribution: money
-- that should have cleared the next unpaid sale was consumed by one already settled. That is what
-- "Left on this sale", "Owed before" and "Total owed" are computed from, so a receipt could show a
-- sale overpaid while another stayed open — and the statement could not be followed line by line.
--
-- Found by re-deriving every sale's allocations from its payments, not from a report of a bug.

-- ─── 1. The fix ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_payment(
  p_store_id uuid,
  p_customer_id uuid,
  p_amount money_amt,
  -- Every default reproduced exactly. Dropping one is not a change of signature Postgres will
  -- accept on a replace, and `p_method` defaulting to cash is what every caller that omits it
  -- relies on.
  p_method text DEFAULT 'cash'::text,
  p_reference text DEFAULT NULL::text,
  p_occurred_at timestamp with time zone DEFAULT now(),
  p_client_uuid uuid DEFAULT NULL::uuid,
  p_bank_account_id uuid DEFAULT NULL::uuid
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_payment_id uuid;
  v_remaining  money_amt;
  v_sale       record;
  v_applied    money_amt;
begin
  if not public.has_permission(p_store_id, 'payments.record') then
    raise exception 'you do not have permission to record a payment' using errcode = '42501';
  end if;

  insert into public.payments (store_id, store_customer_id, amount, method, reference,
                               occurred_at, client_uuid, bank_account_id)
  values (p_store_id, p_customer_id, p_amount, p_method, p_reference, p_occurred_at,
          p_client_uuid, p_bank_account_id)
  returning id into v_payment_id;

  v_remaining := p_amount;

  /*
   * OLDEST DEBT FIRST, and only what is still owed on it.
   *
   * The `outstanding` subquery is the whole of the fix. Iterating on `s.total` walked settled
   * sales as though they were unpaid and handed each one its full value again.
   *
   * `> 0` in the WHERE rather than a guard inside the loop: a sale with nothing left is not a
   * candidate at all, so it cannot take a zero-value allocation row either — rows that say a
   * payment paid nothing towards something are noise in a statement somebody is trying to read.
   */
  for v_sale in
    select s.id,
           s.total - coalesce(a.paid, 0) as outstanding
      from public.sales s
      left join (select pa.sale_id, sum(pa.amount) as paid
                   from public.payment_allocations pa
                  group by pa.sale_id) a on a.sale_id = s.id
     where s.store_customer_id = p_customer_id
       and s.status = 'posted'
       and s.total - coalesce(a.paid, 0) > 0
     order by s.occurred_at asc
  loop
    exit when v_remaining <= 0;
    v_applied := least(v_remaining, v_sale.outstanding);
    insert into public.payment_allocations (payment_id, sale_id, amount)
    values (v_payment_id, v_sale.id, v_applied);
    v_remaining := v_remaining - v_applied;
  end loop;

  /*
   * Anything left over stays UNALLOCATED, deliberately.
   *
   * A customer who pays more than they owe is in credit, and `customer_balance` already reads that
   * correctly because it sums payments rather than allocations. Forcing the remainder onto the
   * last sale would show that sale overpaid — which is the very thing this migration exists to
   * stop — and inventing a sale to hold it would be worse.
   */
  return v_payment_id;
end;
$function$;

-- ─── 2. Re-deriving what the old one got wrong ──────────────────────────────────────
--
-- Only the customers who actually have an over-allocated sale are touched, and for those the
-- allocations are rebuilt from scratch by the rule above: payments oldest first, each one filling
-- the oldest sale that still owes something.
--
-- Allocations are a DISTRIBUTION of money that is already recorded elsewhere — the payments and
-- the sales are untouched, so nothing here changes what the shop took or what it sold. That is
-- what makes rebuilding them safe; rebuilding a payment would not be.

do $repair$
declare
  v_customer uuid;
  v_payment  record;
  v_sale     record;
  v_left     numeric;
  v_applied  numeric;
  v_fixed    int := 0;
begin
  for v_customer in
    select distinct s.store_customer_id
      from public.sales s
      join public.payment_allocations pa on pa.sale_id = s.id
     where s.status = 'posted' and s.store_customer_id is not null
     group by s.id, s.store_customer_id, s.total
    having sum(pa.amount) - s.total > 0.005
  loop
    delete from public.payment_allocations pa
     using public.payments p
     where pa.payment_id = p.id and p.store_customer_id = v_customer;

    for v_payment in
      select p.id, p.amount
        from public.payments p
       where p.store_customer_id = v_customer and p.direction = 'in'
       order by p.occurred_at asc, p.created_at asc
    loop
      v_left := v_payment.amount;

      for v_sale in
        select s.id, s.total - coalesce(a.paid, 0) as outstanding
          from public.sales s
          left join (select pa.sale_id, sum(pa.amount) as paid
                       from public.payment_allocations pa
                      group by pa.sale_id) a on a.sale_id = s.id
         where s.store_customer_id = v_customer
           and s.status = 'posted'
           and s.total - coalesce(a.paid, 0) > 0
         order by s.occurred_at asc
      loop
        exit when v_left <= 0;
        v_applied := least(v_left, v_sale.outstanding);
        insert into public.payment_allocations (payment_id, sale_id, amount)
        values (v_payment.id, v_sale.id, v_applied);
        v_left := v_left - v_applied;
      end loop;
    end loop;

    v_fixed := v_fixed + 1;
  end loop;

  raise notice 'rebuilt allocations for % customer(s)', v_fixed;
end
$repair$;
