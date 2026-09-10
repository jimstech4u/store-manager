-- 0119 — One answer to "what are they holding", and one to "what am I holding for them"
--
-- From the moment the customer form started writing opening balances into `customer_empties`, this
-- shop had TWO ledgers being written and two screens reading different ones. The empties page said
-- what a customer owed in product shapes; the account page said it in pools, from `deposit_ledger`.
-- Both were live, both were growing, and a sale fed both — so they drifted apart from the first
-- transaction and nobody could say which was right.
--
-- This is the tidy-up: the account reads the same ledger as everything else.
--
--   `empties`        product and shape, from `customer_empties_owed` — the same reader the empties
--                    screen uses, so an opening balance and a sale add up on both.
--   `deposits_held`  ONE MONEY FIGURE, from `customer_deposits`. Not a row per pool with a
--                    quantity and a rate.
--
-- COPIED FROM THE LIVE DEFINITION and changed on those two keys. Everything else is byte-for-byte
-- what was running: this function is read by the account screen, the action page and the statement,
-- and 0058 took the till down by rewriting a working function more tidily.

CREATE OR REPLACE FUNCTION public.customer_account(p_store_customer_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    /*
     * CONTAINERS STILL OUT, IN THE SHAPE THEY LEFT IN.
     *
     * This read `deposit_ledger` grouped by pool, so the account screen said "NBL crate 29" and
     * "Guinness bottle 8" — a vocabulary invented beside the product's own, which 0108 replaced.
     * Worse, from the moment the customer form started writing to `customer_empties` there were
     * TWO answers to the same question on two screens, drifting apart from the first sale.
     *
     * `held` is gone from these rows. Money is not a property of a container any more: a deposit is
     * a round sum on its own ledger, reported below as one figure, which is the whole point of
     * separating them.
     */
    'empties', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', e.product_id,
        'product', e.product_name,
        'product_unit_id', e.product_unit_id,
        'unit', e.unit_name,
        'unit_plural', e.unit_plural,
        'group', e.group_name,
        'qty', e.owed
      ) order by e.group_name nulls last, e.product_name)
      from public.customer_empties_owed(sc.id) e
      where e.owed > 0
    ), '[]'::jsonb),
    /*
     * MONEY HELD — ONE FIGURE, because that is what a deposit is.
     *
     * It used to be a row per pool with a quantity and a rate: "20 NBL crates, N40,000". A shop
     * does not hold twenty crates' worth of money, it holds forty thousand naira, and expressing
     * that as containers is why a plain deposit could not be recorded at all.
     *
     * `deposits_held` keeps its name so nothing reading this breaks, and is now a number rather
     * than an array — the screens that render it are changed in the same commit.
     */
    'deposits_held', coalesce((
      select sum(case when d.direction = 'taken' then d.amount else -d.amount end)
        from public.customer_deposits d
       where d.store_customer_id = sc.id
    ), 0)
  )
  from public.store_customers sc
  join public.identities i on i.id = sc.identity_id
  where sc.id = p_store_customer_id
    and public.is_store_member(sc.store_id);
$function$;

/*
 * AND THE SALE STOPS WRITING THE OLD LEDGER.
 *
 * `record_sale` loops over `returnables_for_sale` and appends a `deposit_ledger` row per pool. The
 * trigger from 0117 already records the same containers against the product's shape, so every sale
 * was being written down twice in two vocabularies.
 *
 * The reader is emptied rather than `record_sale` being edited. That function is three hundred
 * lines and is the one thing on the till that must never break — 0058 changed a parameter order and
 * PostgREST answered 300 to every call; 0080 renamed a key the client had never sent. A loop over
 * no rows writes nothing, and every caller keeps its signature.
 *
 * The pool tables are NOT dropped. `deposit_ledger` holds four years of history that
 * `customer_empties` now carries forward, and a receipt somebody is holding must still resolve.
 */
create or replace function public.returnables_for_sale(
  p_product_id   uuid,
  p_base_qty     qty,
  p_containers   qty default 0,
  p_sale_unit_id uuid default null
)
returns table (
  empties_category_id uuid,
  category_name       text,
  kind                text,
  qty_units           qty,
  deposit_per_unit    money_amt,
  deposit_total       money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $retired$
  -- Deliberately empty. Containers are owed against the product's own shape now (0108), recorded
  -- by the trigger on `sale_lines` (0117). Kept as a function so `record_sale` and the till keep
  -- their shapes; the arguments are read so the signature cannot be mistaken for unused.
  select null::uuid, null::text, null::text, null::qty, null::money_amt, null::money_amt
   where false
     and p_product_id is not null
     and p_base_qty is not null
     and p_containers is not null
     and p_sale_unit_id is not null;
$retired$;

revoke all on function public.returnables_for_sale(uuid, qty, qty, uuid) from public;
grant execute on function public.returnables_for_sale(uuid, qty, qty, uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('customer_account', 'returnables_for_sale')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a rewritten function has % overloads', n;
    end if;
  end loop;
end;
$check$;
