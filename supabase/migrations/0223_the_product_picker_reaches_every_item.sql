-- 0223 - The product picker reaches every item
--
-- "customer picker does not paginate and load all customer, so check all pickers if no one has the
-- same bug." The product picker had it worse: `search_products` takes a limit and nothing else, so
-- the picker asked for 50 and a shop with 105 items could only ever see the first 50 without
-- typing. This adds an optional `p_offset` (default 0), so every existing caller is untouched.
--
-- DROPPED FIRST, because adding a parameter to a function makes a SECOND function in Postgres —
-- the overload trap that has cost this project before. One signature, as before, one longer.

drop function if exists public.search_products(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.search_products(p_store_id uuid, p_query text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, name text, sku text, base_unit text, category_id uuid, category_name text, avg_unit_cost unit_cost, cost_is_estimated boolean, on_hand qty, pack_id uuid, pack_name text, pack_qty qty, list_price money_amt, low_stock_level numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as term)
  select p.id,
         p.name,
         p.sku,
         p.base_unit,
         p.category_id,
         c.name,
         p.avg_unit_cost,
         p.cost_is_estimated,
         coalesce((select sum(m.qty_delta) from public.stock_movements m
                    where m.product_id = p.id), 0)::qty,
         pk.id,
         pk.name,
         pk.base_unit_qty,
         pr.price,
         -- So a card marks itself the same whether it was browsed to or searched for.
         coalesce(p.low_stock_threshold, ss.low_stock_threshold)
  from public.products p
  cross join q
  left join public.product_categories c on c.id = p.category_id
  left join public.store_settings ss on ss.store_id = p.store_id
  left join public.product_packs pk
         on pk.id = coalesce(p.default_display_pack_id,
                             (select id from public.product_packs
                               where product_id = p.id order by base_unit_qty limit 1))
  left join public.product_prices pr
         on pr.product_id = p.id
        and (pr.pack_id = pk.id or (pr.pack_id is null and pk.id is null))
  where p.store_id = p_store_id
    and p.status = 'active'
    and public.is_store_member(p_store_id)
    and (
      q.term is null
      or p.name ilike '%' || q.term || '%'
      or p.sku  ilike '%' || q.term || '%'
      or c.name ilike '%' || q.term || '%'
      or similarity(p.name, q.term) > 0.25
    )
  order by
    -- Exact-ish name matches first, then category matches, then fuzzy. Someone typing "eva"
    -- wants the product before every other item that merely shares its category.
    case
      when q.term is null then 1
      when p.name ilike q.term || '%' then 0
      when p.name ilike '%' || q.term || '%' then 1
      when c.name ilike '%' || q.term || '%' then 2
      else 3
    end,
    p.name
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  -- 0223: the picker pages. The order above is total (rank, then name), so an offset is stable.
  offset greatest(0, coalesce(p_offset, 0));
$function$;

grant execute on function public.search_products(uuid, text, integer, integer) to authenticated;

notify pgrst, 'reload schema';
