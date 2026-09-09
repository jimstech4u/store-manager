-- 0111 — The dispenser water gets a product, so its containers can be owed in a shape
--
-- After 0110 every old empties row was accounted for except 102 of them: 306 containers in a pool
-- called "Dispenser water bottle" that names no product at all. They are real — genuine customers,
-- dated 22–26 August — and they are the "2 dispenser bottle" from the shop's own worked example.
--
-- They could not carry over because the new ledger owes containers in a PRODUCT'S SHAPE, and there
-- is no dispenser-water product in this catalogue. The pool was created on its own, which is the
-- thing the pool model allowed and the shape model does not: a container with nothing to be a
-- container OF.
--
-- So the product is created from what the pool already says. This is a real addition to the shop's
-- catalogue and is meant to be seen: it appears in the stock list like any other item, with nothing
-- on the shelf, and can be renamed or archived on the product form. The alternative was leaving 306
-- containers owed by name only, reachable from no screen.

do $make$
declare
  v_store   uuid;
  v_bottle  uuid;
  v_product uuid;
  v_unit    uuid;
  v_pool    uuid;
  v_group   uuid;
begin
  -- The pool, and the shop it belongs to. Nothing happens if the shop has since dealt with it.
  select ec.id, ec.store_id into v_pool, v_store
    from public.empties_categories ec
    join public.stores s on s.id = ec.store_id
   where lower(ec.name) like '%dispenser%'
     and not exists (
       select 1 from public.product_returnables pr where pr.empties_category_id = ec.id
     )
   limit 1;

  if v_pool is null then
    raise notice 'no unlinked dispenser pool — nothing to do';
    return;
  end if;

  -- The shop's own word for one of them. Reused rather than invented: "Bottle" is already what
  -- every beer here comes back in, and a second one would split the picker.
  select id into v_bottle
    from public.store_units
   where store_id = v_store and lower(name) = 'bottle' and coalesce(status, 'active') = 'active'
   limit 1;

  if v_bottle is null then
    insert into public.store_units (store_id, name, plural)
    values (v_store, 'Bottle', 'Bottles')
    returning id into v_bottle;
  end if;

  select id into v_product
    from public.products
   where store_id = v_store and lower(name) = 'dispenser water'
   limit 1;

  if v_product is null then
    /*
     * `piece`, because `products.base_unit` is a FIXED vocabulary — a foreign key to `units`,
     * whose seven codes are piece/kg/g/litre/cl/metre/yard. It is not the shop's own word for a
     * bottle; that is `store_units`, and it is what the SHAPE carries. Passing 'bottle' here is
     * rejected outright, which is the constraint doing its job.
     */
    insert into public.products (store_id, name, base_unit, status)
    values (v_store, 'Dispenser water', 'piece', 'active')
    returning id into v_product;
  end if;

  /*
   * ONE SHAPE, MEASURED AGAINST NOTHING — the bottle IS the thing here.
   *
   * Sold in it, counted in it, and it comes back: that is what the pool was recording. `is_deposit`
   * is left false, because whether this shop holds money against a dispenser bottle is the shop's
   * answer and not one to invent from a migration.
   */
  select id into v_unit
    from public.product_units
   where product_id = v_product and store_unit_id = v_bottle
   limit 1;

  if v_unit is null then
    insert into public.product_units (product_id, store_unit_id, base_qty, is_bought, is_sold,
                                      is_counted, is_returnable, is_deposit, whole_digit)
    values (v_product, v_bottle, 1, true, true, true, true, false, true)
    returning id into v_unit;
  end if;

  -- The pool now names the product and the shape, which is what 0110 reads.
  insert into public.product_returnables (product_id, empties_category_id, product_unit_id)
  values (v_product, v_pool, v_unit)
  on conflict do nothing;

  /*
   * A GROUP, so it rolls up on a receipt the way NBL does.
   *
   * "Cway" is already seeded and is a water maker, but guessing that this shop's dispenser water is
   * Cway would be inventing a fact. It goes in a group named for what it is, which the shop can
   * rename or re-point on the product form.
   */
  select id into v_group
    from public.product_categories
   where store_id = v_store and lower(name) = 'dispenser water'
   limit 1;

  if v_group is null then
    insert into public.product_categories (store_id, name)
    values (v_store, 'Dispenser water')
    returning id into v_group;
  end if;

  insert into public.product_category_links (product_id, category_id)
  values (v_product, v_group)
  on conflict do nothing;

  raise notice 'dispenser water: product %, shape %, linked to pool %', v_product, v_unit, v_pool;
end;
$make$;
