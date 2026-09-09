-- 0110 — Carrying the old ledgers over, into products and shapes
--
-- 948 rows in `deposit_ledger`, ₦2,805,850 of deposit money across 145 customers, and every one of
-- them recorded against a POOL — "NBL crate", "Dispenser water bottle" — rather than against the
-- product and the shape the shop actually sells in.
--
-- THE POOL MODEL LOSES INFORMATION, and this migration is where that becomes concrete. Eight beers
-- share one "NBL crate" pool, so a row saying "four NBL crates" cannot say whether they were
-- Goldberg or Gulder. Measured on the live shop:
--
--     from sales                345 rows   the sale line knows exactly — recoverable
--     pool links to one product 276 rows   only one thing it can be — recoverable
--     pool links to several     563 rows   ambiguous
--     pool links to nothing     109 rows   orphaned
--
-- So this resolves by PRECEDENCE, strongest evidence first, and stamps every row it had to infer so
-- the shop can tell a certainty from a carry-over. Nothing is invented silently and nothing is
-- dropped: a row that cannot be resolved at all stays in the old table, which is untouched.
--
-- The old tables are NOT dropped. `deposit_ledger`, `deposit_forfeits`, `deposit_holdings` and
-- `empties_categories` all keep working, and the screens still reading them keep working. Retiring
-- them is a separate step taken once nothing reads them.

--
-- SHOPS THAT NO LONGER EXIST. The benchmark drops its throwaway shop with
-- `session_replication_role = replica`, which skips foreign keys — so `deposit_ledger` and
-- `deposit_forfeits` hold rows pointing at stores that are gone. Every select below joins `stores`
-- so the carry-over only ever touches a shop somebody can still open.

-- ─── 1. The money, which is the part that must not be wrong ─────────────────────────
--
-- One `taken` row per customer, for what the old ledger says is being held. Summed rather than
-- copied row by row: the old ledger recorded a quantity at a rate, and 271 of its rows carry money
-- while the rest are containers with no deposit against them. What the shop is holding is the sum,
-- and that is the only figure anybody will check.

insert into public.customer_deposits (store_id, store_customer_id, direction, amount, reason,
                                      occurred_at, created_at)
select dl.store_id,
       dl.store_customer_id,
       'taken',
       sum(dl.qty_units * dl.deposit_per_unit)::money_amt,
       'Carried over from the old deposit ledger on 2026-09-09',
       min(dl.occurred_at),
       now()
  from public.deposit_ledger dl
  join public.stores st on st.id = dl.store_id
  join public.store_customers sc on sc.id = dl.store_customer_id
 where dl.store_customer_id is not null
   and dl.deposit_per_unit > 0
   -- Nothing carried over twice, so this migration can be run again safely.
   and not exists (
     select 1 from public.customer_deposits cd
      where cd.store_customer_id = dl.store_customer_id
        and cd.reason = 'Carried over from the old deposit ledger on 2026-09-09'
   )
 group by dl.store_id, dl.store_customer_id
having sum(dl.qty_units * dl.deposit_per_unit) > 0;

-- And what was kept against breakage, which is income and must stay separate from what was
-- given back. `deposit_forfeits` has always been a table rather than a subtraction for this reason.
insert into public.customer_deposits (store_id, store_customer_id, direction, amount, reason,
                                      occurred_at, created_at)
select f.store_id,
       f.store_customer_id,
       'retained',
       f.amount::money_amt,
       coalesce(nullif(btrim(f.note), ''), 'Kept for breakage') || ' (carried over 2026-09-09)',
       f.occurred_at,
       now()
  from public.deposit_forfeits f
  join public.stores st on st.id = f.store_id
  join public.store_customers sc on sc.id = f.store_customer_id
 where f.store_customer_id is not null
   and f.amount > 0
   and not exists (
     select 1 from public.customer_deposits cd
      where cd.store_customer_id = f.store_customer_id
        and cd.occurred_at = f.occurred_at
        and cd.amount = f.amount::money_amt
        and cd.direction = 'retained'
   );

-- ─── 2. The containers, resolved to a product and a shape ───────────────────────────

/*
 * WHICH PRODUCT AND WHICH SHAPE EACH OLD ROW MEANT.
 *
 * Four sources of evidence, strongest first. A row takes the first that answers.
 *
 *   1. THE SALE. `ref_table = 'sales'` and `sale_lines.sale_unit_id` names the exact shape sold —
 *      this is not inference at all, it is the fact the pool threw away.
 *   2. THE POOL LINKS TO ONE PRODUCT. Then there is nothing else it could have been.
 *   3. THE POOL LINKS TO SEVERAL. Prefer the product THIS CUSTOMER has actually bought in that
 *      pool; a shop's customer buys one or two brands, not all eight.
 *   4. STILL SEVERAL. Take the product with the most history in that pool and SAY SO in the
 *      reason, so nobody later mistakes a carry-over for a record.
 *
 * The SHAPE within the product comes from `product_returnables.product_unit_id` where 0102's
 * backfill set it, and otherwise from the pool's `kind`: a 'container' pool is the shape that goes
 * inside nothing (the crate), a 'content' pool is the shape that goes inside something (the
 * bottle). That is the same distinction `returnables_for_sale` branches on.
 */
