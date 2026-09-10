-- 0121 — A shape says what it is measured in, in the shop's own word
--
-- The product screen read "Crates · one is 12 piece". Two faults in five words.
--
-- "piece" is `products.base_unit`, which is a FIXED VOCABULARY — a foreign key to `units`, whose
-- seven codes are piece/kg/g/litre/cl/metre/yard. It is a storage unit, not something a shop says.
-- The shop's own word is on the SHAPE, and here it is "bottle": Goldberg's crate is defined against
-- its bottle, twelve to one, which is exactly what the product form asked for.
--
-- And "12 piece" is singular for twelve of them. Every shape already carries its plural — the unit
-- form asks for it separately precisely because "Boxs" and "Kilogrammes" cannot both come from
-- adding an s — and nothing was reading it.
--
-- So the reader hands back the shape a container is measured against, and the screen says
-- "one is 12 bottles".

-- Dropped first: two columns are being ADDED to the row type, and `create or replace` cannot
-- change one. Every caller is in this repo and moves in the same commit.
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
     and public.is_store_member(p.store_id)
   group by pu.id, su.name, su.plural, pu.base_qty, pu.is_returnable, insu.name, insu.plural
   order by pu.base_qty desc;
$fn$;

revoke all on function public.product_empties_out(uuid) from public;
grant execute on function public.product_empties_out(uuid) to authenticated;

do $check$
declare n int;
begin
  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'product_empties_out';
  if n <> 1 then
    raise exception 'product_empties_out has % overloads', n;
  end if;
end;
$check$;
