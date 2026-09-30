-- 0233 - Items sold together become one item, their histories merged
--
-- "they were entered individually but that is bad because they are sold at a small price and can be
-- sold together ... merge the amount of each initial, and then leave the history, and it balances,
-- because the sold history is true — the items have gone physically." The shop chose to REWRITE the
-- history into one item, so each merged item reads as if it had always been one.
--
--   Bigi Cola PET (350mL) + Bigi Apple + Bigi Tropical   -> Bigi Cola | Apple | Tropical | Orange | Lemon PET (350mL)
--   Pepsi PET (60cl) + 7up PET (60cl)                     -> Pepsi | 7up | Mirinda | Teem PET (60cl)
--   Coca-Cola Big PET (60cl) + Fanta Big PET (60cl)       -> Coke | Fanta | Sprite Big PET (60cl)
--   Coca-Cola Small PET (50cl) + Fanta Small PET (50cl) + Sprite PET (50cl)
--                                                         -> Coke | Fanta | Sprite Small PET (50cl)
--   Coca-Cola Big Bottle (50cl)          renamed          -> Coke | Fanta | Sprite Big Bottle (50cl)
--   Coca-Cola Small Bottle Black (35cl)  renamed          -> Coke | Fanta | Sprite Small Bottle Black (35cl)
--   Coca-Cola Small Bottle Red (35cl)    renamed          -> Coke | Fanta | Sprite Small Bottle Red (35cl)
--   new, empty                                            -> Bigi Cola | Apple | Tropical | Orange | Lemon PET (500mL)
--
-- For each merge, the item that is KEPT takes everything of the others: openings, sales, receipt
-- lines, tab lines and lots; their shapes map to its own shapes of the same name and size (all are
-- Pack of 12 / Piece at the same price). The kept item's running balances are recomputed in order.
-- Count periods of the merged items were opening counts only (the shop removed 29 Sep's counts), so
-- they are replaced by one open period starting from the combined stock. The emptied items are then
-- DELETED; a foreign key still pointing at one stops the whole migration.
--
-- The ledger's no-edit guard is lifted for the re-pointing only, at the shop's explicit choice, and
-- restored in the same transaction.

do $merge$
declare
  v_store constant uuid := '7138327c-c81c-4486-a97c-92207b48b64e';
  v_groups constant jsonb := '[
    {"keep": "Bigi Cola PET (350mL)", "absorb": ["Bigi Apple PET (350mL)", "Bigi Tropical PET (350mL)"],
     "name": "Bigi Cola | Apple | Tropical | Orange | Lemon PET (350mL)"},
    {"keep": "Pepsi PET (60cl)", "absorb": ["7up PET (60cl)"],
     "name": "Pepsi | 7up | Mirinda | Teem PET (60cl)"},
    {"keep": "Coca-Cola Big PET (60cl)", "absorb": ["Fanta Big PET (60cl)"],
     "name": "Coke | Fanta | Sprite Big PET (60cl)"},
    {"keep": "Coca-Cola Small PET (50cl)", "absorb": ["Fanta Small PET (50cl)", "Sprite PET (50cl)"],
     "name": "Coke | Fanta | Sprite Small PET (50cl)"},
    {"keep": "Coca-Cola Big Bottle (50cl)", "absorb": [],
     "name": "Coke | Fanta | Sprite Big Bottle (50cl)"},
    {"keep": "Coca-Cola Small Bottle Black (35cl)", "absorb": [],
     "name": "Coke | Fanta | Sprite Small Bottle Black (35cl)"},
    {"keep": "Coca-Cola Small Bottle Red (35cl)", "absorb": [],
     "name": "Coke | Fanta | Sprite Small Bottle Red (35cl)"}
  ]';
  v_group   jsonb;
  v_keep    uuid;
  v_other   uuid;
  v_name    text;
  v_before  numeric;
  v_expect  numeric;
  v_after   numeric;
  v_unmapped int;
