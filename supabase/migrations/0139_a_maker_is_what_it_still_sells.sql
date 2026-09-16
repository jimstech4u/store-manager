-- 0139 — A maker's containers are the ones on items it still sells
--
-- «when adding items by makers, it is just NBL and the amount box, not 20 boxes»
--
-- `group_return_units` listed every unit word ANY of a maker's items had ever come back in,
-- including items archived long ago — the sample shop's test items put twenty of them under
-- Nigerian Breweries. `groups_with_returnables` (0118) already filtered on status; its companion
-- did not.
--
-- Copied verbatim from 0118 with one condition added.

create or replace function public.group_return_units(p_category_id uuid)
returns table (store_unit_id uuid, name text, plural text, products int)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select su.id, su.name, su.plural, count(distinct p.id)::int
    from public.product_categories c
    join public.product_category_links l on l.category_id = c.id
    join public.products p on p.id = l.product_id
    join public.product_units pu on pu.product_id = p.id and pu.is_returnable
    join public.store_units su on su.id = pu.store_unit_id
   where c.id = p_category_id
     /*
      * ONLY ITEMS THE SHOP STILL HAS.
      *
      * An archived item's crates and bottles kept turning up as boxes on the customer form — twenty
      * of them in the sample shop, from test items long since retired. `groups_with_returnables`
      * has always filtered on status; this one never did.
      */
     and coalesce(p.status, 'active') = 'active'
     and public.is_store_member(c.store_id)
   group by su.id, su.name, su.plural
   order by count(distinct p.id) desc, su.name;
$fn$;

revoke all on function public.group_return_units(uuid) from public;
grant execute on function public.group_return_units(uuid) to authenticated;
