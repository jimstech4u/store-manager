-- 0184 — A low-stock level remembers the shape it was said in
--
-- The level is kept in base units, and that is right: the shelf is counted in base units and so is
-- every reader that compares against it — `low_stock_items`, the stock card, the warning on a
-- product row. Nothing about that changes here.
--
-- What was missing is the shop's own wording. A distributor who counts crates typed 10, the form
-- multiplied by the twelve in a crate and stored 120, and nothing recorded that "crates" was the
-- word. Reopening the form, it re-expressed 120 in whichever shape happened to sort first — so a
-- shop that had set "10 crates" came back to "120 pieces", or to 10 of something else entirely if
-- the sort order differed. The number was never wrong; the sentence was, and a setting a shop
-- cannot read back is a setting it stops trusting.
--
-- So: one column holding the chosen shape, a form of three things — the shape, the amount, and a
-- save — and the level still stored in base units underneath.
--
-- ON THE OVERLOAD TRAP (0059, 0170, 0177, 0182): `p_unit_id` changes the argument count of
-- `set_product_low_stock`, so `create or replace` ADDS a sibling rather than replacing. The
-- two-argument one is dropped explicitly below, and the signatures are listed after applying.
-- `get_product` gains a return column, which Postgres refuses outright without a drop first.

-- ─── 1. The column ──────────────────────────────────────────────────────────────────

alter table public.products
  add column if not exists low_stock_unit_id uuid
    references public.product_units (id) on delete set null;

comment on column public.products.low_stock_unit_id is
  'Which shape `low_stock_threshold` was typed in, for reading it back. A LABEL, not a unit of '
  'storage: the threshold itself is in base units and every reader compares against the shelf in '
  'base units. Null means nobody chose one, and the form falls back to the item''s first shape.';

-- ─── 2. Reading it back ─────────────────────────────────────────────────────────────

drop function if exists public.get_product(uuid);

CREATE OR REPLACE FUNCTION public.get_product(p_product_id uuid)
 RETURNS TABLE(id uuid, name text, sku text, barcode text, base_unit text, category_id uuid, category_name text, avg_unit_cost unit_cost, cost_is_estimated boolean, on_hand qty, pack_id uuid, pack_name text, pack_qty qty, list_price money_amt, low_stock_level numeric, own_low_stock_level numeric, own_low_stock_unit_id uuid)
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
         p.low_stock_threshold,
         /*
          * AND THE SHAPE IT WAS SAID IN.
          *
          * The level itself is kept in base units and always was — the stock card, `low_stock_items`
          * and every warning compare against the shelf, which is counted in base units. What was
          * missing is the shop's own WORDING of it. A distributor who thinks in crates typed 10,
          * the form multiplied by twelve and stored 120, and on reopening had no idea which shape
          * the 120 had come from — so it re-expressed it in whichever shape happened to sort first
          * and showed a number the shop had never typed.
          *
          * Null means nobody chose, which is what every item says until somebody sets one.
          */
         p.low_stock_unit_id
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

-- ─── 3. And setting it ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_product_low_stock(p_product_id uuid, p_level numeric, p_unit_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_store uuid;
begin
  select store_id into v_store from public.products where id = p_product_id;
  if v_store is null then
    raise exception 'No such item';
  end if;
  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'Only somebody who manages products can change this' using errcode = '42501';
  end if;
  if p_level is not null and p_level < 0 then
    raise exception 'A level cannot be less than none';
  end if;

  /*
   * The shape is checked against the product, not taken on trust.
   *
   * It is only a label for the form to read the level back in, so a wrong one cannot corrupt a
   * warning — but it could make an item claim to warn at "10 crates" when the crate belongs to
   * another product entirely, and a level nobody can read is a level nobody maintains.
   */
  if p_unit_id is not null
     and not exists (select 1 from public.product_units pu
                      where pu.id = p_unit_id and pu.product_id = p_product_id) then
    raise exception 'that shape does not belong to this item' using errcode = '23514';
  end if;

  update public.products
     set low_stock_threshold = p_level,
         -- Clearing the level clears the shape with it: "follows the shop" is not said in crates.
         low_stock_unit_id   = case when p_level is null then null else p_unit_id end
   where id = p_product_id;
end;
$function$;

drop function if exists public.set_product_low_stock(uuid, numeric);

grant execute on function public.set_product_low_stock(uuid, numeric, uuid) to authenticated;
