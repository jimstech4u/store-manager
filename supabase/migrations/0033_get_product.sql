-- =====================================================================================
-- 0033 — One product, by id
--
-- `list_products` already computes everything a product screen needs: the moving-average cost,
-- what is on hand from the movement ledger, the display pack and its price. A detail page that
-- recomputed any of that in the client would be a second definition of the same number, and the
-- two would drift the first time either changed.
--
-- So this is the same select with the cursor arithmetic removed and `barcode` added — the one
-- field a list has no room for and a detail page must show.
-- =====================================================================================

create or replace function public.get_product(p_product_id uuid)
returns table (
  id                uuid,
  name              text,
  sku               text,
  barcode           text,
  base_unit         text,
  category_id       uuid,
  category_name     text,
  avg_unit_cost     unit_cost,
  cost_is_estimated boolean,
  on_hand           qty,
  pack_id           uuid,
  pack_name         text,
  pack_qty          qty,
  list_price        money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.name, p.sku, p.barcode, p.base_unit, p.category_id, c.name,
         p.avg_unit_cost, p.cost_is_estimated,
         coalesce((select sum(m.qty_delta) from public.stock_movements m
                    where m.product_id = p.id), 0)::qty,
         pk.id, pk.name, pk.base_unit_qty, pr.price
  from public.products p
  left join public.product_categories c on c.id = p.category_id
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
$$;

revoke all on function public.get_product(uuid) from public;
grant execute on function public.get_product(uuid) to authenticated;
