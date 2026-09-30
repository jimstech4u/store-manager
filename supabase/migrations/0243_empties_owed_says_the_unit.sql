-- 0243 - What a customer holds says the unit, so a maker's line can come back
--
-- A maker-level row (an opening balance entered by maker: "1 Nigerian Breweries crate") has no
-- product shape, so "All back" had nothing to record it against and the line could never be
-- settled. `customer_empties_owed` now returns each row's store unit as a trailing column: for a
-- product row its shape's unit, for a maker row the unit it was entered in. The client returns a
-- maker row through `record_customer_empties_for_group`. Adding a column changes the return type,
-- so the function is dropped and made again; `customer_account` reads it by column name.

drop function if exists public.customer_empties_owed(uuid);
CREATE OR REPLACE FUNCTION public.customer_empties_owed(p_store_customer_id uuid)
 RETURNS TABLE(product_id uuid, product_name text, product_unit_id uuid, unit_name text, unit_plural text, base_qty qty, group_id uuid, group_name text, side text, taken qty, returned qty, damaged qty, owed qty, store_unit_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p.id,
         coalesce(p.name, gc.name),
         pu.id,
         coalesce(su.name, gsu.name),
         coalesce(su.plural, gsu.plural),
         coalesce(pu.base_qty, public.group_unit_base_qty(gc.id, gsu.id), 1)::qty,
         coalesce(g.id, gc.id),
         coalesce(g.name, gc.name),
         ce.side,
         coalesce(sum(ce.qty) filter (where ce.direction = 'out'), 0)::qty,
         coalesce(sum(ce.qty) filter (where ce.direction = 'returned'), 0)::qty,
         coalesce(sum(ce.qty) filter (where ce.direction = 'damaged'), 0)::qty,
         (coalesce(sum(ce.qty) filter (where ce.direction = 'out'), 0)
          - coalesce(sum(ce.qty) filter (where ce.direction = 'returned'), 0)
          - coalesce(sum(ce.qty) filter (where ce.direction = 'damaged'), 0))::qty,
         coalesce(su.id, gsu.id)
    from public.customer_empties ce
    join public.store_customers c on c.id = ce.store_customer_id
    left join public.products p on p.id = ce.product_id
    left join public.product_units pu on pu.id = ce.product_unit_id
    left join public.store_units su on su.id = pu.store_unit_id
    left join public.product_categories gc on gc.id = ce.category_id
    left join public.store_units gsu on gsu.id = ce.store_unit_id
    left join lateral (
      select pc.id, pc.name
        from public.product_category_links pcl
        join public.product_categories pc on pc.id = pcl.category_id
       where pcl.product_id = p.id
         and coalesce(pc.status, 'active') = 'active'
       order by pc.name
       limit 1
    ) g on true
   where ce.store_customer_id = p_store_customer_id
     and public.is_store_member(c.store_id)
   group by p.id, p.name, pu.id, su.id, su.name, su.plural, pu.base_qty, g.id, g.name,
            gc.id, gc.name, gsu.id, gsu.name, gsu.plural, ce.side
   order by ce.side, 8 nulls last, 2, 6 desc;
$function$;

grant execute on function public.customer_empties_owed(uuid) to authenticated;

notify pgrst, 'reload schema';
