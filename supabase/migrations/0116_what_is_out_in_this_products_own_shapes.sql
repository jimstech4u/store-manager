-- 0116 — What is out, in this product's own shapes
--
-- The product screen still reads `product_empties`, which answers in POOLS:
--
--     NBL bottle    2940   1 per piece · you usually hold ₦125 each     60 customers
--     NBL crate   1608.5   counted when one leaves with the goods      101 customers
--
-- Three things are wrong with that on a page about Goldberg.
--
-- It is not about Goldberg. The note under it says so — "across every product that shares these
-- pools, not this item alone" — so the screen is a product page showing a figure for eight
-- products, and the shop reads it as this one's.
--
-- "NBL bottle" and "NBL crate" are not shapes this product has. Goldberg comes in a crate; the
-- pool was a second vocabulary invented beside the product's own, and 0108 replaced it.
--
-- And "you usually hold ₦125 each" is the deposit-as-a-rate-per-container model that 0109 removed:
-- a deposit is a round sum against a customer, not a price per crate.
--
-- So this answers the question the page is actually asking — how many of THIS item's containers
-- are out, in the shapes this item comes in.

create or replace function public.product_empties_out(p_product_id uuid)
returns table (
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text,
  base_qty        qty,
  is_returnable   boolean,
  out_now         qty,
  customers_out   int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pu.id, su.name, su.plural, pu.base_qty, pu.is_returnable,
         coalesce(sum(case when ce.direction = 'out' then ce.qty else -ce.qty end), 0)::qty,
         /*
          * HOW MANY PEOPLE, counted only where something is actually still out.
          *
          * A customer who took ten crates and brought ten back is not "a customer with crates" —
          * counting them would make the figure climb for ever and never come down.
          */
         count(distinct ce.store_customer_id) filter (
           where ce.store_customer_id in (
             select ce2.store_customer_id
               from public.customer_empties ce2
              where ce2.product_unit_id = pu.id
              group by ce2.store_customer_id
             having sum(case when ce2.direction = 'out' then ce2.qty else -ce2.qty end) > 0
           )
         )::int
    from public.product_units pu
    join public.products p on p.id = pu.product_id
    join public.store_units su on su.id = pu.store_unit_id
    left join public.customer_empties ce on ce.product_unit_id = pu.id
   where pu.product_id = p_product_id
     and pu.is_returnable
     and public.is_store_member(p.store_id)
   group by pu.id, su.name, su.plural, pu.base_qty, pu.is_returnable
   order by pu.base_qty desc;
$$;

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