begin
  alter table public.stock_movements disable trigger no_mutation;

  for v_group in select * from jsonb_array_elements(v_groups) loop
    select id into v_keep from public.products
     where store_id = v_store and name = v_group ->> 'keep';
    if v_keep is null then
      raise exception '% is not in the shop; stopping', v_group ->> 'keep';
    end if;

    -- What the merged item must hold: every member's stock, added up.
    select coalesce(sum(m.qty_delta), 0) into v_expect
      from public.stock_movements m
      join public.products p on p.id = m.product_id
     where p.store_id = v_store
       and p.name in (select v_group ->> 'keep' union all select jsonb_array_elements_text(v_group -> 'absorb'));

    for v_name in select jsonb_array_elements_text(v_group -> 'absorb') loop
      select id into v_other from public.products where store_id = v_store and name = v_name;
      if v_other is null then
        raise exception '% is not in the shop; stopping', v_name;
      end if;

      -- Every shape of the absorbed item has a twin on the kept item: same unit, same size.
      select count(*) into v_unmapped
        from public.product_units o
       where o.product_id = v_other
         and not exists (select 1 from public.product_units k
                          where k.product_id = v_keep and k.store_unit_id = o.store_unit_id
                            and k.base_qty = o.base_qty);
      if v_unmapped > 0 then
        raise exception '% has a shape the kept item does not; stopping', v_name;
      end if;

      -- Receipt lines and tab lines: to the kept item, on its twin shape.
      update public.sale_lines sl
         set product_id = v_keep,
             sale_unit_id = (select k.id from public.product_units o
                               join public.product_units k on k.product_id = v_keep
                                and k.store_unit_id = o.store_unit_id and k.base_qty = o.base_qty
                              where o.id = sl.sale_unit_id)
       where sl.product_id = v_other;

      update public.draft_order_lines dl
         set product_id = v_keep,
             sale_unit_id = (select k.id from public.product_units o
                               join public.product_units k on k.product_id = v_keep
                                and k.store_unit_id = o.store_unit_id and k.base_qty = o.base_qty
                              where o.id = dl.sale_unit_id)
       where dl.product_id = v_other;

      -- The ledger and the lots.
      update public.stock_movements set product_id = v_keep where product_id = v_other;
      update public.stock_layers    set product_id = v_keep where product_id = v_other;

      -- Its groups come along.
      insert into public.product_category_links (product_id, category_id)
      select v_keep, l.category_id from public.product_category_links l
       where l.product_id = v_other
         and not exists (select 1 from public.product_category_links k
                          where k.product_id = v_keep and k.category_id = l.category_id);
      delete from public.product_category_links where product_id = v_other;

      -- Its count periods were opening counts; the kept item gets one fresh period below.
      delete from public.stock_periods where product_id = v_other;

      -- Its shapes (the ones defined against another first), then the item itself.
      delete from public.product_units where product_id = v_other and defined_against_id is not null;
      delete from public.product_units where product_id = v_other;
      delete from public.products where id = v_other;
    end loop;

    -- The kept item's running balances, recomputed in order over the merged ledger.
    update public.stock_movements m
       set balance_before = r.running - m.qty_delta,
           balance_after  = r.running
      from (select id, sum(qty_delta) over (order by occurred_at, created_at, id) as running
              from public.stock_movements where product_id = v_keep) r
     where m.id = r.id;

    -- One count period, from the combined stock.
    if jsonb_array_length(v_group -> 'absorb') > 0 then
      delete from public.stock_periods where product_id = v_keep;
      perform public.ensure_open_period(v_keep);
    end if;

    select coalesce(sum(qty_delta), 0) into v_after from public.stock_movements where product_id = v_keep;
    if v_after <> v_expect then
      raise exception '% would hold % but its members held %; stopping', v_group ->> 'name', v_after, v_expect;
    end if;

    update public.products set name = v_group ->> 'name' where id = v_keep;
    raise notice '%: % pieces', v_group ->> 'name', v_after;
  end loop;

  alter table public.stock_movements enable trigger no_mutation;

  -- ── The 500mL Bigi, new and empty, shaped like the 350mL ────────────────────────────
  declare
    v_model uuid;
    v_new   uuid;
    v_piece uuid;
    v_pack_unit uuid;
    v_piece_unit uuid;
  begin
    select id into v_model from public.products
     where store_id = v_store and name = 'Bigi Cola | Apple | Tropical | Orange | Lemon PET (350mL)';
    if not exists (select 1 from public.products
                    where store_id = v_store and name = 'Bigi Cola | Apple | Tropical | Orange | Lemon PET (500mL)') then
      insert into public.products (store_id, name, base_unit, status, category_id)
      select store_id, 'Bigi Cola | Apple | Tropical | Orange | Lemon PET (500mL)', base_unit, 'active', category_id
        from public.products where id = v_model
      returning id into v_new;

      select store_unit_id into v_piece_unit from public.product_units
       where product_id = v_model and defined_against_id is null;
      select store_unit_id into v_pack_unit from public.product_units
       where product_id = v_model and defined_against_id is not null;

      insert into public.product_units (product_id, store_unit_id, base_qty, is_bought, is_sold, sell_price,
                                        is_returnable, whole_digit, allow_quarter, allow_half,
                                        allow_three_quarter, sort_order, is_counted, is_deposit)
      values (v_new, v_piece_unit, 1, false, false, null, false, true, false, false, false, 1, true, false)
      returning id into v_piece;

      -- A Pack of 12, bought and sold; no price yet — the till asks for one before it sells.
      insert into public.product_units (product_id, store_unit_id, base_qty, is_bought, is_sold, sell_price,
                                        is_returnable, whole_digit, allow_quarter, allow_half,
                                        allow_three_quarter, sort_order, is_counted, is_deposit,
                                        defined_against_id, defined_qty)
      values (v_new, v_pack_unit, 12, true, true, null, false, true, false, false, false, 0, true, false,
              v_piece, 12);

      insert into public.product_category_links (product_id, category_id)
      select v_new, category_id from public.product_category_links where product_id = v_model;
    end if;
  end;
end;
$merge$;

notify pgrst, 'reload schema';
