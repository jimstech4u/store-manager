-- =====================================================================================
-- 0173 — Every reader of a product carries its "running low" level
--
-- 0172 gave the level to `list_products`, which is what the stock list reads. Two other functions
-- return the same product row and did not get it, and both matter:
--
--   · `get_product` is what the EDIT FORM reads. Without the level the form opened blank on an
--     item that had one, and saving then wrote the blank back — an item given its own level on
--     Monday lost it the next time anybody corrected its name. A form that quietly discards a
--     setting it never showed is worse than one that cannot set it at all.
--
--   · `search_products` is the stock list under a search term. A shop searching "malta" got cards
--     that could not mark themselves low, so whether an item looked low depended on how it had
--     been found.
--
-- Same expression as 0172 wherever a row is DISPLAYED: the item's own level where it has one, the
-- shop's otherwise, null when neither is set.
--
-- `get_product` returns TWO figures, because the form and the card ask different questions. A card
-- asks "what level is this item judged by" and wants the resolved one. A form asks "does this item
-- have an exception" and must have the item's own, unresolved — given the resolved figure it would
-- show the shop's general level in a box meaning "this one is different", and saving would turn
-- every item it was opened on into an exception that happens to match. One name, one meaning: the
-- resolved one stays `low_stock_level` everywhere, and the exception is `own_low_stock_level`.
-- =====================================================================================

-- Dropped rather than replaced: the return type gains a column, and `create or replace` cannot
-- change a function's OUT parameters.
drop function if exists public.get_product(uuid);

CREATE OR REPLACE FUNCTION public.get_product(p_product_id uuid)
 RETURNS TABLE(id uuid, name text, sku text, barcode text, base_unit text, category_id uuid, category_name text, avg_unit_cost unit_cost, cost_is_estimated boolean, on_hand qty, pack_id uuid, pack_name text, pack_qty qty, list_price money_amt, low_stock_level numeric, own_low_stock_level numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p.id, p.name, p.sku, p.barcode, p.base_unit, p.category_id, c.name,
         p.avg_unit_cost, p.cost_is_estimated,
         coalesce((select sum(m.qty_delta) from public.stock_movements m
                    where m.product_id = p.id), 0)::qty,
         pk.id, pk.name, pk.base_unit_qty, pr.price,
         /*
          * What this item is JUDGED by, for anything that draws a card from this row.
          */
         coalesce(p.low_stock_threshold, ss.low_stock_threshold),
         /*
          * And what this item was actually GIVEN, which is what the edit form shows. Null here
          * means "follows the shop", and the form shows an empty box for it — so opening the form
          * and saving it without touching this leaves the item exactly as it was. Handing the form
          * the resolved figure instead would fill that box with the shop's level and quietly pin
          * every edited item to today's general rule.
          */
         p.low_stock_threshold
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
  where p.id = p_product_id
    -- The membership check is the whole security boundary here: SECURITY DEFINER means the
    -- function runs as its owner, so without this any signed-in user could read any shop's costs
    -- by guessing a uuid. `list_products` makes the same check on the store it is given.
    and public.is_store_member(p.store_id);
$function$;

grant execute on function public.get_product(uuid) to authenticated;


drop function if exists public.search_products(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.search_products(p_store_id uuid, p_query text DEFAULT NULL::text, p_limit integer DEFAULT 50)
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
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$function$;

grant execute on function public.search_products(uuid, text, integer) to authenticated;
