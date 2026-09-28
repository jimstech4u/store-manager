-- 0192 — The single low-stock shape column goes, now that there are rows
--
-- 0184 added `products.low_stock_unit_id` to remember which shape the one level had been TYPED
-- in. 0191 replaced that with a level per shape, so the column has no readers left.
--
-- It is not harmless to leave. A second foreign key from `products` to `product_units` means
-- PostgREST can no longer embed one in the other — "more than one relationship was found" — so
-- any `products` query that wants its shapes now fails until somebody adds a disambiguation hint.
-- Nothing in the app does that today, which is exactly why this is the moment: the cost of the
-- column is a trap set for whoever writes that query next.
--
-- `low_stock_threshold` stays. It is a plain numeric with no relationship, it sets no trap, and
-- 0191's backfill read from it — leaving it is a way back if that backfill turns out to have
-- misread anything.

-- A return column is being removed, which Postgres refuses on a replace.
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

alter table public.products drop column if exists low_stock_unit_id;
