-- 0230 - Every can takes Malta Guinness Can's shape: a Can of 24 Pieces
--
-- "check the shape of malta guinness can, now update the remaining can products to take the exact
-- shape data ... just add the shapes ... can is can and pieces."
--
-- Malta Guinness Can (0222): the base is a Piece — counted, neither bought nor sold, never halved —
-- and the Can is defined as 24 Pieces: bought, sold, counted, priced per Can, sold in halves. The
-- shop's thirteen other cans have a single "Can" shape worth one base unit. This gives each the same
-- two shapes. Prices stay as they are (per Can).
--
-- SHAPES ONLY, as the shop chose: no stock row is touched. Stock is held in the base unit, so an
-- item that had 21 on its shelf now reads 21 pieces until it is counted again. Where a Can is
-- already defined, or an item has more than its one Can shape, this stops rather than guess.

do $cans$
declare
  v_store  constant uuid := '7138327c-c81c-4486-a97c-92207b48b64e';
  v_names  constant text[] := array[
    'Amstel Malta Can (330mL)',
    'Chivita Active Zest Can (330mL)',
    'Dudu Yoghurt Can (500mL)',
    'Fayrouz Can (330mL)',
    'Fearless Energy Drink Can (500mL)',
    'Goldberg Can (500mL)',
    'Guinness Can (440mL)',
    'Heineken Original Can (33cl)',
    'Lite Can (599mL)',
    'Maltina Classic Can (33cl)',
    'Schweppes Can (25cl)',
    'Smirnoff Ice Can (440mL)',
    'Trophy Can (500mL)'
  ];
  v_piece_unit uuid;
  v_name    text;
  v_product uuid;
  v_can     uuid;
  v_piece   uuid;
  v_done    int := 0;
begin
  select id into v_piece_unit
    from public.store_units
   where store_id = v_store and name = 'Piece' and status = 'active';
  if v_piece_unit is null then
    raise exception 'The shop has no Piece unit; not adding the shapes';
  end if;

  foreach v_name in array v_names loop
    select id into v_product from public.products where store_id = v_store and name = v_name;
    if v_product is null then
      raise exception '% is not in the shop; stopping', v_name;
    end if;

    if (select count(*) from public.product_units where product_id = v_product) <> 1 then
      raise exception '% does not have exactly one shape; stopping', v_name;
    end if;
    select pu.id into v_can
      from public.product_units pu
      join public.store_units su on su.id = pu.store_unit_id
     where pu.product_id = v_product and su.name = 'Can'
       and pu.base_qty = 1 and pu.defined_against_id is null;
    if v_can is null then
      raise exception '%: its one shape is not an undefined Can of one; stopping', v_name;
    end if;

    -- The Piece: the base, counted, neither bought nor sold, never halved — Malta's row.
    insert into public.product_units
      (product_id, store_unit_id, base_qty, is_bought, is_sold, sell_price, is_returnable,
       whole_digit, allow_quarter, allow_half, allow_three_quarter, sort_order, is_counted, is_deposit)
    values
      (v_product, v_piece_unit, 1, false, false, null, false, true, false, false, false, 1, true, false)
    returning id into v_piece;

    -- The Can is 24 Pieces; the trigger derives base_qty = 24 from this.
    update public.product_units
       set defined_against_id = v_piece, defined_qty = 24, sort_order = 0
     where id = v_can;

    v_done := v_done + 1;
  end loop;

  raise notice 'Gave % cans the Can-of-24 and Piece shapes', v_done;
end;
$cans$;

notify pgrst, 'reload schema';
