-- =====================================================================================
-- 0172 — The stock list knows what "running low" means for each item
--
-- `low_stock_items` answers "what is low" for a screen that asks that question. The STOCK LIST asks
-- a different one — "here is everything, and how much of it there is" — and needs the level beside
-- each row so a card can mark itself without a second request per item.
--
-- The level is the item's own where it has one and the shop's otherwise, worked out in the same
-- expression `low_stock_items` and `low_stock_level` use. It is null when neither is set, which is
-- what "nobody has asked to be told" looks like.
-- =====================================================================================

drop function if exists public.list_products(uuid, text, uuid, integer);

CREATE OR REPLACE FUNCTION public.list_products(p_store_id uuid, p_after_name text DEFAULT NULL::text, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 30)
 RETURNS TABLE(id uuid, name text, sku text, base_unit text, category_id uuid, category_name text, avg_unit_cost unit_cost, cost_is_estimated boolean, on_hand qty, pack_id uuid, pack_name text, pack_qty qty, list_price money_amt, low_stock_level numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p.id, p.name, p.sku, p.base_unit, p.category_id, c.name,
         p.avg_unit_cost, p.cost_is_estimated,
         coalesce((select sum(m.qty_delta) from public.stock_movements m
                    where m.product_id = p.id), 0)::qty,
         pk.id, pk.name, pk.base_unit_qty, pr.price,
         /*
          * THE LEVEL THIS ITEM IS JUDGED BY — its own if it has one, the shop's otherwise.
          *
          * Returned with the row rather than looked up per card, because the stock list draws
          * thirty of these and a per-row request is thirty requests to answer one question the
          * list already had the data for.
          */
         coalesce(p.low_stock_threshold, ss.low_stock_threshold)
  from public.products p
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
    -- (name, id) as a tuple: the id breaks ties between identically named products, which a
    -- name-only cursor would either loop on or skip past.
    and (p_after_name is null or (p.name, p.id) > (p_after_name, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  order by p.name, p.id
  limit greatest(1, least(coalesce(p_limit, 30), 100));
$function$;

grant execute on function public.list_products(uuid, text, uuid, integer) to authenticated;
