-- 0202 — The low-stock setter stops writing a column that is gone
--
-- Reported from the counter, adding a product: "Not saved — column low_stock_unit_id of relation
-- products does not exist". The item could not be created at all.
--
-- My regression, in two steps. 0191 replaced the single low-stock level with one level per shape,
-- in `product_low_stock_levels`. 0192 then dropped `products.low_stock_unit_id`, which 0184 had
-- added to remember which shape the single level was typed in — and I updated `get_product`,
-- which READS it, while missing `set_product_low_stock`, which WRITES it.
--
-- The product form calls that setter on every save, so the failure was not confined to the
-- low-stock box: it took the whole form down, on new products and edits alike. A dropped column
-- is only safe once nothing writes it either, and checking only the readers is checking half.
--
-- The setter now does what 0191 intended: the threshold in base units stays on `products` for
-- every reader that still compares against the shelf, and the SHAPE the shop typed it in becomes
-- a row in `product_low_stock_levels` — the same row `set_shape_low_stock` writes, so the two
-- doors lead to one place.

create or replace function public.set_product_low_stock(
  p_product_id uuid,
  p_level numeric,
  p_unit_id uuid DEFAULT NULL::uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store uuid;
  v_per   numeric;
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

  -- The shape is checked against the product, as it was before. A shape belonging to something
  -- else would make the item claim to warn at "10 crates" of another product's crate.
  if p_unit_id is not null
     and not exists (select 1 from public.product_units pu
                      where pu.id = p_unit_id and pu.product_id = p_product_id) then
    raise exception 'that shape does not belong to this item' using errcode = '23514';
  end if;

  -- IN BASE UNITS, which is what the shelf is counted in and what every warning compares against.
  update public.products set low_stock_threshold = p_level where id = p_product_id;

  /*
   * AND THE SHAPE IT WAS SAID IN, as a row rather than a column (0191).
   *
   * `product_low_stock_levels.level` is counted in THAT SHAPE, so the base-unit figure is divided
   * back down by what one of them is worth. Clearing the level clears the row with it: "follows
   * the shop" is not said in crates.
   */
  if p_unit_id is null then
    return;
  end if;

  if p_level is null then
    delete from public.product_low_stock_levels
     where product_id = p_product_id and product_unit_id = p_unit_id;
    return;
  end if;

  select nullif(base_qty, 0) into v_per from public.product_units where id = p_unit_id;

  insert into public.product_low_stock_levels (product_id, product_unit_id, level)
  values (p_product_id, p_unit_id, p_level / coalesce(v_per, 1))
  on conflict (product_id, product_unit_id) do update set level = excluded.level;
end;
$$;

grant execute on function public.set_product_low_stock(uuid, numeric, uuid) to authenticated;

-- PostgREST caches the schema, and a dropped column lingers in that cache until it is told —
-- which is its own source of "relationship not found" errors after a migration.
notify pgrst, 'reload schema';
