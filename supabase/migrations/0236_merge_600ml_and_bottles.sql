-- 0236 - The Bigi 600mL, and the Pepsi bottles, as the shop sells them
--
-- "Bigi Cola | Apple | Tropical | Orange | Lemon (500ml) is not 500ml but 600ml, which merges the
-- Bigi Bitter Lemon by deleting it ... Pepsi Bottle (50cl) = Pepsi | 7up | Mirinda | Teem | Komando
-- Bottle (50cl), its stock is what Pepsi Bottle 50cl has. Pepsi Bottle (35cl) = ... Komando Bottle
-- (35cl), the same as the 7up 35cl and what it has as stock, plus the Komando bottle's stock."
--
--   Bigi … PET (500mL, new and empty) + Bigi Bitter Lemon PET (600mL) -> Bigi Cola | Apple | Tropical | Orange | Lemon PET (600mL)
--   7up Bottle (35cl) + Supa Komando Bottle (25cl)                   -> Pepsi | 7up | Mirinda | Teem | Komando Bottle (35cl)
--   Pepsi Bottle (50cl)                         renamed              -> Pepsi | 7up | Mirinda | Teem | Komando Bottle (50cl)
--
-- As 0233: the kept item takes the others' ledger, receipt and tab lines, lots, empties and groups;
-- its balances are recomputed; the others are deleted. A shape of an absorbed item must have a twin
-- on the kept item only if something USES it — Supa Komando's crate of 12 was never sold or owed, so
-- its 425 bottles simply join the 7up bottles, counted in the kept item's crates of 24.

do $merge$
declare
  v_store constant uuid := '7138327c-c81c-4486-a97c-92207b48b64e';
  v_groups constant jsonb := '[
    {"keep": "Bigi Cola | Apple | Tropical | Orange | Lemon PET (500mL)", "absorb": ["Bigi Bitter Lemon PET (600mL)"],
     "name": "Bigi Cola | Apple | Tropical | Orange | Lemon PET (600mL)"},
    {"keep": "7up Bottle (35cl)", "absorb": ["Supa Komando Bottle (25cl)"],
     "name": "Pepsi | 7up | Mirinda | Teem | Komando Bottle (35cl)"},
    {"keep": "Pepsi Bottle (50cl)", "absorb": [],
     "name": "Pepsi | 7up | Mirinda | Teem | Komando Bottle (50cl)"}
  ]';
  v_group   jsonb;
  v_keep    uuid;
  v_other   uuid;
  v_name    text;
  v_expect  numeric;
  v_after   numeric;
  v_unmapped int;
begin
  alter table public.stock_movements disable trigger no_mutation;

  for v_group in select * from jsonb_array_elements(v_groups) loop
    select id into v_keep from public.products where store_id = v_store and name = v_group ->> 'keep';
    if v_keep is null then
      raise exception '% is not in the shop; stopping', v_group ->> 'keep';
    end if;

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

      -- A shape something USES must have a twin on the kept item: same unit, same size.
      select count(*) into v_unmapped
        from public.product_units o
       where o.product_id = v_other
         and not exists (select 1 from public.product_units k
                          where k.product_id = v_keep and k.store_unit_id = o.store_unit_id
                            and k.base_qty = o.base_qty)
         and (exists (select 1 from public.sale_lines where sale_unit_id = o.id)
              or exists (select 1 from public.draft_order_lines where sale_unit_id = o.id)
              or exists (select 1 from public.customer_empties where product_unit_id = o.id)
              or exists (select 1 from public.supplier_empties where product_unit_id = o.id)
              or exists (select 1 from public.empties_counts where product_unit_id = o.id)
              or exists (select 1 from public.product_returnables where product_unit_id = o.id));
      if v_unmapped > 0 then
        raise exception '% has a shape in use that the kept item does not have; stopping', v_name;
      end if;

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

      -- Empties owed or held, and the item's returnable records, on the twin shape.
      update public.customer_empties ce
         set product_id = v_keep,
             product_unit_id = (select k.id from public.product_units o
                                  join public.product_units k on k.product_id = v_keep
                                   and k.store_unit_id = o.store_unit_id and k.base_qty = o.base_qty
                                 where o.id = ce.product_unit_id)
       where ce.product_id = v_other;
      update public.supplier_empties se
         set product_id = v_keep,
             product_unit_id = (select k.id from public.product_units o
                                  join public.product_units k on k.product_id = v_keep
                                   and k.store_unit_id = o.store_unit_id and k.base_qty = o.base_qty
                                 where o.id = se.product_unit_id)
       where se.product_id = v_other;
      delete from public.product_returnables where product_id = v_other;

      update public.stock_movements set product_id = v_keep where product_id = v_other;
      update public.stock_layers    set product_id = v_keep where product_id = v_other;

      insert into public.product_category_links (product_id, category_id)
      select v_keep, l.category_id from public.product_category_links l
       where l.product_id = v_other
         and not exists (select 1 from public.product_category_links k
                          where k.product_id = v_keep and k.category_id = l.category_id);
      delete from public.product_category_links where product_id = v_other;

      delete from public.stock_periods where product_id = v_other;
      delete from public.product_units where product_id = v_other and defined_against_id is not null;
      delete from public.product_units where product_id = v_other;
      delete from public.products where id = v_other;
    end loop;

    update public.stock_movements m
       set balance_before = r.running - m.qty_delta,
           balance_after  = r.running
      from (select id, sum(qty_delta) over (order by occurred_at, created_at, id) as running
              from public.stock_movements where product_id = v_keep) r
     where m.id = r.id;

    if jsonb_array_length(v_group -> 'absorb') > 0 then
      delete from public.stock_periods where product_id = v_keep;
      perform public.ensure_open_period(v_keep);
    end if;

    select coalesce(sum(qty_delta), 0) into v_after from public.stock_movements where product_id = v_keep;
    if v_after <> v_expect then
      raise exception '% would hold % but its members held %; stopping', v_group ->> 'name', v_after, v_expect;
    end if;

    update public.products set name = v_group ->> 'name' where id = v_keep;
  end loop;

  alter table public.stock_movements enable trigger no_mutation;
end;
$merge$;

notify pgrst, 'reload schema';
