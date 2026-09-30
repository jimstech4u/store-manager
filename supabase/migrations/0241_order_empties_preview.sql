-- 0241 - What would be still with them, before the order is paid
--
-- "All items is just a pseudo receipt ... a way to let the customer see the shape so they can still
-- make changes based on how it will look after, so it doesn't have to be corrected." Its "Still with
-- you" box has to say what the receipt WILL say: everything the customer holds now, plus what this
-- order sends out — rolled up by the same `rollUpOwed` the receipt uses.
--
-- The order's part mirrors `tg_sale_line_owes_containers` exactly: a line in a RETURNABLE shape sends
-- out its entered quantity, in that shape. The customer's part is `customer_empties_owed`, what they
-- hold. Rows come back in its shape (maker = the first active group by name), so the screen joins
-- them with no rule of its own. Read-only; nothing is written.

create or replace function public.order_empties_preview(
  p_store_id uuid,
  p_customer_id uuid,
  p_lines jsonb
)
returns table(product_id uuid, product_name text, product_unit_id uuid, unit_name text,
              unit_plural text, base_qty qty, group_id uuid, group_name text, side text, owed qty)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  -- What they hold now.
  select e.product_id, e.product_name, e.product_unit_id, e.unit_name, e.unit_plural, e.base_qty,
         e.group_id, e.group_name, e.side, e.owed
    from public.customer_empties_owed(p_customer_id) e
   where p_customer_id is not null
     and e.side = 'they_hold'
     and e.owed > 0
     and exists (select 1 from public.store_customers c
                  where c.id = p_customer_id and c.store_id = p_store_id)
  union all
  -- And what this order would send out.
  select p.id, p.name, pu.id, su.name, su.plural, coalesce(pu.base_qty, 1)::qty,
         g.id, g.name, 'they_hold', sum((l ->> 'qty')::numeric)::qty
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
    join public.product_units pu on pu.id = nullif(l ->> 'sale_unit_id', '')::uuid
                                and pu.is_returnable
    join public.products p on p.id = pu.product_id
                          and p.id = nullif(l ->> 'product_id', '')::uuid
                          and p.store_id = p_store_id
    join public.store_units su on su.id = pu.store_unit_id
    left join lateral (
      select pc.id, pc.name
        from public.product_category_links pcl
        join public.product_categories pc on pc.id = pcl.category_id
       where pcl.product_id = p.id
         and coalesce(pc.status, 'active') = 'active'
       order by pc.name
       limit 1
    ) g on true
   where public.is_store_member(p_store_id)
     and coalesce((l ->> 'qty')::numeric, 0) > 0
   group by p.id, p.name, pu.id, su.name, su.plural, pu.base_qty, g.id, g.name;
$function$;

revoke all on function public.order_empties_preview(uuid, uuid, jsonb) from public, anon;
grant execute on function public.order_empties_preview(uuid, uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
