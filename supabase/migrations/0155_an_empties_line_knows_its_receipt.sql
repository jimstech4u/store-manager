-- 0155 — An empties line knows its receipt and its item
--
-- «if i am viewing a record and that record is a sub of another record, it can point to it»
--
-- A customer's empties history said "Took 3 crates · Goldberg 60cl" and stopped. The receipt that
-- sent them out and the item they belong to were both one join away — `customer_empties` has kept
-- the product and a reference to where each row came from all along — and the ledger reader threw
-- both away. It now returns them, so each line opens its receipt and its item.
--
-- The sale is found through whatever wrote the row:
--   sale_lines      the line that sent the containers out
--   deposit_ledger  a row carried over from the pool ledger, whose own reference may be a sale
--   sale_void       a void's reversal, which points at the OUT row it cancels — so one step further
-- Anything else (a return at the counter, a write-off, an opening figure) has no receipt.
--
-- Columns are added at the END, so a reader of the old shape keeps working; the return type
-- changes, which `create or replace` cannot do, hence the drop.

drop function if exists public.customer_empties_ledger(uuid);

create function public.customer_empties_ledger(p_store_customer_id uuid)
returns table (
  id uuid,
  product_name text,
  unit_name text,
  unit_plural text,
  direction text,
  qty qty,
  reason text,
  occurred_at timestamptz,
  product_id uuid,
  sale_id uuid
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with rows as (
    select ce.*,
           -- A void's reversal stands in for the row it cancels.
           case when ce.ref_table = 'sale_void' then o.ref_table else ce.ref_table end as src_table,
           case when ce.ref_table = 'sale_void' then o.ref_id else ce.ref_id end as src_id
      from public.customer_empties ce
      left join public.customer_empties o
        on ce.ref_table = 'sale_void' and o.id = ce.ref_id
     where ce.store_customer_id = p_store_customer_id
  )
  select ce.id,
         coalesce(p.name, gc.name),
         coalesce(su.name, gsu.name),
         coalesce(su.plural, gsu.plural),
         ce.direction, ce.qty, ce.reason, ce.occurred_at,
         ce.product_id,
         case ce.src_table
           when 'sale_lines' then (select sl.sale_id from public.sale_lines sl where sl.id = ce.src_id)
           when 'deposit_ledger' then (
             select dl.ref_id from public.deposit_ledger dl
              where dl.id = ce.src_id and dl.ref_table = 'sales'
           )
         end
    from rows ce
    join public.store_customers c on c.id = ce.store_customer_id
    left join public.products p on p.id = ce.product_id
    left join public.product_units pu on pu.id = ce.product_unit_id
    left join public.store_units su on su.id = pu.store_unit_id
    left join public.product_categories gc on gc.id = ce.category_id
    left join public.store_units gsu on gsu.id = ce.store_unit_id
   where public.is_store_member(c.store_id)
   order by ce.occurred_at desc, ce.created_at desc;
$function$;

revoke all on function public.customer_empties_ledger(uuid) from public, anon;
grant execute on function public.customer_empties_ledger(uuid) to authenticated;