with candidate as (
  select pr.empties_category_id,
         pr.product_id,
         coalesce(
           pr.product_unit_id,
           (
             select pu.id
               from public.product_units pu
              where pu.product_id = pr.product_id
                and pu.is_returnable
                -- A 'container' pool is the shape nothing is measured against; 'content' is the
                -- shape that goes inside one.
                and (
                  (ec.kind = 'container' and pu.defined_against_id is null)
                  or (ec.kind <> 'container' and pu.defined_against_id is not null)
                )
              order by pu.base_qty desc
              limit 1
           ),
           (
             select pu.id from public.product_units pu
              where pu.product_id = pr.product_id and pu.is_returnable
              order by pu.base_qty desc limit 1
           )
         ) as product_unit_id
    from public.product_returnables pr
    join public.empties_categories ec on ec.id = pr.empties_category_id
),
resolved as (
  select dl.id                as ledger_id,
         dl.store_id,
         dl.store_customer_id,
         dl.qty_units,
         dl.occurred_at,
         dl.ref_table,
         dl.ref_id,

         -- 1. The sale itself.
         (
           select sl.sale_unit_id
             from public.sale_lines sl
            where dl.ref_table = 'sales'
              and sl.sale_id = dl.ref_id
              and sl.sale_unit_id is not null
              and exists (
                select 1 from candidate c
                 where c.empties_category_id = dl.empties_category_id
                   and c.product_id = sl.product_id
              )
            order by sl.base_qty desc
            limit 1
         ) as from_sale,

         -- 2/3/4. The pool, preferring what this customer has actually bought.
         (
           select c.product_unit_id
             from candidate c
            where c.empties_category_id = dl.empties_category_id
              and c.product_unit_id is not null
            order by (
              select count(*)
                from public.sale_lines sl2
                join public.sales s2 on s2.id = sl2.sale_id
               where s2.store_customer_id = dl.store_customer_id
                 and sl2.product_id = c.product_id
            ) desc,
            (
              select count(*) from public.sale_lines sl3
               where sl3.product_id = c.product_id
            ) desc
            limit 1
         ) as from_pool,

         (
           select count(distinct c.product_id)
             from candidate c
            where c.empties_category_id = dl.empties_category_id
              and c.product_unit_id is not null
         ) as choices
    from public.deposit_ledger dl
    join public.stores st on st.id = dl.store_id
    join public.store_customers sc on sc.id = dl.store_customer_id
   where dl.store_customer_id is not null
     and dl.qty_units <> 0
)
insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                     direction, qty, reason, ref_table, ref_id, occurred_at,
                                     created_at)
select r.store_id,
       r.store_customer_id,
       pu.product_id,
       pu.id,
       -- The old ledger is signed: positive created the obligation, negative settled it.
       case when r.qty_units > 0 then 'out' else 'returned' end,
       abs(r.qty_units)::qty,
       case
         when r.from_sale is not null then null
         when r.choices <= 1 then 'Carried over from the old empties pool'
         else 'Carried over from a shared pool — the product was not recorded at the time'
       end,
       'deposit_ledger',
       r.ledger_id,
       r.occurred_at,
       now()
  from resolved r
  join public.product_units pu on pu.id = coalesce(r.from_sale, r.from_pool)
 where coalesce(r.from_sale, r.from_pool) is not null
   -- Idempotent: a row already carried over is not carried again.
   and not exists (
     select 1 from public.customer_empties ce
      where ce.ref_table = 'deposit_ledger' and ce.ref_id = r.ledger_id
   );

-- ─── 3. What could not be resolved, said out loud ───────────────────────────────────

do $said$
declare
  v_left    int;
  v_qty     numeric;
  v_moved   int;
  v_money   numeric;
begin
  select count(*), coalesce(sum(abs(dl.qty_units)), 0)
    into v_left, v_qty
    from public.deposit_ledger dl
    join public.stores st on st.id = dl.store_id
   where dl.store_customer_id is not null
     and dl.qty_units <> 0
     and not exists (
       select 1 from public.customer_empties ce
        where ce.ref_table = 'deposit_ledger' and ce.ref_id = dl.id
     );

  select count(*), coalesce(sum(amount), 0) into v_moved, v_money
    from public.customer_deposits
   where reason like 'Carried over from the old deposit ledger%';

  raise notice 'deposits carried over: % customers, %', v_moved, v_money;
  raise notice 'empties rows left behind (no product could be named): %, % containers', v_left, v_qty;

  /*
   * NOT AN ERROR. Those rows stay in `deposit_ledger`, which still works and is still read.
   *
   * They are the ones whose pool names no product at all — a "Dispenser water bottle" the shop has
   * never entered as an item. Naming the product is the shop's to do, on the product form, and this
   * migration can be run again afterwards: every insert above is guarded against doing it twice.
   */
end;
$said$;
