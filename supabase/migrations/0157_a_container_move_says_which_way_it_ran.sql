-- 0157 — A container movement says which way it ran
--
-- `they_hold` is ours, out with them; `we_hold` is theirs, left with us. 0155 gave each ledger line
-- its item and its receipt, and the two sides were still indistinguishable in it — so the 13 rows
-- where a customer LEFT their own crates with the shop read "Took 3 crates", and the 13 where the
-- shop handed them back read "Brought back 3 crates". Both exactly inverted.
--
-- The column exists on the table and has since containers went both ways (0127). The reader dropped
-- it, and every screen reading the reader had to guess — so the screens guessed the common case.
--
-- Added at the END, after 0155's `product_id` and `sale_id`, so a reader of the old shape keeps
-- working; the return type changes, which `create or replace` cannot do, hence the drop.

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
  sale_id uuid,
  side text
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
         end,
         -- Rows written before containers went both ways are ours, out with them.
         coalesce(ce.side, 'they_hold')
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
