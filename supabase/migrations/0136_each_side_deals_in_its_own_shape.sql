-- 0136 — Each side of the counter deals in its own shape
--
-- «for empties page for customers, we are to use the shapes that have count them in ticked. But
--  empties with suppliers is just shape that tick "arrives in this"»
--
-- Both sides were offered every shape marked `is_returnable`, which is the union of two different
-- answers rather than either of them. For Goldberg that meant a customer's opening position asked
-- for crates AND bottles — two rows for one physical stack, and a question nobody can answer
-- without opening every crate in the yard.
--
--   A CUSTOMER deals in the shape the shop COUNTS in. They take crates and bring crates back.
--   A SUPPLIER deals in the shape it ARRIVES in. A lorry brings crates and takes crates, and the
--   brewery has never seen the bottles on their own.
--
-- Copied verbatim from 0121 with one condition added, never tidied.

drop function if exists public.product_empties_out(uuid);

create function public.product_empties_out(p_product_id uuid)
returns table (
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text,
  base_qty        qty,
  is_returnable   boolean,
  out_now         qty,
  customers_out   int,
  -- What one of these is made of, in the shop's word: "12 bottles". Null for a shape measured
  -- against nothing, which IS the smallest thing this product comes in.
  inner_name      text,
  inner_plural    text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select pu.id, su.name, su.plural, pu.base_qty, pu.is_returnable,
         coalesce(sum(case when ce.direction = 'out' then ce.qty else -ce.qty end), 0)::qty,
         count(distinct ce.store_customer_id) filter (
           where ce.store_customer_id in (
             select ce2.store_customer_id
               from public.customer_empties ce2
              where ce2.product_unit_id = pu.id
              group by ce2.store_customer_id
             having sum(case when ce2.direction = 'out' then ce2.qty else -ce2.qty end) > 0
           )
         )::int,
         insu.name,
         insu.plural
    from public.product_units pu
    join public.products p on p.id = pu.product_id
    join public.store_units su on su.id = pu.store_unit_id
    -- The shape it is defined against, and that shape's own word.
    left join public.product_units inpu on inpu.id = pu.defined_against_id
    left join public.store_units insu on insu.id = inpu.store_unit_id
    left join public.customer_empties ce on ce.product_unit_id = pu.id
   where pu.product_id = p_product_id
     and pu.is_returnable
     /*
      * AND THE SHAPE THE SHOP COUNTS IN.
      *
      * «for empties page for customers, we are to use the shapes that have count them in ticked»
      *
      * A distributor counts crates, not bottles. A customer takes crates and brings crates back, so
      * that is the shape the obligation lives in — offering the bottles as well asks somebody to
      * open every crate in the yard to answer, and produces two rows for one physical stack.
      *
      * The SUPPLIER side asks the opposite question and filters on `is_bought`: a brewery deals in
      * the shape it delivers in and has never seen the bottles on their own.
      */
     and pu.is_counted
     and public.is_store_member(p.store_id)
   group by pu.id, su.name, su.plural, pu.base_qty, pu.is_returnable, insu.name, insu.plural
   order by pu.base_qty desc;
$fn$;

revoke all on function public.product_empties_out(uuid) from public;
grant execute on function public.product_empties_out(uuid) to authenticated;
