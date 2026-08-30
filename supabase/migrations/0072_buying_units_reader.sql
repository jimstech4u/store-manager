-- The units a shop takes delivery in, for the whole catalogue at once.
--
-- The mirror of `product_selling_units`. The delivery screen lists many products and needs each
-- one's bought-in units to offer them; asking per product would be one request per row, which is
-- fine with eight products and painful with eight hundred.
--
-- `base_qty` is what the form sends back as `base_factor`, so what a shop said a bag holds is
-- exactly what the costing divides by.

create or replace function public.product_buying_units(p_store_id uuid)
returns table (
  product_id      uuid,
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text,
  base_qty        qty,
  is_default      boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.id, pu.id, su.name, su.plural, pu.base_qty,
         -- The largest is offered first: a delivery arrives by the bag far more often than by the
         -- litre, and the common case should be the one already selected.
         pu.base_qty = max(pu.base_qty) over (partition by p.id)
    from public.products p
    join public.product_units pu on pu.product_id = p.id and pu.is_bought
    join public.store_units su on su.id = pu.store_unit_id
   where p.store_id = p_store_id
     and p.status = 'active'
     and public.is_store_member(p_store_id)
   order by p.name, pu.base_qty desc;
$fn$;

grant execute on function public.product_buying_units(uuid) to authenticated;
